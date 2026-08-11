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
import type { CallPurpose, Denied } from '../governor/types.ts';
import type { Role } from './roleRegistry.ts';
import { assemblePrompt, type ToolObservation } from './promptAssembly.ts';

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
  const { governor, provider, tools, callOptions } = deps;
  const available = tools.listFor(task.role);
  const definitions = toolDefinitions(available);

  const steps: LoopStep[] = [];
  const observations: ToolObservation[] = [];
  const history: Message[] = [];

  let output = '';
  let verification: Verification | null = null;
  let iteration = 0;

  const cancelled = (): boolean => deps.cancellation?.cancelled === true;

  const finish = (status: LoopStatus, extra: Partial<LoopResult> = {}): LoopResult => ({
    status,
    output,
    iterations: iteration,
    steps,
    observations,
    verification,
    ...extra,
  });

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

    if (authorization.decision === 'deny') return { denied: authorization };

    const response = await provider.chat(
      {
        model: authorization.request.model,
        messages: [{ role: 'system', content: prompt.system }, ...prompt.messages],
        ...(withTools && definitions.length > 0 ? { tools: definitions } : {}),
      },
      callOptions,
    );
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

  // ---- plan ---------------------------------------------------------------
  if (cancelled()) return finish('cancelled');

  const planned = await callModel('plan', [], false);
  if ('denied' in planned) return denialResult(planned.denied);
  const plan = record('plan', planned.response);
  history.push({ role: 'assistant', content: plan });
  output = plan;

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
    if (actText !== '') output = actText;
    history.push({ role: 'assistant', content: actText, toolCalls: acted.response.toolCalls });

    // ---- observe ----------------------------------------------------------
    for (const call of acted.response.toolCalls) {
      const toolId = fromWireName(call.name);

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
        observations.push({
          callId: call.id,
          toolId,
          output: result.text,
          isError: result.isError,
        });
      } catch (err) {
        // A refused or broken tool is an observation, not a crash: the agent
        // is told what happened and gets to react. The allowlist rejection
        // that lands here is the same one the injection corpus asserts.
        observations.push({
          callId: call.id,
          toolId,
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        });
      }
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

    // ---- decide -----------------------------------------------------------
    if (verification.verified) return finish('succeeded');

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
