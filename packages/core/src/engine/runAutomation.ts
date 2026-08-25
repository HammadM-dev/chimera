import type Database from 'better-sqlite3';
import { ValidationError } from '@chimera/errors';
import { tracesRepository, workflowsRepository } from '@chimera/store';
import type { AdapterCallOptions, ProviderAdapter } from '@chimera/providers';
import type { ToolRegistry } from '@chimera/tools';
import { Governor } from '../governor/Governor.ts';
import { createSpendMeter, type SpendSnapshot } from '../governor/spendMeter.ts';
import {
  runAgentLoop,
  type HaltCause,
  type LoopResult,
  type PromptCacheHook,
} from '../runtime/agentLoop.ts';
import { createCheckpointStore } from '../runtime/checkpoint.ts';
import { createTraceSink } from '../runtime/trace.ts';
import type { TraceEvent } from '../runtime/trace.ts';
import { finalizeRun } from '../runtime/runOutcome.ts';
import type { Role } from '../runtime/roleRegistry.ts';
import type { ToolObservation } from '../runtime/promptAssembly.ts';
import { executionOrder, validateBrief, type BriefStep, type RunBrief } from './runBrief.ts';
import { applyTransform, evaluateCondition } from './nodeTypes.ts';
import { itemsFrom, runFanout } from './nodeRunners/fanout.ts';
import { aggregateWithoutModel, chunk, itemsOf } from './nodeRunners/aggregate.ts';
import { MAX_CONCURRENT_AGENTS, runTeam } from './nodeRunners/team.ts';

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
  /**
   * Every trace event as it is written, for a window watching the run.
   *
   * Distinct from `onStep`, which fires twice per step. This fires on every
   * tool call, result and decision, which is what "show me what it is doing"
   * actually needs.
   */
  /**
   * Runs a swarm node, by making a thread in the Swarm section.
   *
   * Injected rather than built here, because a swarm needs a provider and the
   * engine is not allowed one — `packages/core` reaches models only through the
   * Governor and the caller's adapter. Absent means this build has no swarm,
   * and a workflow using one is refused rather than silently skipped.
   */
  runSwarmNode?: (input: {
    runId: string;
    nodeId: string;
    question: string;
    population: number;
    maxRounds: number;
    everyoneUpTo: number;
  }) => Promise<{ threadId: string; answer: string; population: number; mode: string }>;
  onTraceEvent?: (event: TraceEvent) => void;
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
  /**
   * Picks up a run that was interrupted rather than starting a fresh one.
   *
   * A resumed run replays every step that already succeeded from its journal —
   * no model call, no spend — and every approval that was already answered from
   * the trace. Re-running a five-step automation to get past a gate somebody
   * answered yesterday would charge for it twice.
   */
  resume?: boolean;
  /**
   * How deep this run already is inside other automations.
   *
   * Counts toward the Governor's recursion limit, and toward this engine's own
   * bound below. Absent means the top.
   */
  depth?: number;
  /**
   * Called after every cost-incurring call with the run's new totals.
   *
   * The meter has had this hook since M3-4 with nothing attached to it, which
   * is why the status bar said "No spend yet" through a run that was spending.
   */
  onSpend?: (snapshot: SpendSnapshot) => void;
  /**
   * Whether to write the run's terminal status when this returns.
   *
   * False for a nested run — a subworkflow, or one fan-out item. A nested run
   * that finalised would stamp `ended_at` on a run that is still going, and the
   * next thing to look at the row would believe it.
   */
  finalize?: boolean;
  /**
   * What the first step should treat as "the previous step's answer".
   *
   * A fan-out item arrives this way rather than as the brief's instruction: a
   * body step usually has an instruction of its own — "handle this invoice" —
   * and an item passed as an instruction is an item the step never sees. It is
   * data, so it enters where data enters.
   */
  seedCarried?: string;
  /**
   * Resolves a tier to a connection and model, for this workspace.
   *
   * Absent means tiers are not configured, which a step bound to one reports
   * as its own failure rather than falling back to some other model — running
   * on a model nobody chose is how a run ends up on the wrong provider, and it
   * is the failure this whole indirection exists to prevent.
   */
  resolveTier?: (tier: 'cheap' | 'standard' | 'frontier') => {
    connectionId: string;
    model: string;
  };
  /** The workspace's frontier model, for the meter's comparison figure. */
  frontierModel?: string;
  /**
   * Answers already paid for. Absent means every call is made fresh.
   *
   * Built by the caller because the policy is a workspace setting and the
   * embedding, when semantic reuse is on, needs a provider — neither of which
   * the engine should be reaching for on its own.
   */
  cache?: PromptCacheHook;
}

