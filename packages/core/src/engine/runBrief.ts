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
}

export interface BriefProblem {
  nodeId: string | null;
  message: string;
}

/**
 * Everything wrong with a brief, all at once.
 *
 * All of them rather than the first: a user fixing one problem and being shown
 * the next is doing the validator's bookkeeping by hand.
 */
export function validateBrief(brief: RunBrief, knownRoles: readonly string[]): BriefProblem[] {
  const problems: BriefProblem[] = [];

  if (brief.steps.length === 0) {
    problems.push({ nodeId: null, message: 'Add at least one agent.' });
  }
  if (
    brief.instruction.trim() === '' &&
    brief.steps.every((step) => step.instruction.trim() === '')
  ) {
    problems.push({
      nodeId: null,
      message: 'Write a brief, or give at least one step its own instruction.',
    });
  }

  for (const step of brief.steps) {
    if (!knownRoles.includes(step.roleId)) {
      problems.push({ nodeId: step.nodeId, message: `No agent called "${step.roleId}".` });
    }
    if (step.model === '' || step.connectionId === '') {
      problems.push({ nodeId: step.nodeId, message: 'Choose a model for this step.' });
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
