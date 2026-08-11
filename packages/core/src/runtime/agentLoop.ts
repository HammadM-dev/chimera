import { GovernorLimitError } from '@chimera/errors';
import type {
  AdapterCallOptions,
  Message,
  NormalisedResponse,
  ProviderAdapter,
  ToolDefinition,
} from '@chimera/providers';
import { textOf } from '@chimera/providers';
import type { RegisteredTool, ToolRegistry } from '@chimera/tools';
import type { Governor } from '../governor/Governor.ts';
import { toolSignature } from '../governor/stallDetector.ts';
import type { CallPurpose, Denied } from '../governor/types.ts';
import type { Role } from './roleRegistry.ts';
import { assemblePrompt, type ToolObservation } from './promptAssembly.ts';
import { BUILTIN_SCHEMAS, enforceOutputContract, type OnInvalid } from './outputContract.ts';
import { assertMemoryAvailable, type MemoryConfig } from './memory/vectorStore.ts';
import { NULL_TRACE_SINK, type TraceSink } from './trace.ts';
import type { SpendMeter } from '../governor/spendMeter.ts';
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

const VERIFY_INSTRUCTION =
  'Has the task been achieved? Answer only with a JSON object: ' +
  '{"verified": true or false, "evidence": "what you actually observed that shows this"}. ' +
  'Cite what the tools returned. If you cannot point at evidence, answer false.';

export async function runAgentLoop(task: AgentTask, deps: AgentLoopDeps): Promise<LoopResult> {
  // Before anything else, and before any money is spent: a node asking for a
  // memory tier this build does not have fails where the user can see it.
  assertMemoryAvailable(task.memory, { runId: task.runId, nodeId: task.nodeId });

  const { governor, provider, tools, callOptions } = deps;
  const trace = deps.trace ?? NULL_TRACE_SINK;
  const available = tools.listFor(task.role);
  const definitions = toolDefinitions(available);

  // Resumed state, or a fresh checkpoint. `resumed` distinguishes "we already
  // planned" from "we have not started" — without it a resumed run would replan
  // and pay for a model call it had already made.
  const restored: RunCheckpoint =
    deps.checkpoints?.load(task.runId, task.nodeId) ?? structuredClone(EMPTY_CHECKPOINT);
  const resumed = restored.steps.length > 0;

  const steps: LoopStep[] = restored.steps;
  const observations: ToolObservation[] = restored.observations;
  const history: Message[] = restored.history;
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

  const finish = (status: LoopStatus, extra: Partial<LoopResult> = {}): LoopResult => {
    // A terminal state is journaled too, so a resume after a completed run
    // reports the outcome instead of re-running it.
    checkpoint(
      status === 'succeeded' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed',
    );
    return {
      status,
      output,
      iterations: iteration,
      steps,
      observations,
      verification,
      structuredOutput,
      ...extra,
    };
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
        availableTools: available.map((tool) => tool.id),
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

    const response = await provider.chat(
      {
        model: authorization.request.model,
        messages: [{ role: 'system', content: prompt.system }, ...prompt.messages],
        ...(withTools && definitions.length > 0 ? { tools: definitions } : {}),
      },
      callOptions,
    );

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
    finish('denied', {
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
  if (cancelled()) return finish('cancelled');

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
    if (cancelled()) return finish('cancelled');

    iteration += 1;

    const acted = await callModel('act', [], true);
    if ('denied' in acted) return denialResult(acted.denied);
    const actText = record('act', acted.response);
    // The Governor sees requests, not answers — this is how it learns whether
    // the node is going in circles (M3-2). A permissive Governor ignores it.
    governor.recordOutcome({
      nodeId: task.nodeId,
      iteration,
      text: actText,
      toolSignatures: acted.response.toolCalls.map((call) =>
        toolSignature(fromWireName(call.name), call.arguments),
      ),
    });
    if (actText !== '') output = actText;
    history.push({ role: 'assistant', content: actText, toolCalls: acted.response.toolCalls });
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
        // Until tool servers declare this (M4-3 wires the approval gate), the
        // conservative answer is the safe one: a call the Governor is told is
        // reversible when it is not would slip past an approval requirement.
        irreversible: true,
      });

      if (authorization.decision === 'deny') return denialResult(authorization);

      try {
        const result = await tools.invoke(toolId, call.arguments, { role: task.role });
        completedToolCalls[key] = { output: result.text, isError: result.isError };
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

    if (cancelled()) return finish('cancelled');

    // ---- verify -----------------------------------------------------------
    const verified = await callModel(
      'verify',
      [{ role: 'user', content: VERIFY_INSTRUCTION }],
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
    if (verification.verified) {
      const contracted = await applyOutputContract();
      if (contracted !== null && 'denied' in contracted) return denialResult(contracted.denied);
      return finish('succeeded');
    }

    history.push({
      role: 'assistant',
      content: `Verification failed: ${verification.evidence}`,
    });
  }

  // Out of iterations without verifying. CLAUDE.md: "No unbounded loops" — the
  // cap is the role's, and reaching it is a reported outcome rather than an
  // error, because the work done so far may still be worth something.
  return finish('exhausted');
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
