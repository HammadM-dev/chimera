import type { NodeConfig, NodeType } from './nodeTypes.ts';

// What a run starts from: the instruction, the files, and the ordered steps.
// The canvas produces this and the executor consumes it — one shape, so a
// graph that can be drawn is a graph that can be run.

export interface BriefAttachment {
  name: string;
  path: string;
  kind: 'text' | 'image' | 'binary';
  /** Read at pick time. Empty when the file could not be read; `note` says why. */
  content: string;
  note: string;
}

export interface BriefStep {
  nodeId: string;
  /** What kind of node this is. Absent means `agent`, which is what every
   * brief written before the other types existed contains. */
  type?: NodeType;
  /** Per-type settings. Only the field matching `type` is read. */
  config?: NodeConfig;
  roleId: string;
  /** What this agent does here. Empty falls back to the brief's instruction. */
  instruction: string;
  connectionId: string;
  model: string;
}

export interface RunBrief {
  name: string;
  /** The overall instruction. Reaches the first step, and any step with none of its own. */
  instruction: string;
  attachments: BriefAttachment[];
  steps: BriefStep[];
  /** `[from, to]` node id pairs. Absent edges mean the steps run in the order given. */
  edges: [string, string][];
  /**
   * Steps the author has agreed may take irreversible actions without a gate.
   *
   * CLAUDE.md allows "a human-approval node or explicit workflow
   * pre-authorisation"; this is the second one. Per node and stored in the
   * saved file, so whoever opens the automation next can see it.
   */
  preauthorised?: string[];
  /** Where each node sits on the canvas. Not part of the run. */
  layout?: { nodeId: string; x: number; y: number }[];
}

export interface BriefProblem {
  nodeId: string | null;
  message: string;
  /**
   * When this problem stops the automation.
   *
   * `run` — the default — is a graph that is not finished yet: a step with no
   * model, an empty brief. Saving a draft in that state is the normal way to
   * work, and an editor that refused would be an editor people stopped using.
   *
   * `save` is a graph that must not exist as a file at all: an unbounded loop,
   * or a step that could act irreversibly with nothing gating it. The saved
   * file is the thing users send each other, so it is the thing that has to be
   * safe on its own.
   */
  stops?: 'save' | 'run';
}

/**
 * Everything wrong with a brief, all at once.
 *
 * All of them rather than the first: a user fixing one problem and being shown
 * the next is doing the validator's bookkeeping by hand.
 */
export function validateBrief(brief: RunBrief, knownRoles: readonly string[]): BriefProblem[] {
  const problems: BriefProblem[] = [];

  const agentSteps = brief.steps.filter((step) => (step.type ?? 'agent') === 'agent');
  // A subworkflow does the work too — by running agents of its own. The rule is
  // that something in the graph must act, not that it must act directly.
  const workSteps = brief.steps.filter((step) =>
    ['agent', 'subworkflow'].includes(step.type ?? 'agent'),
  );

  if (brief.steps.length === 0) {
    problems.push({ nodeId: null, message: 'Add at least one agent.' });
  } else if (workSteps.length === 0) {
    // The shaping types branch, repeat, reshape and pause a run. None of them
    // does the work, so a graph made only of them has nothing to shape.
    problems.push({
      nodeId: null,
      message:
        'Add at least one agent — the other node types shape a run, they do not do the work.',
    });
  }

  if (
    agentSteps.length > 0 &&
    brief.instruction.trim() === '' &&
    agentSteps.every((step) => step.instruction.trim() === '')
  ) {
    problems.push({
      nodeId: null,
      message: 'Write a brief, or give at least one step its own instruction.',
    });
  }

  for (const step of brief.steps) {
    const type = step.type ?? 'agent';

    // Only an agent step needs a role and a model. A condition that demanded
    // one would be asking the user to bind a model to something that makes no
    // model call.
    if (type === 'agent') {
      if (!knownRoles.includes(step.roleId)) {
        problems.push({ nodeId: step.nodeId, message: `No agent called "${step.roleId}".` });
      }
      if (step.model === '' || step.connectionId === '') {
        problems.push({ nodeId: step.nodeId, message: 'Choose a model for this step.' });
      }
    }

    if (type === 'loop') {
      const loop = step.config?.type === 'loop' ? step.config.loop : undefined;
      // CLAUDE.md: "Every loop node declares max iterations... The editor must
      // refuse to save without one." This is that refusal.
      if (!loop || !Number.isFinite(loop.maxIterations) || loop.maxIterations < 1) {
        problems.push({
          nodeId: step.nodeId,
          message: 'This loop needs a maximum number of iterations.',
          // CLAUDE.md: "The editor must refuse to save without one."
          stops: 'save',
        });
      } else if (loop.body.length === 0) {
        problems.push({ nodeId: step.nodeId, message: 'This loop has no steps to repeat.' });
      }
    }

    if (type === 'condition') {
      const condition = step.config?.type === 'condition' ? step.config.condition : undefined;
      if (!condition) {
        problems.push({ nodeId: step.nodeId, message: 'This branch has no test.' });
      } else if (condition.whenTrue.length === 0 && condition.whenFalse.length === 0) {
        problems.push({
          nodeId: step.nodeId,
          message: 'This branch goes nowhere — give it a step for at least one outcome.',
        });
      }
    }

    if (type === 'approval') {
      const approval = step.config?.type === 'approval' ? step.config.approval : undefined;
      if (!approval || approval.prompt.trim() === '') {
        problems.push({
          nodeId: step.nodeId,
          message: 'An approval step needs a question for the person approving it.',
        });
      }
    }

    if (type === 'subworkflow') {
      const child = step.config?.type === 'subworkflow' ? step.config.subworkflow : undefined;
      if (!child || child.workflowId === '') {
        problems.push({
          nodeId: step.nodeId,
          message: 'Choose an automation for this step to run.',
        });
      }
    }

    if (type === 'transform') {
      const transform = step.config?.type === 'transform' ? step.config.transform : undefined;
      if (!transform || transform.template.trim() === '') {
        problems.push({ nodeId: step.nodeId, message: 'This transform has no template.' });
      }
    }
  }

  return problems;
}

/**
 * Steps in execution order.
 *
 * A topological sort over the declared edges, falling back to the given order
 * for anything unjoined. A cycle is reported rather than hung on — CLAUDE.md's
 * no-unbounded-loops rule is about time, and a graph that waits forever for
 * itself is the same failure with a different shape.
 */
export function executionOrder(brief: RunBrief): { order: BriefStep[]; cycle: boolean } {
  const byId = new Map(brief.steps.map((step) => [step.nodeId, step]));
  const incoming = new Map(brief.steps.map((step) => [step.nodeId, 0]));
  const outgoing = new Map<string, string[]>();

  for (const [from, to] of brief.edges) {
    if (!byId.has(from) || !byId.has(to)) continue;
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
    outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
  }

  // Seeded in declaration order, so an unjoined graph runs top to bottom rather
  // than in whatever order a Map happens to iterate.
  const ready = brief.steps.filter((step) => (incoming.get(step.nodeId) ?? 0) === 0);
  const order: BriefStep[] = [];

  while (ready.length > 0) {
    const step = ready.shift();
    if (!step) break;
    order.push(step);
    for (const next of outgoing.get(step.nodeId) ?? []) {
      const remaining = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, remaining);
      const candidate = byId.get(next);
      if (remaining === 0 && candidate) ready.push(candidate);
    }
  }

  return { order, cycle: order.length !== brief.steps.length };
}
