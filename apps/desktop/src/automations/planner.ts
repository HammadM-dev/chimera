import { ProviderError } from '@chimera/errors';
import { adapterFor, textOf } from '@chimera/providers';
import { createGovernor, enforceOutputContract } from '@chimera/core';
import { alwaysIrreversibleTools } from '@chimera/tools';
import { listRoles } from '../roles/service.ts';
import { listFacts, rememberDesign } from '../memory/service.ts';
import { connectionFor } from '../providers/service.ts';

// Turns "what I want automated" into a draft automation.
//
// The model chooses which agents, what each is told, and — since this rewrite —
// how they are wired to each other. It used to answer with a flat list, which
// the canvas joined end to end, so every automation this product designed was a
// straight line of three or four steps no matter what was asked for. Real work
// is not a line: three people read three documents at once and a fourth writes
// the note.
//
// Two things it is not trusted with. It is told the rules an automation has to
// satisfy, and then the plan is checked against those rules here and repaired
// where it falls short — a draft that cannot be run is worse than no draft,
// because the person only finds out after they have arranged their work around
// it.

export type PlannedKind = 'agent' | 'approval';

export interface PlannedStep {
  /** Stable within one plan; the edges refer to these. */
  id: string;
  kind: PlannedKind;
  /** Empty for an approval step. */
  roleId: string;
  instruction: string;
}

export interface PlannedAutomation {
  name: string;
  summary: string;
  steps: PlannedStep[];
  /** [from, to] pairs over step ids. */
  edges: [string, string][];
}

const SCHEMA = {
  type: 'object',
  required: ['name', 'summary', 'steps'],
  properties: {
    name: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'roleId', 'instruction'],
        properties: {
          id: { type: 'string', minLength: 1 },
          kind: { type: 'string' },
          roleId: { type: 'string' },
          instruction: { type: 'string', minLength: 1 },
        },
      },
    },
    edges: {
      type: 'array',
      items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
    },
  },
};

/** The most copies of one agent that may feed a step which does not combine. */
const MAX_SAME_AGENT_INPUTS = 3;

interface RoleFacts {
  id: string;
  name: string;
  systemPrompt: string;
  toolAllowlist: string[];
  combinesMany: boolean;
  /** Tools this role holds that cannot be undone, so it needs a gate. */
  irreversible: string[];
}

function rosterFacts(): RoleFacts[] {
  return listRoles().roles.map((role) => ({
    id: role.id,
    name: role.name,
    systemPrompt: role.systemPrompt,
    toolAllowlist: [...role.toolAllowlist],
    combinesMany: role.combinesMany,
    irreversible: alwaysIrreversibleTools(role.toolAllowlist),
  }));
}

/**
 * What CHIMERA has learned about this workspace, for the plan to take account of.
 *
 * Only workspace facts, which are short and stated rather than inferred. The
 * run-scoped agent memory is deliberately not read here: it is long, it is
 * about particular documents rather than about the person, and a planner that
 * quoted it back would be recalling somebody's invoice numbers at them while
 * they describe a new automation.
 */
function knownAboutTheUser(): string {
  const facts = listFacts().facts.slice(0, 40);
  if (facts.length === 0) return '';
  return [
    '',
    'What CHIMERA already knows about this workspace. Prefer these over your own assumptions,',
    'and do not ask the user to restate any of it:',
    ...facts.map((fact) => `- ${fact.key}: ${fact.value}`),
  ].join('\n');
}

function catalogueOf(roster: RoleFacts[]): string {
  return roster
    .map((role) => {
      const tools = role.toolAllowlist.length === 0 ? 'none' : role.toolAllowlist.join(', ');
      const notes = [
        role.combinesMany ? 'takes many inputs' : '',
        role.irreversible.length === 0 ? '' : `NEEDS A GATE (${role.irreversible.join(', ')})`,
      ].filter((note) => note !== '');
      return `- ${role.id}: ${role.name}. ${role.systemPrompt} Tools: ${tools}.${
        notes.length === 0 ? '' : ` [${notes.join('; ')}]`
      }`;
    })
    .join('\n');
}

