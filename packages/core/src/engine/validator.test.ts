import test from 'node:test';
import assert from 'node:assert/strict';
import { STARTER_ROLES } from '../runtime/roleRegistry.ts';
import { validateForSave } from './validator.ts';
import type { RunBrief } from './runBrief.ts';

// M4-6. What the editor refuses to save, and — just as important — what it does
// not refuse, because a validator that cries wolf gets worked around.

function brief(over: Partial<RunBrief> = {}): RunBrief {
  return {
    name: 'test',
    instruction: 'do the thing',
    attachments: [],
    steps: [],
    edges: [],
    ...over,
  };
}

const step = (nodeId: string, roleId: string) => ({
  nodeId,
  type: 'agent' as const,
  roleId,
  instruction: '',
  connectionId: 'conn-1',
  model: 'mock-1',
});

const approval = (nodeId: string) => ({
  nodeId,
  type: 'approval' as const,
  config: { type: 'approval' as const, approval: { prompt: 'Go ahead?', showSource: '' } },
  roleId: '',
  instruction: '',
  connectionId: '',
  model: '',
});

test('a step that can run shell commands is refused when nothing gates it', () => {
  const problems = validateForSave(brief({ steps: [step('build', 'coder')] }), {
    roles: STARTER_ROLES,
  });

  const refusal = problems.find((problem) => problem.nodeId === 'build');
  assert.ok(refusal, 'a coder with shell access was allowed to run ungated');
  assert.match(refusal.message, /shell\.exec/);
  assert.match(refusal.message, /approval step|pre-authorise/);
});

test('an approval anywhere upstream is enough, however far back', () => {
  const problems = validateForSave(
    brief({
      steps: [step('plan', 'planner'), approval('gate'), step('build', 'coder')],
      edges: [
        ['plan', 'gate'],
        ['gate', 'build'],
      ],
    }),
    { roles: STARTER_ROLES },
  );

  assert.deepEqual(
    problems.filter((problem) => problem.nodeId === 'build'),
    [],
  );
});

test('pre-authorising the step is the other way past it', () => {
  const problems = validateForSave(brief({ steps: [step('build', 'coder')] }), {
    roles: STARTER_ROLES,
    preauthorised: ['build'],
  });

  assert.deepEqual(
    problems.filter((problem) => problem.nodeId === 'build'),
    [],
  );
});

test('a step that can only read is not refused', () => {
  // The researcher may fetch pages and read files. Neither is irreversible in
  // any way arguments cannot decide, so this must save without ceremony —
  // otherwise every automation anybody writes starts with a refusal.
  const problems = validateForSave(brief({ steps: [step('look', 'researcher')] }), {
    roles: STARTER_ROLES,
  });

  assert.deepEqual(problems, []);
});

test('a model that cannot call tools is refused for an agent that needs them', () => {
  const problems = validateForSave(brief({ steps: [step('look', 'researcher')] }), {
    roles: STARTER_ROLES,
    capabilities: {
      look: { toolCalling: 'unsupported', vision: 'unknown', structuredOutput: 'unknown' },
    },
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0]?.message ?? '', /cannot call tools/);
});

test('a model nothing is known about is not refused', () => {
  // The reversal M3 already made, restated here because this is the other place
  // it could be undone: a live catalogue reports `unknown` for nearly every
  // model, and refusing on absent knowledge refuses nearly everything.
  const problems = validateForSave(brief({ steps: [step('look', 'researcher')] }), {
    roles: STARTER_ROLES,
    capabilities: {
      look: { toolCalling: 'unknown', vision: 'unknown', structuredOutput: 'unknown' },
    },
  });

  assert.deepEqual(problems, []);
});
