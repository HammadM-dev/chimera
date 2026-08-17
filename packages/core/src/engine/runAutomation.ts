import type Database from 'better-sqlite3';
import { ValidationError } from '@chimera/errors';
import type { AdapterCallOptions, ProviderAdapter } from '@chimera/providers';
import type { ToolRegistry } from '@chimera/tools';
import { Governor } from '../governor/Governor.ts';
import { createSpendMeter } from '../governor/spendMeter.ts';
import { runAgentLoop, type HaltCause, type LoopResult } from '../runtime/agentLoop.ts';
import { createCheckpointStore } from '../runtime/checkpoint.ts';
import { createTraceSink } from '../runtime/trace.ts';
import { finalizeRun } from '../runtime/runOutcome.ts';
import type { Role } from '../runtime/roleRegistry.ts';
import type { ToolObservation } from '../runtime/promptAssembly.ts';
import { executionOrder, validateBrief, type BriefStep, type RunBrief } from './runBrief.ts';
import { applyTransform, evaluateCondition } from './nodeTypes.ts';

// The executor. Runs a brief's steps in order, each as an agent, each through
// the Governor, each journaled and traced.
//
// Sequential by design at this stage: fan-out is a separate mechanism with its
// own failure modes (M5), and a sequential executor that works is worth more
// than a parallel one that mostly does.

export interface StepOutcome {
  nodeId: string;
  /** `agent` unless the step shapes the run rather than doing the work. */
  type: string;
  roleId: string;
  status: LoopResult['status'];
  haltCause: HaltCause;
  output: string;
  iterations: number;
}

export interface RunOutcomeSummary {
  runId: string;
  status: 'succeeded' | 'halted' | 'cancelled' | 'incomplete' | 'failed';
  summary: string | null;
  steps: StepOutcome[];
  output: string;
}

export interface RunAutomationDeps {
  db: Database.Database;
  runId: string;
  brief: RunBrief;
  roles: readonly Role[];
  /** Resolves the adapter and call options for a step's connection. */
  providerFor: (connectionId: string) => { adapter: ProviderAdapter; options: AdapterCallOptions };
  tools: ToolRegistry;
  governor: Governor;
  cancellation?: { readonly cancelled: boolean };
  onStep?: (event: {
    nodeId: string;
    phase: 'started' | 'finished';
    outcome?: StepOutcome;
  }) => void;
  /**
   * Asks a person to approve, and waits.
   *
   * Injected because waiting for a human is not something the engine can do on
   * its own — the answer arrives over IPC, from a window that may not be open.
   * Absent means no approval node can run, which is the safe reading: a gate
   * nobody can answer is a stop, not a pass.
   */
  requestApproval?: (input: {
    nodeId: string;
    prompt: string;
    context: string;
  }) => Promise<{ approved: boolean; note: string }>;
}

/**
 * Renders the brief's attachments as observations.
 *
 * Attachments are files the user chose, and their contents are still untrusted
 * — a PDF exported from a web page is a web page. Handing them to the loop as
 * observations puts them through M2-6's envelope, in the data position, rather
 * than concatenating them into the instruction where a "SYSTEM:" line in a
 * README would read as one.
 */
function attachmentObservations(brief: RunBrief): ToolObservation[] {
  return brief.attachments.map((attachment, index) => ({
    callId: `attachment-${String(index)}`,
    toolId: 'brief.attachment',
    output:
      attachment.content === ''
        ? `${attachment.name}: not read (${attachment.note})`
        : `${attachment.name}:\n${attachment.content}`,
    isError: attachment.content === '',
  }));
}

