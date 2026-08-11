import { GovernorLimitError } from '@chimera/errors';
import { capabilityMatrix, type ModelCapabilities } from '@chimera/providers';
import { BudgetLedger, costOf, type BudgetPolicy } from './budget.ts';
import { LimitTracker, NO_LIMITS, type LimitPolicy } from './limits.ts';
import {
  DEFAULT_STALL_POLICY,
  StallDetector,
  toolSignature,
  type IterationOutcome,
  type StallPolicy,
} from './stallDetector.ts';
import type {
  Authorized,
  Denied,
  DenialCode,
  ModelCallAuthorization,
  ModelCallRequest,
  RequiredCapability,
  ToolCallAuthorization,
  ToolCallRequest,
} from './types.ts';

// The one door. CLAUDE.md: "Every model call and every tool call goes through
// the Governor. There is no bypass path."
//
// M2-1 landed this file's interface with permissive internals so the agent
// runtime could be built against its final shape. M3-1 replaces the internals
// and nothing else: the two `authorize*` signatures, the result shape, and
// every call site in `agentLoop.ts` are byte-identical to what M2 shipped.
//
// The Governor only ever *reads* limits. Budgets come from the workflow and the
// role; nothing here invents a number and then enforces it as if the user had
// agreed to it.

export type GovernorMode = 'permissive' | 'enforcing';

export interface GovernorPolicy {
  budget?: BudgetPolicy;
  limits?: LimitPolicy;
  /** F4.3. Null disables stall detection entirely, which a dry run wants. */
  stall?: StallPolicy | null;
  /** Injected for tests and for the mock provider's synthetic models. */
  capabilitiesFor?: (model: string) => ModelCapabilities;
  /** Injected so a wall-clock limit is testable without sleeping. */
  now?: () => number;
}

function allow<TRequest>(request: TRequest, notes: readonly string[] = []): Authorized<TRequest> {
  return { decision: 'allow', request, notes };
}

export function deny(
  code: DenialCode,
  message: string,
  details: Record<string, unknown> = {},
): Denied {
  return { decision: 'deny', code, message, details };
}

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

export class Governor {
  readonly mode: GovernorMode;
  private readonly ledger: BudgetLedger;
  private readonly tracker: LimitTracker;
  private readonly capabilitiesFor: (model: string) => ModelCapabilities;
  private readonly stallDetector: StallDetector | null;

  constructor(mode: GovernorMode = 'permissive', policy: GovernorPolicy = {}) {
    this.mode = mode;
    this.ledger = new BudgetLedger(policy.budget ?? {});
    this.tracker = new LimitTracker(policy.limits ?? NO_LIMITS, policy.now);
    this.capabilitiesFor = policy.capabilitiesFor ?? ((model) => capabilityMatrix.get(model));
    this.stallDetector =
      policy.stall === null ? null : new StallDetector(policy.stall ?? DEFAULT_STALL_POLICY);
  }

  /**
   * Reports what an iteration actually produced.
   *
   * The Governor cannot detect a stall from requests alone — a stall is a
   * property of the *answers*, and `authorizeModelCall` never sees one. This is
   * the one addition to the public interface M2-1 froze, and it is deliberately
   * not part of `authorize*`: those two signatures, and the result shape, are
   * unchanged, so the "no bypass path" guarantee reads exactly as it did.
   *
   * Reading the answers out of the `traces` table instead was the alternative.
   * It would couple the Governor to SQLite for something it can hold in memory
   * for the length of a run, and make stall detection untestable without a
   * database.
   */
  recordOutcome(outcome: IterationOutcome): void {
    this.stallDetector?.record(outcome);
  }

  /** Drops a node's stall history. Called when the node finishes. */
  forgetNode(nodeId: string): void {
    this.stallDetector?.forget(nodeId);
  }

  /** What has been spent so far. Read by M3-4's meter and by the run trace. */
  spend(): ReturnType<BudgetLedger['snapshot']> {
    return this.ledger.snapshot();
  }

  get steps(): number {
    return this.tracker.stepCount;
  }

