import {
  GovernorLimitError,
  ProviderError,
  ProviderRateLimitError,
  isRetryable,
} from '@chimera/errors';
import type {
  AdapterCallOptions,
  Message,
  NormalisedResponse,
  ProviderAdapter,
  ToolDefinition,
} from '@chimera/providers';
import { textOf } from '@chimera/providers';
import { isIrreversible } from '@chimera/tools';
import type { RegisteredTool, ToolRegistry } from '@chimera/tools';
import type { Governor } from '../governor/Governor.ts';
import { toolSignature } from '../governor/stallDetector.ts';
import type { CallPurpose, Denied, ModelCallRequest } from '../governor/types.ts';
import type { Role } from './roleRegistry.ts';
import { assemblePrompt, type StepPlacement, type ToolObservation } from './promptAssembly.ts';
import {
  BUILTIN_SCHEMAS,
  enforceOutputContract,
  extractJson,
  type OnInvalid,
} from './outputContract.ts';
import { validateAgainstSchema } from './jsonSchema.ts';
import { assertMemoryAvailable, type MemoryConfig } from './memory/vectorStore.ts';
import { NULL_TRACE_SINK, type TraceSink } from './trace.ts';
import type { SpendMeter } from '../governor/spendMeter.ts';
import { costOf } from '../governor/budget.ts';
import {
  EMPTY_CHECKPOINT,
  idempotencyKeyFor,
  type CheckpointStore,
  type CompletedToolCall,
  type NodeStatus,
  type RunCheckpoint,
} from './checkpoint.ts';

// F2.1's plan → act → observe → verify → decide loop.
//
// Two things are load-bearing here and neither is negotiable. Every model call
// goes through `governor.authorizeModelCall` and every tool call through
// `governor.authorizeToolCall` — there is no other path to either in this file,
// and the ESLint rule in eslint.config.js makes importing an adapter or a tool
// server directly a build failure. And verification is a model call that asks
// whether the goal was met with evidence, not a heuristic over the output text:
// a loop that decides it is finished by pattern-matching its own prose is a
// loop that stops when it produces confident-sounding text.

/**
 * Why a run stopped.
 *
 * Every terminal outcome carries one, and every terminal outcome is built by
 * the same `halt()` below. Four causes, one code path — M3-6's whole point is
 * that a manual cancel and a budget cap do not diverge into two mechanisms that
 * drift apart.
 */
export type HaltCause =
  'completed' | 'cancelled' | 'budget' | 'stall' | 'rateLimit' | 'limit' | 'iterations';

export type LoopStatus =
  | 'succeeded'
  /** Ran out of iterations without verifying. Not a crash — an honest "not done". */
  | 'exhausted'
  /** The Governor refused a call. Carries the denial. */
  | 'denied'
  | 'cancelled';

export interface Verification {
  verified: boolean;
  evidence: string;
}

export interface LoopStep {
  purpose: CallPurpose;
  iteration: number;
  text: string;
  toolCalls: string[];
}

export interface LoopResult {
  status: LoopStatus;
  /** Why it stopped. Set by `halt()` and nowhere else. */
  haltCause: HaltCause;
  /** The agent's final answer, or the last thing it said before it stopped. */
  output: string;
  iterations: number;
  /** Every model call and tool result, in order. The run trace is built from this. */
  steps: LoopStep[];
  observations: ToolObservation[];
  verification: Verification | null;
  /**
   * The validated value, when the role declares a JSON output contract (M2-8).
   * Null for a text role, or when the loop did not reach a verified answer.
   */
  structuredOutput: unknown;
  /** Present when `status` is `denied`. */
  denial?: Denied;
  error?: GovernorLimitError;
}

/** Checked at step boundaries only, never mid-call. */
export interface Cancellation {
  readonly cancelled: boolean;
}

export interface PromptCacheHook {
  /** A previous answer to this exact prompt, or a close-enough one. */
  lookup: (input: {
    model: string;
    system: string;
    messages: readonly Message[];
  }) => Promise<{ response: NormalisedResponse; savedCostUsd: number; kind: string } | null>;
  /** Remembers an answer, if the policy says to. */
  remember: (input: {
    model: string;
    system: string;
    messages: readonly Message[];
    response: NormalisedResponse;
    costUsd: number;
  }) => Promise<void>;
}

