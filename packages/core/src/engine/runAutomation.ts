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
import { executionOrder, validateBrief, type RunBrief } from './runBrief.ts';

// The executor. Runs a brief's steps in order, each as an agent, each through
// the Governor, each journaled and traced.
//
// Sequential by design at this stage: fan-out is a separate mechanism with its
// own failure modes (M5), and a sequential executor that works is worth more
// than a parallel one that mostly does.

export interface StepOutcome {
  nodeId: string;
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

  for (const [index, step] of order.entries()) {
    if (deps.cancellation?.cancelled === true) break;

    const role = roles.find((candidate) => candidate.id === step.roleId);
    if (!role) continue;
    const { adapter, options } = deps.providerFor(step.connectionId);

    deps.onStep?.({ nodeId: step.nodeId, phase: 'started' });

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
        ...(index === 0 ? { seedObservations: attachmentObservations(brief) } : {}),
        ...(deps.cancellation ? { cancellation: deps.cancellation } : {}),
      },
    );

    last = result;
    carried = result.output;

    const outcome: StepOutcome = {
      nodeId: step.nodeId,
      roleId: step.roleId,
      status: result.status,
      haltCause: result.haltCause,
      output: result.output,
      iterations: result.iterations,
    };
    steps.push(outcome);
    deps.onStep?.({ nodeId: step.nodeId, phase: 'finished', outcome });

    // A halted step halts the run. Carrying on would spend the next step's
    // budget on input the halted one never finished producing.
    if (result.status !== 'succeeded') break;
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