  /**
   * Authorizes one provider call.
   *
   * Checks in the order docs/ARCHITECTURE.md §7 lists: budget, then structural
   * limits, then capability match. Stall detection (M3-2) and rate-limit
   * headroom (M3-5) slot in between limits and capability as they land.
   *
   * Charges are committed here, before dispatch, against the estimate. A cap
   * enforced after the call is not a cap, and a run making concurrent calls
   * would otherwise authorise several that are individually inside the budget
   * and collectively outside it.
   */
  authorizeModelCall(request: ModelCallRequest): ModelCallAuthorization {
    if (this.mode === 'permissive') {
      // A trace reader looking at an approved call has to be able to tell
      // "checked and permitted" from "not checked".
      return allow(request, ['governor: permissive stub, no limits enforced']);
    }

    const capabilities = this.capabilitiesFor(request.model);
    const estimatedTokens = request.estimatedInputTokens + request.estimatedOutputTokens;
    const estimatedCost = costOf(
      capabilities,
      request.estimatedInputTokens,
      request.estimatedOutputTokens,
    );

    const breach = this.ledger.wouldBreach(
      { nodeId: request.nodeId, roleId: request.roleId },
      { tokens: estimatedTokens, costUsd: estimatedCost },
    );
    if (breach) {
      const where = breach.scope === 'run' ? 'run' : `${breach.scope} "${breach.id ?? ''}"`;
      return deny(
        'GOVERNOR_BUDGET_EXCEEDED',
        breach.measure === 'tokens'
          ? `The ${where} token budget of ${String(breach.limit)} is spent — this call needs ${String(breach.wouldReach - breach.spent)} more, and ${String(breach.spent)} is already used.`
          : `The ${where} cost budget of ${money(breach.limit)} is spent — this call would reach ${money(breach.wouldReach)}.`,
        { ...breach, runId: request.runId },
      );
    }

    const limitBreach = this.tracker.wouldBreach(request.depth);
    if (limitBreach) {
      const codes: Record<typeof limitBreach.kind, DenialCode> = {
        depth: 'GOVERNOR_DEPTH_EXCEEDED',
        steps: 'GOVERNOR_STEP_LIMIT_EXCEEDED',
        wallClock: 'GOVERNOR_STEP_LIMIT_EXCEEDED',
      };
      const messages: Record<typeof limitBreach.kind, string> = {
        depth: `Nesting depth ${String(limitBreach.actual)} exceeds the declared maximum of ${String(limitBreach.limit)}.`,
        steps: `This run has used its ${String(limitBreach.limit)} authorised steps.`,
        wallClock: `This run has been going for ${String(Math.round(limitBreach.actual / 1000))}s, past its ${String(Math.round(limitBreach.limit / 1000))}s limit.`,
      };
      return deny(codes[limitBreach.kind], messages[limitBreach.kind], {
        ...limitBreach,
        runId: request.runId,
      });
    }

    const stall = this.stallDetector?.verdict(request.nodeId);
    if (stall?.stalled === true) {
      // A stall is its own answer, not a budget error. "You have spent enough"
      // and "this is not going to finish" are different things to tell a user,
      // and only one of them is fixed by raising a limit.
      return deny(
        'GOVERNOR_STALLED',
        `Node "${request.nodeId}" has produced no new information for ${String(stall.repeats + 1)} iterations — same output, no new tool calls. Stopping rather than spending more.`,
        {
          nodeId: request.nodeId,
          repeats: stall.repeats,
          similarity: Number(stall.lastSimilarity.toFixed(3)),
          runId: request.runId,
        },
      );
    }

    const missing = this.unsupportedCapabilities(capabilities, request.requiredCapabilities);
    if (missing.length > 0) {
      // Checked at call time as well as at save time (schema rule 4), because a
      // connection's available models change between the two.
      return deny(
        'GOVERNOR_CAPABILITY_MISMATCH',
        `"${request.model}" does not support ${missing.join(', ')}, which this node needs.`,
        { model: request.model, missing, runId: request.runId },
      );
    }

    this.ledger.charge(
      { nodeId: request.nodeId, roleId: request.roleId },
      { tokens: estimatedTokens, costUsd: estimatedCost },
    );
    this.tracker.countStep();

    const notes = [
      `budget: ${String(this.ledger.spendAt('run', null).tokens)} tokens used`,
      ...(estimatedCost === null
        ? ['cost: model has no verified price, cost cap not enforceable for this call']
        : []),
    ];
    return allow(request, notes);
  }

  /**
   * Capabilities the model does not certainly have.
   *
   * `unknown` counts as missing. The tri-state exists precisely so that an
   * absent fact cannot be read as a yes, and a Governor that authorised a
   * tool-calling node against a model nobody has verified supports tools would
   * be doing exactly that.
   */
  private unsupportedCapabilities(
    capabilities: ModelCapabilities,
    required: readonly RequiredCapability[],
  ): RequiredCapability[] {
    return required.filter((capability) => capabilities[capability] !== 'supported');
  }

  /**
   * Authorizes one tool call.
   *
   * Allowlist, egress and approval-gate checks arrive with the workflow policy
   * they read (M4-3 and M4-4). What is enforced here today is the structural
   * limit — a tool call is a step like any other, and a run out of steps or
   * past its wall clock does not get to keep calling tools.
   */
  authorizeToolCall(request: ToolCallRequest): ToolCallAuthorization {
    if (this.mode === 'permissive') {
      return allow(request, ['governor: permissive stub, no limits enforced']);
    }

    const limitBreach = this.tracker.wouldBreach(request.depth);
    if (limitBreach) {
      return deny(
        limitBreach.kind === 'depth' ? 'GOVERNOR_DEPTH_EXCEEDED' : 'GOVERNOR_STEP_LIMIT_EXCEEDED',
        limitBreach.kind === 'depth'
          ? `Nesting depth ${String(limitBreach.actual)} exceeds the declared maximum of ${String(limitBreach.limit)}.`
          : `This run has exhausted its step or time limit and cannot call "${request.toolId}".`,
        { ...limitBreach, toolId: request.toolId, runId: request.runId },
      );
    }

    this.tracker.countStep();
    return allow(request, [`step ${String(this.tracker.stepCount)}`]);
  }
}

/**
 * The Governor a run uses.
 *
 * Still defaults to permissive so every existing caller behaves as it did. A
 * real run passes `'enforcing'` with the workflow's declared policy; M4's
 * engine is where that becomes the only way a run is started.
 */
export function createGovernor(
  mode: GovernorMode = 'permissive',
  policy: GovernorPolicy = {},
): Governor {
  return new Governor(mode, policy);
}

export { toolSignature };

/** Turns a denial into the error the runtime surfaces. */
export function denialToError(denied: Denied): GovernorLimitError {
  return new GovernorLimitError(denied.code, denied.message, denied.details);
}
