import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applyTransform, evaluateCondition, NODE_KINDS } from './nodeTypes.ts';
import { validateBrief, type RunBrief } from './runBrief.ts';

// M4-3 and M4-6: the shaping node types, and the save-time rules that refuse a
// graph which cannot safely run.

function brief(steps: RunBrief['steps']): RunBrief {
  return { name: 'a', instruction: 'do the thing', attachments: [], steps, edges: [] };
}

function agentStep(nodeId: string) {
  return {
    nodeId,
    type: 'agent' as const,
    roleId: 'coder',
    instruction: 'work',
    connectionId: 'c',
    model: 'm',
  };
}

test('a condition tests a declared comparison, never an expression', () => {
  const config = {
    source: '',
    test: 'contains' as const,
    value: 'FAIL',
    whenTrue: [],
    whenFalse: [],
  };
  assert.equal(evaluateCondition(config, 'the build did FAIL'), true);
  assert.equal(evaluateCondition(config, 'all green'), false);
  // Case-insensitive, because a model's capitalisation is not a decision the
  // user made.
  assert.equal(evaluateCondition(config, 'the build did fail'), true);

  assert.equal(evaluateCondition({ ...config, test: 'isEmpty' }, '   '), true);
  assert.equal(evaluateCondition({ ...config, test: 'notEmpty' }, 'x'), true);
  assert.equal(evaluateCondition({ ...config, test: 'equals', value: 'ok' }, ' ok '), true);
  assert.equal(evaluateCondition({ ...config, test: 'matches', value: '^\\d+$' }, '42'), true);
});

test('a malformed pattern fails the branch rather than the run', () => {
  // The condition is data out of a saved file, and a saved file is the thing
  // users send each other. A bad pattern must not become an exception.
  const config = {
    source: '',
    test: 'matches' as const,
    value: '([',
    whenTrue: [],
    whenFalse: [],
  };
  assert.doesNotThrow(() => evaluateCondition(config, 'anything'));
  assert.equal(evaluateCondition(config, 'anything'), false);
});

test('a transform fills named outputs and leaves unknown ones empty', () => {
  const outputs = new Map([
    ['research', 'found three sources'],
    ['previous', 'the last answer'],
  ]);
  assert.equal(
    applyTransform({ template: 'Report: {{research}} — and {{previous}}' }, outputs),
    'Report: found three sources — and the last answer',
  );
  // An unknown id renders empty rather than leaving the placeholder visible: a
  // literal `{{typo}}` reaching a model is a prompt with a bug in it.
  assert.equal(applyTransform({ template: 'A{{missing}}B' }, outputs), 'AB');
});

test('a loop without a bound cannot be saved', () => {
  // CLAUDE.md: "Every loop node declares max iterations... The editor must
  // refuse to save without one."
  const unbounded = brief([
    agentStep('a'),
    {
      nodeId: 'l',
      type: 'loop',
      config: { type: 'loop', loop: { body: ['a'], maxIterations: 0 } },
      roleId: '',
      instruction: '',
      connectionId: '',
      model: '',
    },
  ]);
  const problems = validateBrief(unbounded, ['coder']);
  assert.ok(problems.some((problem) => problem.message.includes('maximum number of iterations')));
  assert.equal(problems[0]?.nodeId, 'l');
});

test('a non-agent step is not asked for a model', () => {
  // A condition that demanded a model binding would be asking the user to bind
  // one to something that makes no model call.
  const graph = brief([
    agentStep('a'),
    {
      nodeId: 'c',
      type: 'condition',
      config: {
        type: 'condition',
        condition: { source: 'a', test: 'notEmpty', value: '', whenTrue: ['a'], whenFalse: [] },
      },
      roleId: '',
      instruction: '',
      connectionId: '',
      model: '',
    },
  ]);
  assert.deepEqual(validateBrief(graph, ['coder']), []);
});

test('a graph of only shaping steps is refused', () => {
  const noWork = brief([
    {
      nodeId: 't',
      type: 'transform',
      config: { type: 'transform', transform: { template: '{{previous}}' } },
      roleId: '',
      instruction: '',
      connectionId: '',
      model: '',
    },
  ]);
  const problems = validateBrief(noWork, ['coder']);
  assert.ok(problems.some((problem) => problem.message.includes('Add at least one agent')));
});

test('every problem is reported at once, not the first', () => {
  // A user fixing one and being shown the next is doing the validator's
  // bookkeeping by hand.
  const broken = brief([
    { ...agentStep('a'), roleId: 'nobody', model: '' },
    {
      nodeId: 'p',
      type: 'approval',
      config: { type: 'approval', approval: { prompt: '', showSource: '' } },
      roleId: '',
      instruction: '',
      connectionId: '',
      model: '',
    },
  ]);
  const problems = validateBrief(broken, ['coder']);
  assert.ok(problems.length >= 3, `expected several problems, got ${String(problems.length)}`);
  assert.ok(problems.some((problem) => problem.message.includes('No agent called')));
  assert.ok(problems.some((problem) => problem.message.includes('Choose a model')));
  assert.ok(problems.some((problem) => problem.message.includes('needs a question')));
});

test('every node kind the engine knows can be drawn', () => {
  // Not a test of the engine — a test of the join between it and the canvas.
  // React Flow silently renders nothing for a node whose `type` it has no
  // component for, so a kind added to the engine and not to `NODE_TYPES`
  // produces a canvas where clicking the palette does nothing at all, with no
  // error anywhere. That is exactly what happened to `swarm`.
  const drawn = readFileSync(
    path.join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'apps',
      'ui',
      'src',
      'views',
      'CanvasView.tsx',
    ),
    'utf8',
  );
  const registry = /const NODE_TYPES = \{([\s\S]*?)\};/.exec(drawn)?.[1] ?? '';
  assert.notEqual(registry, '', 'could not find NODE_TYPES in CanvasView.tsx');

  const missing = NODE_KINDS.filter((kind) => !new RegExp(`\\b${kind}:`).test(registry));
  assert.deepEqual(
    missing,
    [],
    `these kinds exist in the engine and cannot be drawn: ${missing.join(', ')}`,
  );
});
