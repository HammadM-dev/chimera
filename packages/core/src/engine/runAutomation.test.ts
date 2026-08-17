import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runsRepository, tracesRepository } from '@chimera/store';
import { MockProvider, type ModelCapabilities } from '@chimera/providers';
import {
  connectInProcess,
  createFilesystemServer,
  createSandbox,
  createToolRegistry,
} from '@chimera/tools';
import { Governor } from '../governor/Governor.ts';
import { STARTER_ROLES } from '../runtime/roleRegistry.ts';
import { runAutomation } from './runAutomation.ts';
import type { RunBrief } from './runBrief.ts';

// The executor running a graph that is not a straight line: a branch, a
// transform, and a gate that waits for a person.

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'store',
  'src',
  'migrations',
);

const CAPS: ModelCapabilities = {
  modelId: 'mock-frontier',
  displayName: 'Mock',
  contextWindowTokens: 200_000,
  maxOutputTokens: 64_000,
  toolCalling: 'supported',
  vision: 'supported',
  streaming: 'supported',
  structuredOutput: 'supported',
  pricing: { kind: 'local' },
};

function open(runId: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-graph-'));
  const db = openDatabase({ dbPath: path.join(dir, 'w.sqlite'), migrationsDir });
  runsRepository.create(db, { id: runId });
  return { db, dir };
}

async function toolsFor(dir: string, runId: string) {
  const sandbox = createSandbox(path.join(dir, 'sandboxes'), runId);
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));
  return tools;
}

function agent(nodeId: string, roleId: string, instruction: string) {
  return {
    nodeId,
    type: 'agent' as const,
    roleId,
    instruction,
    connectionId: 'conn-1',
    model: 'mock-frontier',
  };
}

const shaping = (nodeId: string, config: RunBrief['steps'][number]['config']) => ({
  nodeId,
  type: config?.type ?? 'agent',
  config,
  roleId: '',
  instruction: '',
  connectionId: '',
  model: '',
});

function deps(db: ReturnType<typeof open>['db'], runId: string, brief: RunBrief, tools: unknown) {
  const provider = new MockProvider({
    script: { default: { kind: 'text', content: '{"verified": true, "evidence": "done"}' } },
  });
  return {
    db,
    runId,
    brief,
    roles: STARTER_ROLES,
    providerFor: () => ({
      adapter: provider,
      options: { authRef: 'vault:connection:0'.padEnd(48, '0') as never },
    }),
    tools: tools as never,
    governor: new Governor('enforcing', { capabilitiesFor: () => CAPS, stall: null }),
  };
}

