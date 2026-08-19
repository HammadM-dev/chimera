import test from 'node:test';
import assert from 'node:assert/strict';
import { repairPlan, type PlannedAutomation } from './planner.ts';

// The planner is told the rules and then checked against them, because a draft
// that cannot be run is worse than no draft: the person only finds out after
// they have arranged their work around it. Hammad's report — an automation the
// product designed, refusing to run because it had no approval step before the
// coder — is the first test here.

const roster = [
  {
    id: 'researcher',
    name: 'Researcher',
    systemPrompt: 'You answer from sources.',
    toolAllowlist: ['http.request'],
    combinesMany: false,
    irreversible: [],
  },
  {
    id: 'coder',
    name: 'Coder',
    systemPrompt: 'You write code.',
    toolAllowlist: ['shell.exec', 'filesystem.*'],
    combinesMany: false,
    irreversible: ['shell.exec'],
  },
  {
    id: 'summariser',
    name: 'Summariser',
    systemPrompt: 'You compress text.',
    toolAllowlist: [],
    combinesMany: true,
    irreversible: [],
  },
  {
    id: 'data-extractor',
    name: 'Data extractor',
    systemPrompt: 'You pull records.',
    toolAllowlist: ['filesystem.readFile'],
    combinesMany: false,
    irreversible: [],
  },
];

function plan(over: Partial<PlannedAutomation>): PlannedAutomation {
  return { name: 'n', summary: 's', steps: [], edges: [], ...over };
}

test('an agent that cannot undo what it does gets a gate in front of it', () => {
  const repaired = repairPlan(
    plan({
      steps: [
        { id: 'research', kind: 'agent', roleId: 'researcher', instruction: 'Find the bug.' },
        { id: 'fix', kind: 'agent', roleId: 'coder', instruction: 'Fix it.' },
      ],
      edges: [['research', 'fix']],
    }),
    roster,
  );

  const gate = repaired.steps.find((step) => step.kind === 'approval');
  assert.ok(gate, 'the coder holds shell.exec, so something must ask first');
  // The question names what is about to happen, rather than saying "approve?".
  assert.match(gate.instruction, /Coder/);
  assert.match(gate.instruction, /shell\.exec/);

  // The gate sits between the research and the fix, not beside them: the
  // person is asked after the work that informs the decision and before the
  // act it authorises.
  assert.deepEqual(
    repaired.edges.filter(([, to]) => to === 'fix'),
    [[gate.id, 'fix']],
  );
  assert.deepEqual(
    repaired.edges.filter(([, to]) => to === gate.id),
    [['research', gate.id]],
  );
});

test('a gate the plan already has is left alone', () => {
  const repaired = repairPlan(
    plan({
      steps: [
        { id: 'ask', kind: 'approval', roleId: '', instruction: 'Run the fix?' },
        { id: 'fix', kind: 'agent', roleId: 'coder', instruction: 'Fix it.' },
      ],
      edges: [['ask', 'fix']],
    }),
    roster,
  );

  assert.equal(repaired.steps.filter((step) => step.kind === 'approval').length, 1);
});

test('a fourth copy of one agent into a step that does not combine is unjoined', () => {
  const steps = [0, 1, 2, 3].map((index) => ({
    id: `research-${String(index)}`,
    kind: 'agent' as const,
    roleId: 'researcher',
    instruction: `Angle ${String(index)}.`,
  }));
  const repaired = repairPlan(
    plan({
      steps: [
        ...steps,
        { id: 'pull', kind: 'agent', roleId: 'data-extractor', instruction: 'Pull the numbers.' },
      ],
      edges: steps.map((step) => [step.id, 'pull'] as [string, string]),
    }),
    roster,
  );

  assert.equal(repaired.edges.filter(([, to]) => to === 'pull').length, 3);
});

test('as many as it likes may feed an agent built to combine', () => {
  const steps = [0, 1, 2, 3, 4, 5].map((index) => ({
    id: `research-${String(index)}`,
    kind: 'agent' as const,
    roleId: 'researcher',
    instruction: `Angle ${String(index)}.`,
  }));
  const repaired = repairPlan(
    plan({
      steps: [
        ...steps,
        { id: 'note', kind: 'agent', roleId: 'summariser', instruction: 'Write the note.' },
      ],
      edges: steps.map((step) => [step.id, 'note'] as [string, string]),
    }),
    roster,
  );

  assert.equal(repaired.edges.filter(([, to]) => to === 'note').length, 6);
});

test('a step naming an agent that does not exist is dropped, and its edges with it', () => {
  const repaired = repairPlan(
    plan({
      steps: [
        { id: 'real', kind: 'agent', roleId: 'researcher', instruction: 'Find it.' },
        { id: 'invented', kind: 'agent', roleId: 'lawyer', instruction: 'Advise.' },
      ],
      edges: [['real', 'invented']],
    }),
    roster,
  );

  assert.deepEqual(
    repaired.steps.map((step) => step.id),
    ['real'],
  );
  assert.equal(repaired.edges.length, 0);
});

test('a graph that loops back on itself is opened up, not passed on', () => {
  const repaired = repairPlan(
    plan({
      steps: [
        { id: 'a', kind: 'agent', roleId: 'researcher', instruction: 'One.' },
        { id: 'b', kind: 'agent', roleId: 'data-extractor', instruction: 'Two.' },
        { id: 'c', kind: 'agent', roleId: 'summariser', instruction: 'Three.' },
      ],
      edges: [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
    }),
    roster,
  );

  // The edge that closed the loop is the one that goes; a run refuses a cyclic
  // graph outright, so a plan carrying one cannot be saved at all.
  assert.equal(repaired.edges.length, 2);
  assert.equal(
    repaired.edges.some(([from, to]) => from === 'c' && to === 'a'),
    false,
  );
});

test('parallel branches survive: the repair does not flatten a graph into a line', () => {
  const repaired = repairPlan(
    plan({
      steps: [
        { id: 'r1', kind: 'agent', roleId: 'researcher', instruction: 'Angle one.' },
        { id: 'r2', kind: 'agent', roleId: 'data-extractor', instruction: 'Angle two.' },
        { id: 'note', kind: 'agent', roleId: 'summariser', instruction: 'Combine.' },
      ],
      edges: [
        ['r1', 'note'],
        ['r2', 'note'],
      ],
    }),
    roster,
  );

  assert.equal(repaired.edges.length, 2);
  assert.equal(repaired.steps.length, 3);
});
