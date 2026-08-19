import { GovernorLimitError } from '@chimera/errors';
import { capabilityMatrix, type ModelCapabilities } from '@chimera/providers';
import { BudgetLedger, costOf, type BudgetPolicy } from './budget.ts';
import { LimitTracker, NO_LIMITS, type LimitPolicy } from './limits.ts';
import {
  RateLimiter,
  backoffDelayMs,
  type RateLimitPolicy,
  type RateVerdict,
} from './rateLimiter.ts';
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
  /** F4.6. Absent means no rate accounting, which is the right default offline. */
  rate?: RateLimitPolicy;
  /** Injected so backoff jitter is testable rather than merely observed to differ. */
  random?: () => number;
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

/**
 * Money, at a precision that does not round the number away.
 *
 * Four places is right for the figures a run actually reaches. It is wrong for
 * a limit somebody set below that: a cap of $0.0000001 was reported as "the
 * cost budget of $0.0000 is spent", which reads as a bug in the cap rather than
 * as the cap doing its job.
 */
function money(value: number): string {
  if (value === 0) return '$0';
  // Below four places, show the figure somebody actually typed rather than
  // rounding it away — and as a decimal, because "$1.0e-7" is not a price.
  if (Math.abs(value) < 0.0001) return `$${value.toFixed(10).replace(/0+$/, '')}`;
  return `$${value.toFixed(4)}`;
}

export class Governor {
  readonly mode: GovernorMode;
  private readonly ledger: BudgetLedger;
  private readonly tracker: LimitTracker;
  private readonly capabilitiesFor: (model: string) => ModelCapabilities;
  private readonly stallDetector: StallDetector | null;
  private readonly rateLimiter: RateLimiter;
  private readonly random: () => number;

  constructor(mode: GovernorMode = 'permissive', policy: GovernorPolicy = {}) {
    this.mode = mode;
    this.ledger = new BudgetLedger(policy.budget ?? {});
    this.tracker = new LimitTracker(policy.limits ?? NO_LIMITS, policy.now);
    this.capabilitiesFor = policy.capabilitiesFor ?? ((model) => capabilityMatrix.get(model));
    this.stallDetector =
      policy.stall === null ? null : new StallDetector(policy.stall ?? DEFAULT_STALL_POLICY);
    this.rateLimiter = new RateLimiter(policy.rate ?? {}, policy.now);
    this.random = policy.random ?? Math.random;
  }

  /**
   * How long to wait before retrying a call the provider rate-limited.
   *
   * The schedule lives here rather than in the runtime because backoff is a
   * governed decision like any other: it is the Governor that knows the policy,
   * and a runtime with its own retry timer would be a second answer to the same
   * question.
   */
  backoffFor(attempt: number): number {
    return backoffDelayMs(attempt, this.rateLimiter.retryPolicy, this.random);
  }

  get maxRetries(): number {
    return this.rateLimiter.retryPolicy.maxRetries;
  }