export interface AgentTask {
  runId: string;
  nodeId: string;
  role: Role;
  /** The node's instruction, from the workflow definition. */
  task: string;
  connectionId: string;
  model: string;
  /** Nesting depth, for the Governor's recursion limit. */
  depth?: number;
  /**
   * Where this step sits in the automation, for the system message.
   *
   * Absent when the loop is run on its own, which is what the runtime's own
   * tests do.
   */
  placement?: StepPlacement;
  /**
   * Whether a person has already agreed to what this node may do — an approval
   * node upstream of it was granted, or the automation pre-authorises it.
   *
   * Absent means no, which is the only safe reading. A step that reaches an
   * irreversible tool with this unset is refused rather than allowed on the
   * assumption that somebody meant to set it.
   */
  gated?: boolean;
  /**
   * Which memory tiers this node wants (M2-10). `vectorStore` is refused until
   * M9 — loudly, at invocation, rather than by silently doing nothing.
   */
  memory?: MemoryConfig;
}

export interface AgentLoopDeps {
  governor: Governor;
  /**
   * The adapter to dispatch to *after* the Governor authorises.
   *
   * Injected rather than imported: `packages/core` may not import
   * `packages/providers/src/adapters/*` at all (lint-enforced), and the object
   * handed in here is reached through the provider registry's public interface.
   */
  provider: ProviderAdapter;
  tools: ToolRegistry;
  callOptions: AdapterCallOptions;
  cancellation?: Cancellation;
  /**
   * Journals resumable state after every completed step (M2-9).
   *
   * Optional: a loop with no store simply cannot be resumed, which is the right
   * behaviour for an eval or a dry run. When present, the loop resumes from
   * whatever it finds rather than starting over.
   */
  checkpoints?: CheckpointStore;
  /**
   * Called once, by the single halt path, whatever stopped the run.
   *
   * Exists so "all four causes converge on one code path" is a property a test
   * can assert rather than a claim about the source: a second halt path would
   * either not fire this or fire it twice.
   */
  onHalt?: (cause: HaltCause, result: LoopResult) => void;
  /**
   * Answers already paid for (M9-3).
   *
   * Injected rather than reached for, so the loop stays testable without a
   * database and so the policy — a workspace decision — is made above here
   * rather than inside it.
   */
  cache?: PromptCacheHook;
  /**
   * The live spend meter (M3-4). Optional for the same reason the checkpoint
   * store is: an eval or a dry run has no run row to account against.
   */
  meter?: SpendMeter;
  /**
   * The audit trace (F7.5). Defaults to discarding, so a unit test or a dry run
   * needs no database — but a real run always passes one, and M4-7's viewer
   * reads exactly what is written here.
   */
  trace?: TraceSink;
  /**
   * Observations the step starts with — the brief's attachments, for the first
   * step of an automation.
   *
   * Seeded as observations rather than folded into the task, so they go through
   * the untrusted-data envelope. A README containing "SYSTEM: ignore your
   * instructions" is a file the user attached, not an instruction they gave.
   */
  seedObservations?: readonly ToolObservation[];
  /**
   * Turns of conversation that happened before this task.
   *
   * For the assistant on the home screen, which is a conversation rather than a
   * step: each message the person sends is its own run of this loop, and
   * everything said so far is the context. Instruction-position deliberately —
   * these are the user's own words and this agent's own prior answers, which is
   * exactly what `history` is for. Anything a *tool* returned is not here; it
   * goes through `seedObservations` and the untrusted-data envelope.
   */
  seedHistory?: readonly Message[];
}

// Provider tool names are constrained to `[a-zA-Z0-9_-]` by both Anthropic and
// OpenAI, and CHIMERA's tool ids contain a dot (`filesystem.readFile`). The
// separator is swapped on the way out and back on the way in, in one place, so
// no caller has to know two names for one tool.
const WIRE_SEPARATOR = '__';

function toWireName(toolId: string): string {
  return toolId.split('.').join(WIRE_SEPARATOR);
}

function fromWireName(wireName: string): string {
  return wireName.split(WIRE_SEPARATOR).join('.');
}