/**
 * How deeply automations may nest.
 *
 * A hard bound in the engine rather than a policy setting, because the
 * Governor's `maxDepth` defaults to no limit and an automation that includes
 * itself would otherwise recurse until the process died. CLAUDE.md's rule
 * against unbounded loops is a rule about anything that can repeat, and
 * nesting is repetition with extra steps.
 */
const MAX_NESTING = 5;

/** The last decision recorded for a node, so a resume does not ask twice. */
function priorApproval(
  db: Database.Database,
  runId: string,
  nodeId: string,
): { approved: boolean; note: string } | null {
  const decisions = tracesRepository
    .listForRun(db, runId)
    .filter((event) => event.nodeId === nodeId && event.eventType === 'decision')
    .map((event) => JSON.parse(event.payloadJson) as { decision?: string; note?: string })
    .filter(
      (payload) =>
        payload.decision === 'approval:granted' || payload.decision === 'approval:refused',
    );

  const last = decisions.at(-1);
  if (!last) return null;
  return { approved: last.decision === 'approval:granted', note: last.note ?? '' };
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
    // Seeded before the agent has called anything, so it cannot go back as a
    // `tool` message answering a call that was never made — see
    // ToolObservation.unrequested.
    unrequested: true,
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
  const trace = createTraceSink(db, runId, {
    ...(deps.onTraceEvent ? { onEvent: deps.onTraceEvent } : {}),
  });
  const meter = createSpendMeter({
    db,
    runId,
    governor,
    ...(deps.frontierModel === undefined ? {} : { frontierModel: deps.frontierModel }),
    ...(deps.onSpend ? { onUpdate: deps.onSpend } : {}),
  });

  const steps: StepOutcome[] = [];
  let carried = deps.seedCarried ?? '';
  let last: LoopResult | null = null;

  const byId = new Map(brief.steps.map((step) => [step.nodeId, step]));
  // Who feeds each step, so a step whose every input was ruled out can be
  // ruled out too.
  const sources = new Map<string, string[]>();
  /** And who each step feeds, for the same reason read the other way. */
  const consumers = new Map<string, string[]>();
  for (const [from, to] of brief.edges) {
    sources.set(to, [...(sources.get(to) ?? []), from]);
    consumers.set(from, [...(consumers.get(from) ?? []), to]);
  }

  // What to call a neighbouring step when telling an agent who is on either
  // side of it. A person reading the canvas sees "Researcher", so that is what
  // the agent is told, not a node id it has no way to interpret.
  const stepLabel = (nodeId: string): string => {
    const step = byId.get(nodeId);
    if (!step) return 'a step';
    const type = step.type ?? 'agent';
    if (type !== 'agent') return type;
    return deps.roles.find((role) => role.id === step.roleId)?.name ?? step.roleId;
  };
  /** Agent steps only: the count a person would give if you asked how many agents this has. */
  const agentSteps = brief.steps.filter((step) => (step.type ?? 'agent') === 'agent');

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

  // Which steps a person has already agreed to. Computed once, from the graph:
  // every step downstream of an approval node, plus anything the automation
  // pre-authorises by name.
  const gatedNodes = new Set<string>(brief.preauthorised ?? []);
  {
    const targets = new Map<string, string[]>();
    for (const [from, to] of brief.edges) {
      targets.set(from, [...(targets.get(from) ?? []), to]);
    }
    const queue = brief.steps
      .filter((step) => (step.type ?? 'agent') === 'approval')
      .flatMap((step) => targets.get(step.nodeId) ?? []);
    while (queue.length > 0) {
      const nodeId = queue.shift();
      if (nodeId === undefined || gatedNodes.has(nodeId)) continue;
      gatedNodes.add(nodeId);
      queue.push(...(targets.get(nodeId) ?? []));
    }
  }

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

      const already = deps.resume === true ? priorApproval(db, runId, step.nodeId) : null;
      if (already) {
        outputs.set(step.nodeId, already.approved ? 'approved' : 'refused');
        return already.approved
          ? { ...base, status: 'succeeded', haltCause: 'completed', output: 'approved' }
          : {
              ...base,
              status: 'cancelled',
              haltCause: 'cancelled',
              output: already.note === '' ? 'Refused.' : `Refused: ${already.note}`,
            };
      }

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
        payload: {
          decision: 'approval:requested',
          prompt: approval.prompt,
          // Trimmed, and recorded: a run that stops for a person may be
          // answered after a restart, and the question is useless without
          // what it is asking about.
          context: context.slice(0, 4000),
        },
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

    if (type === 'subworkflow' && step.config?.type === 'subworkflow') {
      const child = step.config.subworkflow;
      const depth = (deps.depth ?? 0) + 1;

      if (depth > MAX_NESTING) {
        return {
          ...base,
          status: 'denied',
          haltCause: 'limit',
          output: `Automations may be nested ${String(MAX_NESTING)} deep. This one goes further, which usually means it contains itself.`,
        };
      }

      const version = workflowsRepository.get(
        db,
        child.workflowId,
        child.version === '' ? undefined : child.version,
      );
      if (!version) {
        return {
          ...base,
          status: 'denied',
          haltCause: 'limit',
          output: 'That automation is not in this workspace any more.',
        };
      }

      let childBrief: RunBrief;
      try {
        childBrief = JSON.parse(version.definitionJson) as RunBrief;
      } catch {
        return {
          ...base,
          status: 'denied',
          haltCause: 'limit',
          output: 'That automation could not be read.',
        };
      }

      // The child's steps are renamed under this node. Node ids are unique
      // within an automation, not across them, and both the journal and the
      // trace key on (run, node) — two automations that both call a step
      // "check" would otherwise resume each other's work.
      const prefixed: RunBrief = {
        ...childBrief,
        // The parent's carried output is what the child is told, unless the
        // child has an instruction of its own.
        instruction: childBrief.instruction === '' ? carried : childBrief.instruction,
        steps: childBrief.steps.map((childStep) => ({
          ...childStep,
          nodeId: `${step.nodeId}/${childStep.nodeId}`,
          ...(childStep.config?.type === 'condition'
            ? {
                config: {
                  type: 'condition' as const,
                  condition: {
                    ...childStep.config.condition,
                    source:
                      childStep.config.condition.source === ''
                        ? ''
                        : `${step.nodeId}/${childStep.config.condition.source}`,
                    whenTrue: childStep.config.condition.whenTrue.map(
                      (id) => `${step.nodeId}/${id}`,
                    ),
                    whenFalse: childStep.config.condition.whenFalse.map(
                      (id) => `${step.nodeId}/${id}`,
                    ),
                  },
                },
              }
            : {}),
          ...(childStep.config?.type === 'loop'
            ? {
                config: {
                  type: 'loop' as const,
                  loop: {
                    ...childStep.config.loop,
                    body: childStep.config.loop.body.map((id) => `${step.nodeId}/${id}`),
                  },
                },
              }
            : {}),
        })),
        edges: childBrief.edges.map(
          ([from, to]) => [`${step.nodeId}/${from}`, `${step.nodeId}/${to}`] as [string, string],
        ),
        preauthorised: (childBrief.preauthorised ?? []).map((id) => `${step.nodeId}/${id}`),
      };

      trace.append({
        nodeId: step.nodeId,
        eventType: 'decision',
        payload: {
          decision: 'subworkflow:started',
          workflowId: child.workflowId,
          version: version.versionNumber,
          depth,
        },
      });

      const inner = await runAutomation({
        ...deps,
        brief: prefixed,
        depth,
        finalize: false,
      });

      for (const innerStep of inner.steps) steps.push(innerStep);
      carried = inner.output;
      outputs.set(step.nodeId, inner.output);

      return {
        ...base,
        iterations: inner.steps.length,
        status: inner.status === 'succeeded' ? 'succeeded' : 'denied',
        haltCause: inner.status === 'succeeded' ? 'completed' : 'limit',
        output: inner.output,
      };
    }

    if (type === 'team' && step.config?.type === 'team') {
      const config = step.config.team;

      const teamed = await runTeam({
        db,
        runId,
        nodeId: step.nodeId,
        config,
        ...(deps.cancellation ? { cancellation: deps.cancellation } : {}),
        runAgent: async (input) => {
          // Each participant is its own nested run: its own node id, its own
          // carried context, its own journal rows. Workers run at the same
          // time, and sharing any of that would have them racing each other.
          const participant: RunBrief = {
            name: `${brief.name} — ${input.roleId}`,
            instruction: input.instruction,
            attachments: [],
            steps: [
              {
                nodeId: input.nodeId,
                type: 'agent',
                roleId: input.roleId,
                instruction: input.instruction,
                connectionId: step.connectionId,
                model: step.model,
              },
            ],
            edges: [],
            preauthorised: [input.nodeId],
          };

          const result = await runAutomation({
            ...deps,
            brief: participant,
            seedCarried: input.context,
            finalize: false,
            depth: (deps.depth ?? 0) + 1,
          });

          const only = result.steps[0];
          return {
            ok: only?.status === 'succeeded',
            output: only?.output ?? 'The agent produced nothing.',
          };
        },
      });

      trace.append({
        nodeId: step.nodeId,
        eventType: 'decision',
        payload: {
          decision: `team:${teamed.stopped}`,
          reason: teamed.reason,
          rounds: teamed.rounds.length,
          peakConcurrentAgents: teamed.peakConcurrentAgents,
          // Stated rather than hidden: the workflow may ask for more, and the
          // engine will not give it more.
          engineCap: MAX_CONCURRENT_AGENTS,
        },
      });

      outputs.set(step.nodeId, teamed.output);
      carried = teamed.output;

      return {
        ...base,
        iterations: teamed.rounds.length,
        status: teamed.stopped === 'failed' ? 'denied' : 'succeeded',
        haltCause: teamed.stopped === 'failed' ? 'limit' : 'completed',
        output: teamed.stopped === 'failed' ? teamed.reason : teamed.output,
      };
    }

    if (type === 'swarm' && step.config?.type === 'swarm') {
      const config = step.config.swarm;
      const question = config.question.trim() === '' ? carried : config.question;

      if (!deps.runSwarmNode) {
        return {
          ...base,
          status: 'denied',
          haltCause: 'limit',
          output: 'This build cannot run a swarm from an automation.',
        };
      }

      // Caught here rather than left to propagate. A rejection out of a node
      // runner unwinds past the point that journals the step, so the step stays
      // recorded as "running" for good — on screen it is a spinner that never
      // stops, which is the least useful way for anything to fail.
      let swarm: { threadId: string; answer: string; population: number; mode: string };
      try {
        swarm = await deps.runSwarmNode({
          runId,
          nodeId: step.nodeId,
          question,
          population: config.population,
          maxRounds: config.maxRounds,
          everyoneUpTo: config.everyoneUpTo,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        trace.append({
          nodeId: step.nodeId,
          eventType: 'decision',
          payload: { decision: 'swarm:failed', reason: message },
        });
        return { ...base, status: 'denied', haltCause: 'limit', output: message };
      }

      trace.append({
        nodeId: step.nodeId,
        eventType: 'decision',
        payload: {
          decision: 'swarm:finished',
          // The thread id, so the node on the canvas can offer a way into it.
          // The transcript is not copied here — it belongs in the Swarm section
          // and a step output is the wrong place to bury it.
          threadId: swarm.threadId,
          population: swarm.population,
          mode: swarm.mode,
        },
      });

      outputs.set(step.nodeId, swarm.answer);
      carried = swarm.answer;
      return { ...base, status: 'succeeded', haltCause: 'completed', output: swarm.answer };
    }

    if (type === 'aggregate' && step.config?.type === 'aggregate') {
      const config = step.config.aggregate;
      const source = config.source === '' ? carried : (outputs.get(config.source) ?? '');
      const items = itemsOf(source);

      const withoutModel = aggregateWithoutModel(config, items);
      if (withoutModel !== null) {
        outputs.set(step.nodeId, withoutModel);
        carried = withoutModel;
        trace.append({
          nodeId: step.nodeId,
          eventType: 'decision',
          payload: { decision: `aggregate:${config.strategy}`, items: items.length },
        });
        return { ...base, status: 'succeeded', haltCause: 'completed', output: withoutModel };
      }

      // reduce_with_agent: a fold, one model call per chunk, each through the
      // Governor like any other. Repeated until one answer is left, so a
      // thousand items do not have to fit in one context window.
      let round = 0;
      let folding = items;
      while (folding.length > 1 || round === 0) {
        const chunks = chunk(folding, config.chunkSize);
        const answers: string[] = [];

        for (const [index, group] of chunks.entries()) {
          carried = group.join('\n\n');
          const foldStep: BriefStep = {
            nodeId: `${step.nodeId}/round-${String(round)}/${String(index)}`,
            type: 'agent',
            roleId: config.roleId,
            instruction: config.instruction,
            connectionId: step.connectionId,
            model: step.model,
          };
          const folded = await runAgentStep(foldStep, false);
          if (folded.status !== 'succeeded') {
            return {
              ...base,
              status: folded.status,
              haltCause: folded.haltCause,
              output: `Aggregating stopped: ${folded.output}`,
            };
          }
          answers.push(folded.output);
        }

        folding = answers;
        round += 1;
        if (chunks.length <= 1) break;
      }

      const reduced = folding[0] ?? '';
      outputs.set(step.nodeId, reduced);
      carried = reduced;
      trace.append({
        nodeId: step.nodeId,
        eventType: 'decision',
        payload: {
          decision: 'aggregate:reduce_with_agent',
          items: items.length,
          rounds: round,
        },
      });
      return {
        ...base,
        iterations: round,
        status: 'succeeded',
        haltCause: 'completed',
        output: reduced,
      };
    }

    if (type === 'fanout' && step.config?.type === 'fanout') {
      const config = step.config.fanout;
      const source = config.source === '' ? carried : (outputs.get(config.source) ?? '');
      const items = itemsFrom(source, config.parse);

      const bodySteps = config.body
        .map((nodeId) => byId.get(nodeId))
        .filter((candidate): candidate is BriefStep => candidate !== undefined);
      for (const bodyStep of bodySteps) ownedByLoop.add(bodyStep.nodeId);

      if (bodySteps.length === 0) {
        return {
          ...base,
          status: 'denied',
          haltCause: 'limit',
          output: 'This fan-out has no steps to run over its items.',
        };
      }

      const fanned = await runFanout({
        db,
        runId,
        nodeId: step.nodeId,
        config,
        items,
        ...(deps.cancellation ? { cancellation: deps.cancellation } : {}),
        runItem: async ({ index, item }) => {
          // Each item is its own run of the body, with its own node ids and its
          // own carried output. Sharing either would make the items race each
          // other for the same journal rows and the same "previous answer".
          const text = typeof item === 'string' ? item : JSON.stringify(item);
          const itemBrief: RunBrief = {
            name: `${brief.name} — item ${String(index + 1)}`,
            instruction: text,
            attachments: [],
            steps: bodySteps.map((bodyStep) => ({
              ...bodyStep,
              nodeId: `${step.nodeId}/${String(index)}/${bodyStep.nodeId}`,
            })),
            edges: [],
            preauthorised: (brief.preauthorised ?? []).map(
              (id) => `${step.nodeId}/${String(index)}/${id}`,
            ),
          };

          const itemOutcome = await runAutomation({
            ...deps,
            brief: itemBrief,
            seedCarried: text,
            finalize: false,
            depth: (deps.depth ?? 0) + 1,
          });

          const halted = itemOutcome.steps.find((one) => one.status !== 'succeeded');
          return halted
            ? { ok: false, output: `${halted.nodeId}: ${halted.output}` }
            : { ok: true, output: itemOutcome.output };
        },
      });

      trace.append({
        nodeId: step.nodeId,
        eventType: 'decision',
        payload: {
          decision: 'fanout:finished',
          items: items.length,
          succeeded: fanned.succeeded,
          failed: fanned.failed,
          peakInFlight: fanned.peakInFlight,
          concurrency: config.concurrency,
          ...(fanned.halted ? { haltReason: fanned.haltReason } : {}),
        },
      });

      // The successful items' answers, in input order, as one output. A
      // downstream aggregate step (M5-5) reduces them; without one, the list
      // itself is the honest answer.
      const collected = JSON.stringify(
        fanned.results.filter((result) => result.ok).map((result) => result.output),
      );
      outputs.set(step.nodeId, collected);
      carried = collected;

      return {
        ...base,
        iterations: fanned.results.length,
        status: fanned.halted ? 'denied' : 'succeeded',
        haltCause: fanned.halted ? 'limit' : 'completed',
        output: fanned.halted
          ? fanned.haltReason
          : `${String(fanned.succeeded)} of ${String(items.length)} items done${
              fanned.failed === 0 ? '' : `, ${String(fanned.failed)} failed`
            }.`,
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

  /**
   * Everything joined into a step, labelled.
   *
   * A node can have any number of inputs, and when it has several the answer to
   * "what did the previous step produce" is wrong twice over: there is no
   * single previous step, and a model handed three answers with no idea which
   * came from where cannot use them. Each is named by the agent that produced
   * it.
   *
   * With no inputs at all it falls back to what the run is carrying, which is
   * what a straight line has always meant.
   */
  const inputsFor = (nodeId: string): string => {
    const feeders = (sources.get(nodeId) ?? []).filter(
      (from) => !skipped.has(from) && outputs.has(from),
    );

    if (feeders.length === 0) {
      return carried === '' ? '' : `What the previous step produced:\n${carried}`;
    }

    if (feeders.length === 1) {
      const only = feeders[0] ?? '';
      return `What the previous step produced:\n${outputs.get(only) ?? ''}`;
    }

    const labelOf = (from: string): string => {
      const feeder = byId.get(from);
      if (!feeder) return from;
      const kind = feeder.type ?? 'agent';
      return kind === 'agent' && feeder.roleId !== '' ? `${feeder.roleId} (${from})` : from;
    };

    return [
      `This step has ${String(feeders.length)} inputs.`,
      ...feeders.map((from) => `--- from ${labelOf(from)} ---\n${outputs.get(from) ?? ''}`),
    ].join('\n\n');
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
    // A step this run already finished is replayed from its journal. The
    // checkpoint holds the output it produced, so there is nothing to ask a
    // model for and nothing to pay for.
    if (deps.resume === true && checkpoints.statusOf(runId, step.nodeId) === 'succeeded') {
      const journaled = checkpoints.load(runId, step.nodeId);
      if (journaled) {
        carried = journaled.output;
        outputs.set(step.nodeId, journaled.output);
        trace.append({
          nodeId: step.nodeId,
          eventType: 'decision',
          payload: { decision: 'resume:replayed' },
        });
        return {
          nodeId: step.nodeId,
          type: 'agent',
          roleId: step.roleId,
          status: 'succeeded',
          haltCause: 'completed',
          output: journaled.output,
          iterations: journaled.iteration,
        };
      }
    }

    // Where this step actually runs: what it names, or what this workspace
    // calls the tier it asked for.
    let binding = { connectionId: step.connectionId, model: step.model };
    if (step.tier !== undefined) {
      const resolved = deps.resolveTier?.(step.tier);
      if (!resolved || resolved.model === '' || resolved.connectionId === '') {
        return {
          nodeId: step.nodeId,
          type: 'agent',
          roleId: step.roleId,
          status: 'denied',
          haltCause: 'limit',
          output: `This step runs on the "${step.tier}" tier, and this workspace has not said which model that is. Set it in Providers.`,
          iterations: 0,
        };
      }
      binding = resolved;
    }

    const { adapter, options } = deps.providerFor(binding.connectionId);

    // What this step is told, and what it is given, are two different things.
    //
    // Told: its own instruction, or the brief's when it has none.
    //
    // Given: every input joined to it — and, for a step nothing feeds, the
    // brief itself. That last part was missing, and it was the bug that made
    // the product look broken: a brief holding the actual material (a pasted
    // contract, a list of invoices) was *replaced* by a step's own instruction
    // rather than added to it, so the first agent was asked to review a
    // contract it had never been shown. It answered, correctly, that no such
    // clause was in the text it had.
    const incoming = inputsFor(step.nodeId);
    const entryStep = (sources.get(step.nodeId) ?? []).length === 0;
    const ownInstruction = step.instruction.trim() !== '';

    const task = [
      ownInstruction ? step.instruction : brief.instruction,
      // The material, for the steps where material enters. A step with inputs
      // has already been given what it needs by the steps before it.
      entryStep && ownInstruction && brief.instruction.trim() !== ''
        ? `\n\nWhat this automation is working on:\n${brief.instruction}`
        : '',
      incoming === '' ? '' : `\n\n${incoming}`,
    ]
      .join('')
      .trim();

    const result = await runAgentLoop(
      {
        runId,
        nodeId: step.nodeId,
        role,
        task,
        placement: {
          automation: brief.name.trim() === '' ? 'this automation' : brief.name,
          goal: brief.instruction.trim() === '' ? step.instruction : brief.instruction,
          position: Math.max(
            1,
            agentSteps.findIndex((candidate) => candidate.nodeId === step.nodeId) + 1,
          ),
          total: agentSteps.length,
          upstream: (sources.get(step.nodeId) ?? []).map(stepLabel),
          downstream: (consumers.get(step.nodeId) ?? []).map(stepLabel),
        },
        connectionId: binding.connectionId,
        model: binding.model,
        depth: deps.depth ?? 0,
        // A person agreed to this node's actions if an approval node upstream
        // of it was granted — the run only reaches here if it was — or if the
        // automation pre-authorises the node by name.
        gated: gatedNodes.has(step.nodeId),
      },
      {
        governor,
        provider: adapter,
        tools,
        callOptions: options,
        checkpoints,
        trace,
        meter,
        ...(deps.cache ? { cache: deps.cache } : {}),
        // The files reach the steps where material enters — the ones nothing
        // feeds — rather than only the first in topological order. A graph with
        // three parallel first steps used to give the files to whichever
        // happened to sort first, and the other two worked blind. They are not
        // re-attached further downstream: those steps get the answers, and
        // re-paying for the same tokens at every hop is what a graph is for
        // avoiding.
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

  for (const step of order) {
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

    // Every entry point gets the brief's files, not just the first one.
    const isEntry = (sources.get(step.nodeId) ?? []).length === 0;
    const outcome = await runOne(step, isEntry);

    // A halted step halts the run. Carrying on would spend the next step's
    // budget on input the halted one never finished producing.
    if (outcome.status !== 'succeeded') break;
  }

  // What the run as a whole did. `last` is the final *agent* step's result, and
  // there may not have been one: a graph whose last step is a fan-out, a
  // transform or a branch has no agent loop to report, and reading a missing
  // one as "cancelled" told the user a finished run had been abandoned.
  const finalResult: LoopResult = last ?? {
    status:
      steps.length > 0 && steps.every((step) => step.status === 'succeeded')
        ? 'succeeded'
        : (steps.at(-1)?.status ?? 'cancelled'),
    haltCause: steps.at(-1)?.haltCause ?? 'cancelled',
    output: carried,
    iterations: steps.length,
    steps: [],
    observations: [],
    verification: null,
    structuredOutput: null,
  };
  const outcome =
    deps.finalize === false
      ? {
          status: (finalResult.status === 'succeeded' ? 'succeeded' : 'halted') as
            'succeeded' | 'halted',
          summary: null,
        }
      : finalizeRun(db, runId, finalResult);

  return { runId, status: outcome.status, summary: outcome.summary, steps, output: carried };
}