test('a condition skips the branch it did not take, and says so in the trace', async () => {
  const { db, dir } = open('run-1');
  const tools = await toolsFor(dir, 'run-1');

  const brief: RunBrief = {
    name: 'branching',
    instruction: 'check and react',
    attachments: [],
    steps: [
      agent('check', 'researcher', 'Report the status.'),
      shaping('branch', {
        type: 'condition',
        condition: {
          source: 'check',
          test: 'contains',
          value: 'verified',
          whenTrue: ['on-pass'],
          whenFalse: ['on-fail'],
        },
      }),
      agent('on-pass', 'summariser', 'Summarise the pass.'),
      agent('on-fail', 'coder', 'Fix it.'),
    ],
    edges: [
      ['check', 'branch'],
      ['branch', 'on-pass'],
      ['branch', 'on-fail'],
    ],
  };

  try {
    const outcome = await runAutomation(deps(db, 'run-1', brief, tools));

    // The mock answers with JSON containing "verified", so the test passes,
    // the true branch runs and the false branch never does.
    const ran = outcome.steps.map((step) => step.nodeId);
    assert.deepEqual(ran, ['check', 'branch', 'on-pass']);
    assert.equal(ran.includes('on-fail'), false, 'the untaken branch still ran');

    const decisions = tracesRepository
      .listForRun(db, 'run-1')
      .filter((event) => event.eventType === 'decision')
      .map((event) => JSON.parse(event.payloadJson) as { decision: string; skipped?: string[] });
    const branch = decisions.find((payload) => payload.decision.startsWith('condition:'));
    assert.ok(branch, 'the branch is not in the trace');
    assert.deepEqual(branch.skipped, ['on-fail']);
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a transform joins earlier outputs without a model call', async () => {
  const { db, dir } = open('run-2');
  const tools = await toolsFor(dir, 'run-2');

  const brief: RunBrief = {
    name: 'joining',
    instruction: 'gather then report',
    attachments: [],
    steps: [
      agent('one', 'researcher', 'First.'),
      shaping('join', {
        type: 'transform',
        transform: { template: 'Findings: {{one}} / previous: {{previous}}' },
      }),
    ],
    edges: [['one', 'join']],
  };

  try {
    const outcome = await runAutomation(deps(db, 'run-2', brief, tools));
    const join = outcome.steps.find((step) => step.nodeId === 'join');
    assert.ok(join);
    assert.equal(join.type, 'transform');
    assert.match(join.output, /^Findings: .+ \/ previous: /);
    // No model call for it: the trace's response events all belong to the agent.
    const responses = tracesRepository
      .listForRun(db, 'run-2')
      .filter((event) => event.eventType === 'response');
    assert.equal(
      responses.every((event) => event.nodeId === 'one'),
      true,
    );
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an approval gate waits, and a refusal stops the run', async () => {
  const { db, dir } = open('run-3');
  const tools = await toolsFor(dir, 'run-3');

  const brief: RunBrief = {
    name: 'gated',
    instruction: 'draft then send',
    attachments: [],
    steps: [
      agent('draft', 'researcher', 'Draft the message.'),
      shaping('gate', {
        type: 'approval',
        approval: { prompt: 'Send this?', showSource: 'draft' },
      }),
      agent('send', 'coder', 'Send it.'),
    ],
    edges: [
      ['draft', 'gate'],
      ['gate', 'send'],
    ],
  };

  try {
    const asked: string[] = [];
    const outcome = await runAutomation({
      ...deps(db, 'run-3', brief, tools),
      requestApproval: (input) => {
        asked.push(input.prompt);
        return Promise.resolve({ approved: false, note: 'not yet' });
      },
    });

    assert.deepEqual(asked, ['Send this?']);
    // A refusal stops the run before the thing it was gating.
    assert.deepEqual(
      outcome.steps.map((step) => step.nodeId),
      ['draft', 'gate'],
    );
    assert.equal(outcome.steps[1]?.status, 'cancelled');
    assert.match(outcome.steps[1]?.output ?? '', /not yet/);
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an approval nobody can answer is a stop, not a pass', async () => {
  const { db, dir } = open('run-4');
  const tools = await toolsFor(dir, 'run-4');

  const brief: RunBrief = {
    name: 'ungated',
    instruction: 'draft then send',
    attachments: [],
    steps: [
      agent('draft', 'researcher', 'Draft it.'),
      shaping('gate', { type: 'approval', approval: { prompt: 'Send?', showSource: '' } }),
      agent('send', 'coder', 'Send it.'),
    ],
    edges: [
      ['draft', 'gate'],
      ['gate', 'send'],
    ],
  };

  try {
    // No `requestApproval`: a headless run, a closed window, an eval. CLAUDE.md
    // requires a gate for irreversible actions, and a gate nobody can answer
    // must not be treated as answered.
    const outcome = await runAutomation(deps(db, 'run-4', brief, tools));
    assert.equal(outcome.steps.at(-1)?.status, 'denied');
    assert.match(outcome.steps.at(-1)?.output ?? '', /nobody to ask/);
    assert.equal(
      outcome.steps.some((step) => step.nodeId === 'send'),
      false,
      'the gated step ran without approval',
    );
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a skipped branch takes everything downstream of it with it', async () => {
  const { db, dir } = open('run-5');
  const tools = await toolsFor(dir, 'run-5');

  const brief: RunBrief = {
    name: 'deep branch',
    instruction: 'check, then one path or the other',
    attachments: [],
    steps: [
      agent('check', 'researcher', 'Report.'),
      shaping('branch', {
        type: 'condition',
        condition: {
          source: 'check',
          test: 'contains',
          value: 'verified',
          whenTrue: ['pass-1'],
          whenFalse: ['fail-1'],
        },
      }),
      agent('pass-1', 'summariser', 'Summarise.'),
      agent('pass-2', 'summariser', 'Summarise again.'),
      agent('fail-1', 'coder', 'Fix.'),
      // Two steps deep on the branch that is not taken. Only `fail-1` is named
      // in the condition, so this is the one the naive implementation ran.
      agent('fail-2', 'coder', 'Fix harder.'),
    ],
    edges: [
      ['check', 'branch'],
      ['branch', 'pass-1'],
      ['pass-1', 'pass-2'],
      ['branch', 'fail-1'],
      ['fail-1', 'fail-2'],
    ],
  };

  try {
    const outcome = await runAutomation(deps(db, 'run-5', brief, tools));
    assert.deepEqual(
      outcome.steps.map((step) => step.nodeId),
      ['check', 'branch', 'pass-1', 'pass-2'],
    );
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a loop repeats its body up to its bound, and stops early when told to', async () => {
  const { db, dir } = open('run-6');
  const tools = await toolsFor(dir, 'run-6');

  const brief: RunBrief = {
    name: 'repeating',
    instruction: 'try three times',
    attachments: [],
    steps: [
      shaping('loop', {
        type: 'loop',
        loop: { body: ['work'], maxIterations: 3 },
      }),
      agent('work', 'coder', 'Do the work.'),
      agent('after', 'summariser', 'Wrap up.'),
    ],
    edges: [
      ['loop', 'work'],
      ['work', 'after'],
    ],
  };

  try {
    const outcome = await runAutomation(deps(db, 'run-6', brief, tools));
    // Three passes of the body, then the loop node — which reports after its
    // body because it is not finished until the body is — then the step after
    // it, which must run once rather than once per pass, and must not be
    // skipped for having a loop-owned step as its only input.
    assert.deepEqual(
      outcome.steps.map((step) => step.nodeId),
      ['work', 'work', 'work', 'loop', 'after'],
    );
    assert.equal(outcome.steps[3]?.iterations, 3);
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a loop stops at its exit condition rather than its bound', async () => {
  const { db, dir } = open('run-7');
  const tools = await toolsFor(dir, 'run-7');

  const brief: RunBrief = {
    name: 'repeating until',
    instruction: 'until verified',
    attachments: [],
    steps: [
      shaping('loop', {
        type: 'loop',
        loop: {
          body: ['work'],
          maxIterations: 50,
          // The mock answers with "verified" every time, so this holds on the
          // first pass. A bound of 50 that ran 50 times would be the bug.
          until: {
            source: '',
            test: 'contains',
            value: 'verified',
            whenTrue: [],
            whenFalse: [],
          },
        },
      }),
      agent('work', 'coder', 'Do the work.'),
    ],
    edges: [['loop', 'work']],
  };

  try {
    const outcome = await runAutomation(deps(db, 'run-7', brief, tools));
    assert.equal(outcome.steps.filter((step) => step.nodeId === 'work').length, 1);

    const decision = tracesRepository
      .listForRun(db, 'run-7')
      .map((event) => JSON.parse(event.payloadJson) as { decision?: string; reason?: string })
      .find((payload) => payload.decision === 'loop:finished');
    assert.equal(decision?.reason, 'exit-condition');
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