function systemPromptFor(roster: RoleFacts[]): string {
  const combiners = roster.filter((role) => role.combinesMany).map((role) => role.id);
  const gated = roster.filter((role) => role.irreversible.length > 0).map((role) => role.id);

  return [
    'You design automations for CHIMERA. You choose agents from a fixed roster, say what each one',
    'does, and wire them to each other. The result is a graph, not a list.',
    '',
    'The roster, and it is the whole roster — every roleId you use must appear here:',
    catalogueOf(roster),
    knownAboutTheUser(),
    '',
    'How to design one.',
    'Use as many steps as the work honestly needs. A real automation is usually five to fifteen',
    'steps; a request that describes a large job should get a large automation, and saying the same',
    'thing in four steps that the user asked to have done in twenty is not concision, it is a worse',
    'answer. Do not pad either: every step must do something the others do not.',
    'Work that does not depend on other work runs at the same time. Give those steps no edge',
    'between them and feed them all into one step that combines their answers.',
    'Break big jobs into named parts rather than one agent told to "handle it".',
    '',
    'Rules the automation must satisfy. A plan that breaks one of these cannot be run:',
    `1. These agents can do things that cannot be undone: ${gated.length === 0 ? 'none' : gated.join(', ')}.`,
    '   Every one of them must have an approval step immediately before it, so a person says yes',
    '   before anything is sent, published, bought, deleted or executed. An approval step has',
    '   kind "approval", an empty roleId, and an instruction that is the question the person is',
    '   asked — name what is about to happen and what it affects.',
    `2. At most ${String(MAX_SAME_AGENT_INPUTS)} steps using the same agent may feed one step, unless that step is an`,
    `   agent built to combine: ${combiners.length === 0 ? 'none' : combiners.join(', ')}. To gather more than that, feed`,
    '   them into one of those instead.',
    '3. Every step needs a concrete instruction naming what it produces. Not a restatement of the',
    "   agent's job, and not 'assist with the task'.",
    '4. Every edge must join two steps that exist, and the graph must not loop back on itself.',
    '5. If the work needs checking, end with a reviewer or a qa step. Most useful automations do.',
    '',
    'Answer with JSON only:',
    '{"name": string, "summary": string,',
    ' "steps": [{"id": string, "kind": "agent" | "approval", "roleId": string, "instruction": string}],',
    ' "edges": [[fromId, toId], ...]}',
    'Step ids are short and readable, like "research-suppliers" or "approve-send".',
    'The summary is one or two sentences a person reads to decide whether this is what they meant.',
  ].join('\n');
}

/**
 * Makes the plan satisfy the rules it was told about, whatever it answered.
 *
 * The model is asked for a legal graph and frequently returns very nearly one:
 * the commonest miss by far is an agent that can act irreversibly with no gate
 * in front of it, which is exactly the failure a person hits at the end, on the
 * canvas, when the automation refuses to run. Repairing it here means the draft
 * that arrives is a draft that works.
 */
export function repairPlan(planned: PlannedAutomation, roster: RoleFacts[]): PlannedAutomation {
  const byId = new Map(roster.map((role) => [role.id, role]));

  // Steps naming an agent that does not exist are dropped rather than rendered
  // as a node that cannot be built. Dropping is visible; a broken node is not.
  const steps = planned.steps.filter(
    (step) => (step.kind === 'approval' ? true : byId.has(step.roleId)) && step.id !== '',
  );
  const live = new Set(steps.map((step) => step.id));

  let edges = (planned.edges ?? []).filter(
    ([from, to]) => live.has(from) && live.has(to) && from !== to,
  );

  // No step may reach itself. A cycle is refused at save time, and a draft that
  // cannot be saved is the thing this function exists to prevent.
  edges = withoutCycles(edges);

  const feeders = new Map<string, string[]>();
  for (const [from, to] of edges) feeders.set(to, [...(feeders.get(to) ?? []), from]);

  // ---- rule 1: a gate before anything that cannot be undone ---------------
  const gatedSteps = steps.filter(
    (step) => step.kind === 'agent' && (byId.get(step.roleId)?.irreversible.length ?? 0) > 0,
  );
  const repaired = [...steps];
  for (const step of gatedSteps) {
    const already = (feeders.get(step.id) ?? []).some(
      (from) => steps.find((candidate) => candidate.id === from)?.kind === 'approval',
    );
    if (already) continue;

    const role = byId.get(step.roleId);
    const gateId = `approve-${step.id}`;
    repaired.push({
      id: gateId,
      kind: 'approval',
      roleId: '',
      instruction: `${role?.name ?? step.roleId} is about to run a step that cannot be undone (${
        role?.irreversible.join(', ') ?? ''
      }). Approve it?`,
    });

    // The gate takes the step's inputs and the step takes the gate, so the
    // approval happens after the work that informs it and before the act.
    const inbound = feeders.get(step.id) ?? [];
    edges = edges.filter(([, to]) => to !== step.id);
    for (const from of inbound) edges.push([from, gateId]);
    edges.push([gateId, step.id]);
    feeders.set(step.id, [gateId]);
    feeders.set(gateId, inbound);
  }

  // ---- rule 2: no more than three of one agent into a non-combiner --------
  const stepById = new Map(repaired.map((step) => [step.id, step]));
  for (const [target, sources] of feeders) {
    const targetStep = stepById.get(target);
    if (!targetStep || targetStep.kind !== 'agent') continue;
    if (byId.get(targetStep.roleId)?.combinesMany === true) continue;

    const counts = new Map<string, string[]>();
    for (const from of sources) {
      const roleId = stepById.get(from)?.roleId ?? '';
      counts.set(roleId, [...(counts.get(roleId) ?? []), from]);
    }
    for (const [, sameRole] of counts) {
      if (sameRole.length <= MAX_SAME_AGENT_INPUTS) continue;
      // Everything past the limit is dropped rather than rewired through an
      // invented combiner: an edge the user did not ask for is easier to see
      // and undo than a step they did not ask for.
      for (const from of sameRole.slice(MAX_SAME_AGENT_INPUTS)) {
        edges = edges.filter(([source, to]) => !(source === from && to === target));
      }
    }
  }

  return { name: planned.name, summary: planned.summary, steps: repaired, edges };
}