function toolDefinitions(tools: readonly RegisteredTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: toWireName(tool.id),
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

/**
 * Reads the verifier's answer.
 *
 * Parses the last JSON object in the response. Anything unparseable, or a
 * missing `verified` field, counts as *not* verified — the failure mode of
 * guessing is a loop that declares success because its verifier replied with
 * prose, which is precisely the outcome a first-class verify step exists to
 * prevent.
 */
export function parseVerification(text: string): Verification {
  const start = text.indexOf('{');
  const finish = text.lastIndexOf('}');
  if (start === -1 || finish <= start) {
    return { verified: false, evidence: text.trim() };
  }
  try {
    const parsed = JSON.parse(text.slice(start, finish + 1)) as {
      verified?: unknown;
      evidence?: unknown;
    };
    return {
      verified: parsed.verified === true,
      evidence: typeof parsed.evidence === 'string' ? parsed.evidence : text.trim(),
    };
  } catch {
    return { verified: false, evidence: text.trim() };
  }
}

/** Which halt cause a Governor denial represents. */
function causeOfDenial(code: string): HaltCause {
  if (code === 'GOVERNOR_BUDGET_EXCEEDED') return 'budget';
  if (code === 'GOVERNOR_STALLED') return 'stall';
  if (code === 'GOVERNOR_RATE_LIMITED') return 'rateLimit';
  return 'limit';
}

/** Injectable-free on purpose: the delay is the Governor's number, not a policy here. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VERIFY_PREAMBLE =
  'Has the task been achieved? Answer only with a JSON object: ' +
  '{"verified": true or false, "evidence": "what you actually observed that shows this"}. ';

/**
 * What counts as evidence, which depends on what the step was asked to do.
 *
 * There was one instruction — "cite what the tools returned; if you cannot
 * point at evidence, answer false" — and for a step that uses tools it is the
 * right one. For a step that produces *writing* it is impossible to satisfy: a
 * planner breaking a goal into steps, a summariser drawing three answers
 * together, an agent asked to draft a note. None of them call anything, so
 * there is nothing to cite, so the honest answer to that instruction is always
 * false, and the run fails after burning its iterations. It only ever passed
 * when the model disregarded what it was told — which is why the same
 * automation failed and then, run again unchanged, worked.
 *
 * So the question matches the work. Did you use tools? Then cite them. Did you
 * write something? Then the writing is the evidence, and the question is
 * whether it does what was asked.
 */
function verifyInstruction(usedTools: boolean, placement: StepPlacement | undefined): string {
  // Which question is being asked, and it is a narrower one than it reads.
  //
  // "Has the task been achieved?" invites a step to check the *automation's*
  // goal rather than its own share of it, and a step near the front of a chain
  // will always answer no, because most of the work has not happened yet.
  //
  // Observed live, and it is the planner failure that was reported: the planner
  // produced a correct, complete plan in its first turn, and its verifier
  // answered "No tool outputs were provided; the steps have not been executed
  // to retrieve the current Base Rate" — grading the planner on whether the
  // plan had been *carried out*, which is the next agent's job and which the
  // planner's own system prompt says it does not do. Three iterations later it
  // exhausted, having been right the whole time.
  const scope =
    placement === undefined || placement.downstream.length === 0
      ? ''
      : ` You are checking this step only, not the automation. The steps after you — ${placement.downstream.join(', ')} — do their own parts, and none of that is yours to have finished. Producing what this step was asked for *is* achieving the task.`;

  return usedTools
    ? `${VERIFY_PREAMBLE}Cite what the tools returned. If you cannot point at evidence, answer false.${scope}`
    : `${VERIFY_PREAMBLE}You are checking your own last answer above. This step works from the material it was given, so no tool was needed and the absence of one is not a problem: quote the part of your answer that does what was asked. Answer false only if the answer is missing, empty, or does not address the task — never because it did not come from a tool.${scope}`;
}

/**
 * Whether this role's answer already satisfies the shape it was required to
 * take.
 *
 * False for a role with no JSON contract, which is most of them — there is
 * nothing here to check and the model's verification is the only one available.
 */
function outputMeetsContract(role: Role, output: string): boolean {
  const contract = role.outputContract;
  if (contract.format !== 'json' || contract.schemaId === null) return false;

  const schema = BUILTIN_SCHEMAS[contract.schemaId];
  if (!schema) return false;

  const parsed = extractJson(output);
  if (!parsed.ok) return false;

  return validateAgainstSchema(parsed.value, schema).length === 0;
}

export async function runAgentLoop(task: AgentTask, deps: AgentLoopDeps): Promise<LoopResult> {
  // Before anything else, and before any money is spent: a node asking for a
  // memory tier this build does not have fails where the user can see it.
  assertMemoryAvailable(task.memory, { runId: task.runId, nodeId: task.nodeId });

  const { governor, provider, tools, callOptions } = deps;
  const trace = deps.trace ?? NULL_TRACE_SINK;
  const grantedTools = tools.listFor(task.role);
  const definitions = toolDefinitions(grantedTools);
  /** The ids this role may actually call. */
  const available = new Set(grantedTools.map((tool) => tool.id));
  /**
   * Every id that exists at all, which is a different question.
   *
   * A tool this role may not call is a permission answer — the registry gives
   * it, and the model is told it is not allowed. A tool that does not exist is
   * a mistake the model made, and it needs a different sentence.
   */
  const known = new Set(tools.list().map((tool) => tool.id));

  // Resumed state, or a fresh checkpoint. `resumed` distinguishes "we already
  // planned" from "we have not started" — without it a resumed run would replan
  // and pay for a model call it had already made.
  const restored: RunCheckpoint =
    deps.checkpoints?.load(task.runId, task.nodeId) ?? structuredClone(EMPTY_CHECKPOINT);
  const resumed = restored.steps.length > 0;

  const steps: LoopStep[] = restored.steps;
  const observations: ToolObservation[] =
    restored.observations.length > 0 ? restored.observations : [...(deps.seedObservations ?? [])];
  // A resumed run already has its history in the checkpoint; a fresh one starts
  // with whatever conversation preceded it, which is nothing for an automation
  // step and everything for the assistant.
  const history: Message[] =
    restored.history.length > 0 ? restored.history : [...(deps.seedHistory ?? [])];
  const completedToolCalls: Record<string, CompletedToolCall> = restored.completedToolCalls;

  let output = restored.output;
  let verification: Verification | null = restored.verification;
  let structuredOutput: unknown = restored.structuredOutput;
  let iteration = restored.iteration;

  const cancelled = (): boolean => deps.cancellation?.cancelled === true;

  const checkpoint = (status: NodeStatus): void => {
    if (deps.checkpoints) {
      trace.append({
        nodeId: task.nodeId,
        eventType: 'checkpoint',
        payload: { status, iteration, steps: steps.length, observations: observations.length },
      });
    }
    deps.checkpoints?.save({
      runId: task.runId,
      nodeId: task.nodeId,
      status,
      checkpoint: {
        version: 1,
        iteration,
        output,
        steps,
        observations,
        history,
        completedToolCalls,
        verification,
        structuredOutput,
      },
    });
  };

  /**
   * The one way this loop ends.
   *
   * Manual cancel, budget cap, stall, rate-limit exhaustion, a structural
   * limit, and running out of iterations all arrive here. There is no other
   * expression in this file that builds a `LoopResult` — which is what stops
   * four halt behaviours drifting into four different sets of side effects,
   * one of which eventually forgets to journal.
   */
  const halt = (
    status: LoopStatus,
    cause: HaltCause,
    extra: Partial<LoopResult> = {},
  ): LoopResult => {
    // A terminal state is journaled too, so a resume after a completed run
    // reports the outcome instead of re-running it.
    checkpoint(
      status === 'succeeded' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed',
    );
    const result: LoopResult = {
      status,
      haltCause: cause,
      output,
      iterations: iteration,
      steps,
      observations,
      verification,
      structuredOutput,
      ...extra,
    };
    deps.onHalt?.(cause, result);
    return result;
  };

  /**
   * Sends the approved request, retrying only what retrying can fix.
   *
   * Two things are worth retrying. A 429 is transient: the provider is telling
   * us to slow down, and a bounded, jittered wait is the correct response. A
   * connection that never opened or was dropped mid-flight is transient in the
   * same way — under a fan-out's load, a reset socket is an ordinary event, and
   * failing an item over one throws away work that would have succeeded on the
   * next attempt.
   *
   * An auth failure is neither: a revoked key does not become valid because we
   * asked again, so it is surfaced immediately rather than burning the retry
   * budget discovering that. Nor is a 4xx about the request itself.
   *
   * The backoff schedule comes from the Governor, not from a timer here: a
   * runtime with its own retry policy would be a second answer to a governed
   * question.
   */
  const dispatch = async (
    approved: ModelCallRequest,
    prompt: { system: string; messages: Message[] },
    withTools: boolean,
  ): Promise<NormalisedResponse> => {
    const request = {
      model: approved.model,
      messages: [{ role: 'system' as const, content: prompt.system }, ...prompt.messages],
      ...(withTools && definitions.length > 0 ? { tools: definitions } : {}),
    };

    // An answer already paid for. Checked after the Governor authorised the
    // call, not before: a cache that skipped authorisation would be a bypass
    // path, and CLAUDE.md says there is no bypass path. The estimate the
    // Governor charged is reconciled to zero by the meter below.
    if (deps.cache) {
      const hit = await deps.cache.lookup({
        model: approved.model,
        system: prompt.system,
        messages: request.messages,
      });
      if (hit) {
        trace.append({
          nodeId: task.nodeId,
          eventType: 'decision',
          payload: {
            decision: `cache:${hit.kind}`,
            model: approved.model,
            savedCostUsd: hit.savedCostUsd,
          },
        });
        // Zeroed usage, deliberately. The Governor charged an estimate before
        // this call and the meter reconciles against what came back; handing
        // back the original call's token counts would bill the run for tokens
        // it never used, and then the saving figure would be counted twice.
        return { ...hit.response, usage: { inputTokens: 0, outputTokens: 0 } };
      }
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        const answer = await provider.chat(request, callOptions);
        if (deps.cache) {
          // Remembered against what it actually cost, so a hit can say what it
          // saved rather than guessing.
          const capabilities = governor.capabilitiesOf(approved.model);
          const spent = costOf(capabilities, answer.usage.inputTokens, answer.usage.outputTokens);
          await deps.cache.remember({
            model: approved.model,
            system: prompt.system,
            messages: request.messages,
            response: answer,
            costUsd: spent ?? 0,
          });
        }
        return answer;
      } catch (err) {
        // One rule, in `@chimera/errors`. This list used to live here and be
        // copied wherever else a retry was needed; both copies omitted 5xx, so
        // a provider having a bad thirty seconds failed a run outright.
        if (!isRetryable(err) || attempt >= governor.maxRetries) {
          // Out of retries, or an error retrying cannot fix. The checkpoint
          // written after the last completed step is the run's last-good state,
          // so this is resumable once the cause is fixed.
          checkpoint('failed');
          throw err;
        }

        // Only a real 429 tells the Governor to throttle this connection. A
        // dropped socket is not the provider asking us to slow down, and
        // recording it as one would cool a connection that is fine.
        if (err instanceof ProviderRateLimitError) {
          const retryAfterMs = Number(err.details.retryAfterMs);
          governor.recordRateLimit(
            approved.connectionId,
            Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
          );
        }

        const delayMs = governor.backoffFor(attempt);
        trace.append({
          nodeId: task.nodeId,
          eventType: 'retry',
          payload: {
            attempt: attempt + 1,
            delayMs,
            connectionId: approved.connectionId,
            reason: err instanceof ProviderError ? err.code : 'unknown',
          },
        });
        await sleep(delayMs);
      }
    }
  };

  /**
   * One authorised model call.
   *
   * Returns the denial rather than throwing it, so the caller decides how the
   * loop ends. Every call in this function goes through here — there is no
   * second path to `provider.chat`.
   */
  const callModel = async (
    purpose: CallPurpose,
    extraMessages: Message[],
    withTools: boolean,
  ): Promise<{ response: NormalisedResponse } | { denied: Denied }> => {
    const prompt = assemblePrompt({
      instructions: {
        role: task.role,
        task: task.task,
        availableTools: grantedTools.map((tool) => ({
          id: tool.id,
          description: tool.description,
        })),
        // The same flag the Governor decides on, so what the agent is told
        // about its permissions and what it is actually permitted cannot
        // disagree. They were two separate facts and only one of them reached
        // the model.
        gated: task.gated === true,
        ...(task.placement ? { placement: task.placement } : {}),
      },
      history: [...history, ...extraMessages],
      observations,
    });

    const authorization = governor.authorizeModelCall({
      runId: task.runId,
      nodeId: task.nodeId,
      roleId: task.role.id,
      iteration,
      depth: task.depth ?? 0,
      purpose,
      connectionId: task.connectionId,
      model: task.model,
      // A count, not a token estimate: real tokenisation is the provider's, and
      // M3-3's cost preview is where an accurate figure is owed. Four characters
      // per token is the same rough constant the mock provider uses.
      estimatedInputTokens: Math.ceil(
        (prompt.system.length +
          prompt.messages.reduce((total, message) => total + String(message.content).length, 0)) /
          4,
      ),
      estimatedOutputTokens: 1_000,
      requiredCapabilities: withTools && definitions.length > 0 ? ['toolCalling'] : [],
    });

    if (authorization.decision === 'deny') {
      trace.append({
        nodeId: task.nodeId,
        eventType: 'decision',
        payload: {
          decision: 'denied',
          purpose,
          code: authorization.code,
          message: authorization.message,
        },
      });
      return { denied: authorization };
    }

    trace.append({
      nodeId: task.nodeId,
      eventType: 'prompt',
      payload: {
        purpose,
        iteration,
        model: authorization.request.model,
        system: prompt.system,
        messages: prompt.messages,
        toolsOffered: withTools ? definitions.map((definition) => definition.name) : [],
        governorNotes: authorization.notes,
      },
    });

    const response = await dispatch(authorization.request, prompt, withTools);

    // Reconcile the estimate against what the call really used, before the next
    // authorization is made — otherwise the Governor's next decision is taken
    // against a forecast rather than against the bill.
    deps.meter?.record({
      nodeId: task.nodeId,
      roleId: task.role.id,
      model: authorization.request.model,
      usage: response.usage,
      estimatedInputTokens: authorization.request.estimatedInputTokens,
      estimatedOutputTokens: authorization.request.estimatedOutputTokens,
    });

    trace.append({
      nodeId: task.nodeId,
      eventType: 'response',
      payload: {
        purpose,
        iteration,
        model: response.model,
        text: textOf(response),
        toolCalls: response.toolCalls.map((call) => ({
          id: call.id,
          name: fromWireName(call.name),
          arguments: call.arguments,
        })),
        finishReason: response.finishReason,
      },
      tokensIn: response.usage.inputTokens,
      tokensOut: response.usage.outputTokens,
    });

    return { response };
  };

  const record = (purpose: CallPurpose, response: NormalisedResponse): string => {
    const text = textOf(response);
    steps.push({
      purpose,
      iteration,
      text,
      toolCalls: response.toolCalls.map((call) => fromWireName(call.name)),
    });
    return text;
  };

  const denialResult = (denied: Denied): LoopResult =>
    halt('denied', causeOfDenial(denied.code), {
      denial: denied,
      error: new GovernorLimitError(denied.code, denied.message, denied.details),
    });

  /**
   * Enforces the role's JSON output contract on the final answer (M2-8).
   *
   * Returns null when there is no contract to enforce, and a denial when the
   * Governor refuses one of the repair turns — repair turns are model calls
   * like any other and are authorised like any other. A contract that cannot be
   * satisfied throws `ValidationError`: unlike a budget denial, that is a
   * genuine failure rather than a governed outcome, and swallowing it would
   * hand the caller an answer of the wrong shape.
   */
  const applyOutputContract = async (): Promise<{ denied: Denied } | null> => {
    const contract = task.role.outputContract;
    if (contract.format !== 'json' || contract.schemaId === null) return null;

    const schema = BUILTIN_SCHEMAS[contract.schemaId];
    if (!schema) return null;

    let denied: Denied | null = null;

    const contracted = await enforceOutputContract(
      { schema, onInvalid: task.role.onInvalid ?? ('repair_once' as OnInvalid) },
      async (repair) => {
        if (denied) return '';
        // The first attempt costs no extra call: the answer the agent already
        // gave is what the contract is checked against. Only a repair needs the
        // model again.
        if (repair === null) return output;

        const attempt = await callModel('decide', [{ role: 'user', content: repair }], false);
        if ('denied' in attempt) {
          denied = attempt.denied;
          return '';
        }
        const text = record('decide', attempt.response);
        output = text;
        return text;
      },
    );

    if (denied) return { denied };
    structuredOutput = contracted.value;
    return null;
  };

  // ---- plan ---------------------------------------------------------------
  if (cancelled()) return halt('cancelled', 'cancelled');

  if (!resumed) {
    const planned = await callModel('plan', [], false);
    if ('denied' in planned) return denialResult(planned.denied);
    const plan = record('plan', planned.response);
    history.push({ role: 'assistant', content: plan });
    output = plan;
    checkpoint('running');
  }

  // ---- act / observe / verify / decide ------------------------------------
  while (iteration < task.role.maxIterations) {
    // Checked here, at the top of the step, and again after tools return.
    // Cancellation never interrupts a tool that is already running: a half-
    // executed side effect is worse than one extra completed step.
    if (cancelled()) return halt('cancelled', 'cancelled');

    iteration += 1;

    const acted = await callModel('act', [], true);
    if ('denied' in acted) return denialResult(acted.denied);
    const actText = record('act', acted.response);
    const signatures = acted.response.toolCalls.map((call) =>
      toolSignature(fromWireName(call.name), call.arguments),
    );
    // Counted as the tools return, and reported to the Governor after them:
    // going in circles is one way to make no progress, and having everything
    // you try refused is the other.
    let failedThisIteration = 0;
    if (actText !== '') output = actText;
    // Two assistant turns saying the same thing are one assistant turn saying
    // it twice, as far as the next model call is concerned. On a task simple
    // enough that the plan and the act are the same sentence, the verifier read
    // the pair as one run-on string — "readyready" — judged the answer wrong,
    // and the loop went round until the stall detector stopped it. A live run
    // against a hosted model failed "reply with exactly: ready" this way.
    const repeatsLastTurn =
      acted.response.toolCalls.length === 0 &&
      history.at(-1)?.role === 'assistant' &&
      history.at(-1)?.content === actText;
    // Nothing to say and nothing to call is what a model does when it has
    // already finished — it is the *absence* of a turn, not a turn. Recorded as
    // one, it becomes the last thing in the history, and the verifier asked
    // whether "the answer above" is any good is looking straight at it.
    //
    // Live, with a real model: the data extractor produced the whole correct
    // record set in its planning turn, added nothing in the acting turn because
    // there was nothing to add, and its verifier answered "the assistant's
    // previous answer was not generated from a tool call, so there is no
    // evidence" — then spent the rest of its iterations rummaging through an
    // empty workspace looking for data that was already in its prompt, and
    // exhausted. The correct answer existed at iteration zero.
    const addsNothing = actText === '' && acted.response.toolCalls.length === 0;
    if (!repeatsLastTurn && !addsNothing) {
      history.push({ role: 'assistant', content: actText, toolCalls: acted.response.toolCalls });
    }
    checkpoint('running');

    // ---- observe ----------------------------------------------------------
    let callIndex = -1;
    for (const call of acted.response.toolCalls) {
      callIndex += 1;
      const toolId = fromWireName(call.name);

      const key = idempotencyKeyFor({
        runId: task.runId,
        nodeId: task.nodeId,
        iteration,
        callIndex,
        toolId,
        args: call.arguments,
      });

      trace.append({
        nodeId: task.nodeId,
        eventType: 'tool_call',
        payload: {
          toolId,
          callId: call.id,
          iteration,
          arguments: call.arguments,
          idempotencyKey: key,
        },
      });

      // A tool the model invented is not a tool. Checked before the Governor
      // is asked anything, because the Governor's questions — is this
      // irreversible, has anybody approved it — are meaningless about a name
      // that does not exist, and an unknown name is treated as irreversible by
      // construction. Answering the model with "there is no such tool" lets it
      // pick a real one; refusing the *run* over a typo does not.
      if (!known.has(toolId)) {
        const message =
          available.size === 0
            ? `There is no tool called "${toolId}", and this agent has none available.`
            : `There is no tool called "${toolId}". The ones you can use are: ${[...available].join(', ')}.`;
        completedToolCalls[key] = { output: message, isError: true };
        failedThisIteration += 1;
        observations.push({ callId: call.id, toolId, output: message, isError: true });
        trace.append({
          nodeId: task.nodeId,
          eventType: 'tool_result',
          payload: { toolId, callId: call.id, output: message, isError: true, unknownTool: true },
        });
        continue;
      }

      const alreadyDone = completedToolCalls[key];
      if (alreadyDone) {
        // This exact call already ran before the process died. Replaying the
        // recorded result rather than calling again is the whole point of the
        // key: an email that was sent must not be sent twice because the app
        // was killed a moment later.
        observations.push({
          callId: call.id,
          toolId,
          output: alreadyDone.output,
          isError: alreadyDone.isError,
        });
        trace.append({
          nodeId: task.nodeId,
          eventType: 'tool_result',
          payload: {
            toolId,
            callId: call.id,
            output: alreadyDone.output,
            isError: alreadyDone.isError,
            replayedFromCheckpoint: true,
          },
        });
        continue;
      }

      const authorization = governor.authorizeToolCall({
        runId: task.runId,
        nodeId: task.nodeId,
        roleId: task.role.id,
        iteration,
        depth: task.depth ?? 0,
        toolId,
        egressTargets: egressTargetsOf(call.arguments),
        // Declared per call rather than per tool: an HTTP GET reads and an
        // HTTP POST does something, and treating them alike would either gate
        // every lookup or let every submission through.
        irreversible: isIrreversible(toolId, call.arguments),
        gated: task.gated === true,
      });

      if (authorization.decision === 'deny') return denialResult(authorization);

      try {
        const result = await tools.invoke(toolId, call.arguments, { role: task.role });
        completedToolCalls[key] = { output: result.text, isError: result.isError };
        if (result.isError) failedThisIteration += 1;
        observations.push({
          callId: call.id,
          toolId,
          output: result.text,
          isError: result.isError,
        });
        trace.append({
          nodeId: task.nodeId,
          eventType: 'tool_result',
          payload: {
            toolId,
            callId: call.id,
            output: result.text,
            isError: result.isError,
            replayedFromCheckpoint: false,
          },
        });
      } catch (err) {
        // A refused or broken tool is an observation, not a crash: the agent
        // is told what happened and gets to react. The allowlist rejection
        // that lands here is the same one the injection corpus asserts.
        const message = err instanceof Error ? err.message : String(err);
        // Recorded as completed: the call was made and this is its outcome. A
        // resume that retried it would be retrying a refusal, which cannot
        // succeed and costs a round trip to learn that.
        completedToolCalls[key] = { output: message, isError: true };
        observations.push({ callId: call.id, toolId, output: message, isError: true });
        trace.append({
          nodeId: task.nodeId,
          eventType: 'tool_result',
          payload: {
            toolId,
            callId: call.id,
            output: message,
            isError: true,
            replayedFromCheckpoint: false,
          },
        });
      }

      // After every tool, not after the batch: a process killed between two
      // tool calls must not replay the first one.
      checkpoint('running');
    }

    // Now that the tools have answered. The Governor sees what was asked for
    // and how much of it was refused, which is how it tells a node that is
    // working from one that is being turned away in a new manner each time.
    governor.recordOutcome({
      nodeId: task.nodeId,
      iteration,
      text: actText,
      toolSignatures: signatures,
      failedTools: failedThisIteration,
    });

    if (cancelled()) return halt('cancelled', 'cancelled');

    // ---- verify -----------------------------------------------------------
    //
    // A step whose answer has to take a stated shape has already been checked,
    // by a schema, against a rule nobody can argue with. Asking a model on top
    // of that does not add a check — it adds an opinion, and the opinion was
    // reliably about the wrong thing.
    //
    // The planner is the clearest case and the one that was reported broken. Its
    // job is to produce a plan; its contract says a plan is a non-empty list of
    // steps each carrying an action and a check. Live, it produced exactly that
    // on its first turn, three runs in a row — and its verifier answered "no
    // tool outputs were examined; the steps were only listed and no actual data
    // was retrieved", grading it on whether the plan had been *carried out*.
    // That is the next agent's work, and the planner's own system prompt says
    // it does not do it. It exhausted every time, having been right at
    // iteration zero every time.
    //
    // So: a satisfied contract is the verification. It is stricter than the
    // model's answer, it is free, and it cannot drift onto the wrong question.
    // A step with no contract — the researcher, the summariser, anything
    // producing prose — is verified as before, because there the model's
    // reading is the only check there is.
    const contractMet = outputMeetsContract(task.role, output);
    if (contractMet) {
      verification = {
        verified: true,
        evidence: `The answer matches the required ${task.role.outputContract.schemaId ?? 'output'} shape.`,
      };
      trace.append({
        nodeId: task.nodeId,
        eventType: 'decision',
        payload: { decision: 'verified', iteration, evidence: verification.evidence },
      });
      const contracted = await applyOutputContract();
      if (contracted !== null && 'denied' in contracted) return denialResult(contracted.denied);
      return halt('succeeded', 'completed');
    }

    const verified = await callModel(
      'verify',
      [{ role: 'user', content: verifyInstruction(observations.length > 0, task.placement) }],
      false,
    );
    if ('denied' in verified) return denialResult(verified.denied);
    const verifyText = record('verify', verified.response);
    verification = parseVerification(verifyText);
    trace.append({
      nodeId: task.nodeId,
      eventType: 'decision',
      payload: {
        decision: verification.verified ? 'verified' : 'continue',
        iteration,
        evidence: verification.evidence,
      },
    });
    checkpoint('running');

    // ---- decide -----------------------------------------------------------

    // Succeeding with nothing to show for it.
    //
    // Every turn so far called tools and said nothing — so there is no answer,
    // and the verifier has just agreed the work is done. The step would return
    // success and empty output, and the person would be handed a blank reply
    // from a run that reported it had finished.
    //
    // Rare in an automation, whose steps usually end by writing something.
    // Fatal in a conversation: the assistant looked up the workspace, its
    // verifier agreed that it had, and the answer was nothing at all.
    //
    // Going round again gives it the turn in which to speak. A step that
    // produced any prose keeps it and stops here, so this costs nothing in the
    // ordinary case.
    if (verification.verified && output.trim() === '' && iteration < task.role.maxIterations) {
      history.push({
        role: 'user',
        content:
          'You have what you needed. Now answer: say what you found, in your own words. Do not call another tool.',
      });
      continue;
    }

    if (verification.verified) {
      const contracted = await applyOutputContract();
      if (contracted !== null && 'denied' in contracted) return denialResult(contracted.denied);
      return halt('succeeded', 'completed');
    }

    history.push({
      role: 'assistant',
      content: `Verification failed: ${verification.evidence}`,
    });
  }

  // Out of iterations without verifying. CLAUDE.md: "No unbounded loops" — the
  // cap is the role's, and reaching it is a reported outcome rather than an
  // error, because the work done so far may still be worth something.
  return halt('exhausted', 'iterations');
}

/**
 * Hosts a tool call would contact, read from its arguments.
 *
 * Any argument that parses as an http/https URL contributes its hostname. The
 * Governor re-checks these against the workflow's egress allowlist; `http.ts`
 * checks the real URL again itself, so a target missed here is still refused at
 * the point of the request.
 */
function egressTargetsOf(args: Record<string, unknown>): string[] {
  const targets: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') targets.push(url.hostname);
    } catch {
      // Not a URL. Most arguments are not.
    }
  }
  return targets;
}