export async function runAutomation(deps: RunAutomationDeps): Promise<RunOutcomeSummary> {
  const { db, runId, brief, roles, tools, governor } = deps;

  const problems = validateBrief(
    brief,
    roles.map((role) => role.id),
  );
  if (problems.length > 0) {
    throw new ValidationError(
      'BRIEF_INVALID',
      problems.map((problem) => problem.message).join(' '),
      { problems },
    );
  }

  const { order, cycle } = executionOrder(brief);
  if (cycle) {
    throw new ValidationError(
      'BRIEF_CYCLIC',
      'These steps loop back on themselves, so there is no order to run them in.',
      {},
    );
  }

  const checkpoints = createCheckpointStore(db);
  const trace = createTraceSink(db, runId);
  const meter = createSpendMeter({ db, runId, governor });

  const steps: StepOutcome[] = [];
  let carried = '';
  let last: LoopResult | null = null;

  const byId = new Map(brief.steps.map((step) => [step.nodeId, step]));
  // Who feeds each step, so a step whose every input was ruled out can be
  // ruled out too.
  const sources = new Map<string, string[]>();
  for (const [from, to] of brief.edges) {
    sources.set(to, [...(sources.get(to) ?? []), from]);
  }

  // Every step's output, by node id, so a transform can reach back past the
  // step immediately before it and a condition can test a named one.
  const outputs = new Map<string, string>();
  // Steps a condition ruled out. Skipped rather than removed, so the graph a
  // user drew is still the graph that ran — the trace shows what was not taken,
  // which is half of understanding why a run did what it did.
  const skipped = new Set<string>();
  // Steps a loop node runs itself. Not the same thing as skipped: these do run,
  // just under the loop rather than in the outer pass, so what follows them
  // must not be treated as cut off.
  const ownedByLoop = new Set<string>();

  /**
   * Runs one non-agent step.
   *
   * These make no model call, cost nothing, and cannot fail for a reason the
   * Governor would recognise — so they report their own outcome rather than
   * borrowing the agent loop's.
   */
  const runShapingStep = async (step: BriefStep, type: string): Promise<StepOutcome> => {
    const base = { nodeId: step.nodeId, type, roleId: step.roleId, iterations: 1 };

    if (type === 'condition' && step.config?.type === 'condition') {
      const condition = step.config.condition;
      const source = condition.source === '' ? carried : (outputs.get(condition.source) ?? '');
      const passed = evaluateCondition(condition, source);

      // The branch not taken is marked skipped rather than deleted.
      for (const nodeId of passed ? condition.whenFalse : condition.whenTrue) {
        skipped.add(nodeId);
      }

      const answer = passed ? 'true' : 'false';
      outputs.set(step.nodeId, answer);
      trace.append({
        nodeId: step.nodeId,
        eventType: 'decision',
        payload: {
          decision: `condition:${answer}`,
          test: condition.test,
          skipped: passed ? condition.whenFalse : condition.whenTrue,
        },
      });
      return { ...base, status: 'succeeded', haltCause: 'completed', output: answer };
    }

    if (type === 'transform' && step.config?.type === 'transform') {
      // `carried` is addressable as `previous`, so a template does not have to
      // know the id of the step before it.
      const scope = new Map(outputs);
      scope.set('previous', carried);
      const rendered = applyTransform(step.config.transform, scope);
      outputs.set(step.nodeId, rendered);
      carried = rendered;
      return { ...base, status: 'succeeded', haltCause: 'completed', output: rendered };
    }

    if (type === 'approval' && step.config?.type === 'approval') {
      const approval = step.config.approval;
      if (!deps.requestApproval) {
        // A gate nobody can answer must not be treated as passed. CLAUDE.md:
        // irreversible actions require a gate, and an unanswerable gate is a
        // stop, not a pass.
        return {
          ...base,
          status: 'denied',
          haltCause: 'limit',
          output: 'This run needs approval and there is nobody to ask.',
        };
      }

      const context =
        approval.showSource === '' ? carried : (outputs.get(approval.showSource) ?? carried);
      trace.append({
        nodeId: step.nodeId,
        eventType: 'decision',
        payload: { decision: 'approval:requested', prompt: approval.prompt },
      });

      const answer = await deps.requestApproval({
        nodeId: step.nodeId,
        prompt: approval.prompt,
        context,
      });

      trace.append({
        nodeId: step.nodeId,
        eventType: 'decision',
        payload: {
          decision: answer.approved ? 'approval:granted' : 'approval:refused',
          note: answer.note,
        },
      });

      outputs.set(step.nodeId, answer.approved ? 'approved' : 'refused');
      return answer.approved
        ? { ...base, status: 'succeeded', haltCause: 'completed', output: 'approved' }
        : {
            ...base,
            status: 'cancelled',
            haltCause: 'cancelled',
            output: answer.note === '' ? 'Refused.' : `Refused: ${answer.note}`,
          };
    }

    if (type === 'loop' && step.config?.type === 'loop') {
      const loop = step.config.loop;
      const bodySteps = loop.body
        .map((nodeId) => byId.get(nodeId))
        .filter((candidate): candidate is BriefStep => candidate !== undefined);

      // The loop runs its body itself, so the outer pass must not run them a
      // second time when it reaches them.
      for (const bodyStep of bodySteps) ownedByLoop.add(bodyStep.nodeId);

      let passes = 0;
      for (let pass = 0; pass < loop.maxIterations; pass += 1) {
        passes = pass + 1;
        for (const bodyStep of bodySteps) {
          if (deps.cancellation?.cancelled === true) break;
          const inner = await runOne(bodyStep, false);
          if (inner.status !== 'succeeded') {
            // A body that halted halts the loop. Repeating a step that just
            // failed is the fastest way to spend a budget on nothing.
            return {
              ...base,
              iterations: passes,
              status: inner.status,
              haltCause: inner.haltCause,
              output: `Stopped in "${inner.nodeId}": ${inner.output}`,
            };
          }
        }
        if (deps.cancellation?.cancelled === true) break;
        if (loop.until && evaluateCondition(loop.until, carried)) break;
      }

      trace.append({
        nodeId: step.nodeId,
        eventType: 'decision',
        payload: {
          decision: 'loop:finished',
          passes,
          maxIterations: loop.maxIterations,
          // Said plainly because "it ran the maximum number of times" and "it
          // finished early because the exit condition held" are different
          // outcomes that look identical in a list of steps.
          reason:
            loop.until && evaluateCondition(loop.until, carried) ? 'exit-condition' : 'max-passes',
        },
      });

      outputs.set(step.nodeId, carried);
      return {
        ...base,
        iterations: passes,
        status: 'succeeded',
        haltCause: 'completed',
        output: carried,
      };
    }

    return {
      ...base,
      status: 'denied',
      haltCause: 'limit',
      output: `"${type}" is not a node type this build can run.`,
    };
  };

  /** Runs one agent step: a real model call, through the Governor. */
  const runAgentStep = async (step: BriefStep, seedAttachments: boolean): Promise<StepOutcome> => {
    const role = roles.find((candidate) => candidate.id === step.roleId);
    if (!role) {
      return {
        nodeId: step.nodeId,
        type: 'agent',
        roleId: step.roleId,
        status: 'denied',
        haltCause: 'limit',
        output: `No agent called "${step.roleId}".`,
        iterations: 0,
      };
    }
    const { adapter, options } = deps.providerFor(step.connectionId);

    // What this step is told: its own instruction, or the brief's when it has
    // none. The previous step's answer is carried as context rather than as an
    // instruction — it is output, and output is data.
    const task = [
      step.instruction.trim() === '' ? brief.instruction : step.instruction,
      carried === '' ? '' : `\n\nWhat the previous step produced:\n${carried}`,
    ]
      .join('')
      .trim();

    const result = await runAgentLoop(
      {
        runId,
        nodeId: step.nodeId,
        role,
        task,
        connectionId: step.connectionId,
        model: step.model,
      },
      {
        governor,
        provider: adapter,
        tools,
        callOptions: options,
        checkpoints,
        trace,
        meter,
        // The files reach the first step only. Re-attaching them to every step
        // would re-pay for the same tokens at every hop.
        ...(seedAttachments ? { seedObservations: attachmentObservations(brief) } : {}),
        ...(deps.cancellation ? { cancellation: deps.cancellation } : {}),
      },
    );

    last = result;
    carried = result.output;
    outputs.set(step.nodeId, result.output);

    return {
      nodeId: step.nodeId,
      type: 'agent',
      roleId: step.roleId,
      status: result.status,
      haltCause: result.haltCause,
      output: result.output,
      iterations: result.iterations,
    };
  };

  /** Runs any step, records it, and tells the renderer either side of it. */
  const runOne = async (step: BriefStep, seedAttachments: boolean): Promise<StepOutcome> => {
    const type = step.type ?? 'agent';
    deps.onStep?.({ nodeId: step.nodeId, phase: 'started' });
    const outcome =
      type === 'agent'
        ? await runAgentStep(step, seedAttachments)
        : await runShapingStep(step, type);
    steps.push(outcome);
    deps.onStep?.({ nodeId: step.nodeId, phase: 'finished', outcome });
    return outcome;
  };

  for (const [index, step] of order.entries()) {
    if (deps.cancellation?.cancelled === true) break;
    if (skipped.has(step.nodeId) || ownedByLoop.has(step.nodeId)) continue;

    // A step whose every input was ruled out is ruled out too. Without this,
    // only the branch's first step would be skipped and everything downstream
    // of it would run on nothing.
    const feeders = sources.get(step.nodeId) ?? [];
    if (feeders.length > 0 && feeders.every((from) => skipped.has(from))) {
      skipped.add(step.nodeId);
      continue;
    }

    const outcome = await runOne(step, index === 0);

    // A halted step halts the run. Carrying on would spend the next step's
    // budget on input the halted one never finished producing.
    if (outcome.status !== 'succeeded') break;
  }

  const finalResult: LoopResult = last ?? {
    status: 'cancelled',
    haltCause: 'cancelled',
    output: '',
    iterations: 0,
    steps: [],
    observations: [],
    verification: null,
    structuredOutput: null,
  };
  const outcome = finalizeRun(db, runId, finalResult);

  return { runId, status: outcome.status, summary: outcome.summary, steps, output: carried };
}