/** Drops the edges that would close a loop, keeping the earlier ones. */
function withoutCycles(edges: [string, string][]): [string, string][] {
  const kept: [string, string][] = [];
  const reachable = new Map<string, Set<string>>();

  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const at = stack.pop() as string;
      if (at === to) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const next of reachable.get(at) ?? []) stack.push(next);
    }
    return false;
  };

  for (const [from, to] of edges) {
    if (reaches(to, from)) continue;
    kept.push([from, to]);
    reachable.set(from, new Set([...(reachable.get(from) ?? []), to]));
  }
  return kept;
}

/**
 * Designs an automation from a description.
 *
 * A failure here is usually the gateway's, not ours — a 502 from OmniRoute
 * means the upstream provider it routes to refused or is not configured for
 * that model. The adapter's error carries the provider's own message, and it
 * is passed through rather than replaced with something tidier, because
 * "OmniRoute returned 502" is the sentence that tells the user to check which
 * model they picked.
 */
export async function planAutomation(input: {
  connectionId: string;
  model: string;
  description: string;
}): Promise<PlannedAutomation> {
  const roster = rosterFacts();
  if (roster.length === 0) throw new ProviderError('PLANNER_NO_ROLES', 'No agents are available.');

  const connection = connectionFor(input.connectionId);
  const adapter = adapterFor(connection.kind);
  const options = {
    authRef: connection.authRef,
    ...(connection.baseUrl === null ? {} : { baseUrl: connection.baseUrl }),
  };

  const system = systemPromptFor(roster);

  // The Governor is on this path like every other model call. Permissive here:
  // planning is a single call the user explicitly asked for, and the enforcing
  // policy belongs to a run, which this is not.
  const governor = createGovernor();

  const result = await enforceOutputContract(
    { schema: SCHEMA, onInvalid: 'repair_once' },
    async (repair) => {
      const authorization = governor.authorizeModelCall({
        runId: 'planner',
        nodeId: 'planner',
        roleId: 'planner',
        iteration: 0,
        depth: 0,
        purpose: 'plan',
        connectionId: input.connectionId,
        model: input.model,
        estimatedInputTokens: Math.ceil((system.length + input.description.length) / 4),
        // A graph of a dozen steps with real instructions does not fit in the
        // 800 the flat list needed.
        estimatedOutputTokens: 2_400,
        requiredCapabilities: [],
      });
      if (authorization.decision === 'deny') {
        throw new ProviderError('PLANNER_DENIED', authorization.message);
      }

      const response = await adapter.chat(
        {
          model: authorization.request.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: input.description },
            ...(repair === null ? [] : [{ role: 'user' as const, content: repair }]),
          ],
        },
        options,
      );
      return textOf(response);
    },
  );

  const answered = result.value as {
    name: string;
    summary: string;
    steps: { id: string; kind?: string; roleId: string; instruction: string }[];
    edges?: [string, string][];
  };

  const planned: PlannedAutomation = {
    name: answered.name,
    summary: answered.summary,
    steps: answered.steps.map((step) => ({
      id: step.id,
      kind: step.kind === 'approval' ? 'approval' : 'agent',
      roleId: step.kind === 'approval' ? '' : step.roleId,
      instruction: step.instruction,
    })),
    edges: answered.edges ?? [],
  };

  // A plan with no edges at all is a plan the model wrote as a list. Joining it
  // end to end is what the canvas used to do for every plan, and it is the
  // right reading of a list — but only when there is no graph on offer.
  if (planned.edges.length === 0 && planned.steps.length > 1) {
    planned.edges = planned.steps
      .slice(1)
      .map((step, index) => [planned.steps[index]?.id ?? '', step.id] as [string, string]);
  }

  const repaired = repairPlan(planned, roster);

  // What this workspace automates, so the next plan knows. Written after the
  // repair, so what is remembered is what the person will actually be shown.
  try {
    rememberDesign(
      `automation: ${repaired.name}`,
      `${repaired.summary} (${String(repaired.steps.length)} steps, asked for as: ${input.description.slice(0, 200)})`,
    );
  } catch {
    // A plan that cannot be remembered is still a plan. Memory is an
    // improvement to the next design, not a condition of this one.
  }

  return repaired;
}