  /** Records that a provider rate-limited us, so our accounting matches theirs. */
  recordRateLimit(connectionId: string, retryAfterMs?: number): void {
    this.rateLimiter.penalise(connectionId, retryAfterMs);
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

  /** The matrix entry this Governor is using for a model. Read by M3-4's meter. */
  capabilitiesOf(model: string): ModelCapabilities {
    return this.capabilitiesFor(model);
  }

  /**
   * Corrects a charge once the provider reports what the call really used.
   *
   * `authorizeModelCall` commits an estimate before dispatch, because a cap
   * enforced after the fact is not a cap. An estimate of output length is a
   * guess, so without this the running total drifts from reality — in either
   * direction. Only the *difference* is applied, and it is negative whenever a
   * call came in cheaper than forecast, which is the common case.
   *
   * The estimate is passed back in rather than remembered here: a run making
   * concurrent calls has several estimates outstanding at once, and a Governor
   * holding "the last one" would reconcile the wrong one.
   */
  reconcile(
    context: { nodeId: string; roleId: string },
    call: {
      model: string;
      estimatedInputTokens: number;
      estimatedOutputTokens: number;
      usage: { inputTokens: number; outputTokens: number };
    },
  ): void {
    const capabilities = this.capabilitiesFor(call.model);

    const estimatedTokens = call.estimatedInputTokens + call.estimatedOutputTokens;
    const actualTokens = call.usage.inputTokens + call.usage.outputTokens;

    const estimatedCost = costOf(
      capabilities,
      call.estimatedInputTokens,
      call.estimatedOutputTokens,
    );
    const actualCost = costOf(capabilities, call.usage.inputTokens, call.usage.outputTokens);

    this.ledger.charge(context, {
      tokens: actualTokens - estimatedTokens,
      // Both null for an unpriced model: nothing was charged and nothing is
      // corrected. Never a one-sided delta, which would invent a cost.
      costUsd: estimatedCost === null || actualCost === null ? null : actualCost - estimatedCost,
    });
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

    const rate: RateVerdict = this.rateLimiter.consume(request.connectionId);
    if (rate.retryAfterMs !== undefined) {
      return deny(
        'GOVERNOR_RATE_LIMITED',
        `Connection "${request.connectionId}" has no rate headroom and no spillover left; it recovers in ${String(Math.ceil(rate.retryAfterMs / 1000))}s.`,
        {
          connectionId: request.connectionId,
          retryAfterMs: rate.retryAfterMs,
          runId: request.runId,
        },
      );
    }

    const { refused, unverified } = this.capabilityVerdict(
      capabilities,
      request.requiredCapabilities,
    );
    if (refused.length > 0) {
      // Checked at call time as well as at save time (schema rule 4), because a
      // connection's available models change between the two.
      return deny(
        'GOVERNOR_CAPABILITY_MISMATCH',
        `"${request.model}" does not support ${refused.join(', ')}, which this node needs.`,
        { model: request.model, missing: refused, runId: request.runId },
      );
    }

    this.ledger.charge(
      { nodeId: request.nodeId, roleId: request.roleId },
      { tokens: estimatedTokens, costUsd: estimatedCost },
    );
    this.tracker.countStep();

    // This is why an authorization carries the request back rather than a bare
    // yes (M2-1): a spilled-over call must be dispatched to the connection the
    // Governor chose, not the one the caller asked for.
    const approved: ModelCallRequest = rate.spilledOver
      ? { ...request, connectionId: rate.connectionId }
      : request;

    const notes = [
      ...(unverified.length > 0
        ? [
            `capability: nobody has verified that "${request.model}" supports ${unverified.join(', ')} — trying anyway, and the provider's answer decides`,
          ]
        : []),
      ...(rate.spilledOver
        ? [`rate: spilled over from "${request.connectionId}" to "${rate.connectionId}"`]
        : []),
      `budget: ${String(this.ledger.spendAt('run', null).tokens)} tokens used`,
      ...(estimatedCost === null
        ? ['cost: model has no verified price, cost cap not enforceable for this call']
        : []),
    ];
    return allow(approved, notes);
  }

  /**
   * Splits a node's required capabilities into refusals and unknowns.
   *
   * REVERSAL of M3-1's "unknown fails closed". That rule was written against a
   * curated matrix holding a handful of models whose facts this repository had
   * verified, and there it was right: an absent fact must not be read as a yes.
   *
   * It is wrong against a live catalogue. A user connecting Ollama Cloud or
   * OmniRoute imports two hundred models, and this build has verified the
   * capabilities of four of them — so `unknown` is not the exceptional case, it
   * is every case, and failing closed means nothing the user picks will ever
   * run. The founder hit exactly this: a working model, chosen from a working
   * catalogue, refused before a single call was made.
   *
   * So `unsupported` — a fact we hold, saying no — still denies. `unknown`
   * proceeds and is disclosed in the authorization's notes, because the honest
   * answer to "can this model call tools?" is "we are about to find out", and
   * the provider's own error is a better answer than our guess. What is not
   * acceptable is silence: a run that quietly degraded would leave the user
   * wondering why their agent never used a tool.
   */
  private capabilityVerdict(
    capabilities: ModelCapabilities,
    required: readonly RequiredCapability[],
  ): { refused: RequiredCapability[]; unverified: RequiredCapability[] } {
    return {
      refused: required.filter((capability) => capabilities[capability] === 'unsupported'),
      unverified: required.filter((capability) => capabilities[capability] === 'unknown'),
    };
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

    // CLAUDE.md: "Irreversible actions require a gate." This is that gate, at
    // the last point before the call happens. The save-time validator refuses
    // the obvious cases earlier; this catches the ones only the arguments
    // reveal — an HTTP POST from a step whose GETs were fine.
    if (request.irreversible && !request.gated) {
      return deny(
        'GOVERNOR_APPROVAL_REQUIRED',
        `"${request.toolId}" cannot be undone, and nobody has approved this step. Put an approval step before it, or pre-authorise the step.`,
        { toolId: request.toolId, nodeId: request.nodeId, runId: request.runId },
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
