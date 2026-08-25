import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDatabase,
  runsRepository,
  tracesRepository,
  workflowsRepository,
} from '@chimera/store';
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
import type { BriefStep, RunBrief } from './runBrief.ts';
import { normaliseType } from './runBrief.ts';

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

function shaping(nodeId: string, config: NonNullable<BriefStep['config']>): BriefStep {
  return {
    nodeId,
    type: config.type,
    config,
    roleId: '',
    instruction: '',
    connectionId: '',
    model: '',
  };
}

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

test('a subworkflow runs the saved automation it names, under this run', async () => {
  const { db, dir } = open('run-8');
  const tools = await toolsFor(dir, 'run-8');

  // A child automation, saved the way the canvas saves one.
  const child: RunBrief = {
    name: 'child',
    instruction: 'do the inner thing',
    attachments: [],
    steps: [agent('inner', 'researcher', 'Look it up.')],
    edges: [],
  };
  const saved = workflowsRepository.save(db, {
    name: 'child',
    definitionJson: JSON.stringify(child),
  });

  const parent: RunBrief = {
    name: 'parent',
    instruction: 'call the child, then summarise',
    attachments: [],
    steps: [
      agent('start', 'researcher', 'Start.'),
      shaping('call', {
        type: 'subworkflow',
        subworkflow: { workflowId: saved.workflowId, version: '' },
      }),
      agent('finish', 'summariser', 'Summarise.'),
    ],
    edges: [
      ['start', 'call'],
      ['call', 'finish'],
    ],
  };

  try {
    const outcome = await runAutomation(deps(db, 'run-8', parent, tools));

    // The child's step ran, named under the node that called it — node ids are
    // unique within an automation, not across them, and the journal keys on
    // (run, node).
    assert.deepEqual(
      outcome.steps.map((step) => step.nodeId),
      ['start', 'call/inner', 'call', 'finish'],
    );

    const decision = tracesRepository
      .listForRun(db, 'run-8')
      .map((event) => JSON.parse(event.payloadJson) as { decision?: string; depth?: number })
      .find((payload) => payload.decision === 'subworkflow:started');
    assert.equal(decision?.depth, 1);
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an automation that contains itself stops rather than recursing', async () => {
  const { db, dir } = open('run-9');
  const tools = await toolsFor(dir, 'run-9');

  // Saved first with a placeholder, then rewritten to call itself: the shape a
  // user reaches by editing an automation that something else already calls.
  const placeholder: RunBrief = {
    name: 'self',
    instruction: 'go',
    attachments: [],
    steps: [agent('work', 'researcher', 'Work.')],
    edges: [],
  };
  const saved = workflowsRepository.save(db, {
    name: 'self',
    definitionJson: JSON.stringify(placeholder),
  });

  const recursive: RunBrief = {
    name: 'self',
    instruction: 'go',
    attachments: [],
    steps: [
      agent('work', 'researcher', 'Work.'),
      shaping('again', {
        type: 'subworkflow',
        subworkflow: { workflowId: saved.workflowId, version: '' },
      }),
    ],
    edges: [['work', 'again']],
  };
  workflowsRepository.save(db, {
    workflowId: saved.workflowId,
    name: 'self',
    definitionJson: JSON.stringify(recursive),
  });

  try {
    const outcome = await runAutomation(deps(db, 'run-9', recursive, tools));

    // It stops at the engine's bound rather than running until the process
    // dies. The Governor's own depth limit defaults to none, so this bound is
    // the one that has to hold.
    const denied = outcome.steps.find((step) => step.status === 'denied');
    assert.ok(denied, 'the recursion was never refused');
    assert.match(denied.output, /nested 5 deep|contains itself/);
    assert.ok(outcome.steps.length < 20, 'it recursed further than it should have');
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fan-out runs its body over every item the step before produced', async () => {
  const { db, dir } = open('run-10');
  const tools = await toolsFor(dir, 'run-10');

  const brief: RunBrief = {
    name: 'fanned',
    instruction: 'list them, then handle each',
    attachments: [],
    steps: [
      agent('list', 'researcher', 'List the invoices.'),
      shaping('each', {
        type: 'fanout',
        fanout: {
          source: 'items',
          parse: 'json',
          body: ['handle'],
          concurrency: 3,
          maxItems: 100,
          onItemError: 'continue',
          deadLetterLimit: 10,
        },
      }),
      agent('handle', 'summariser', 'Handle this one.'),
    ],
    edges: [
      ['list', 'each'],
      ['each', 'handle'],
    ],
  };

  try {
    // The item list comes from a transform rather than the model, so the test
    // is about the fan-out rather than about what a mock happened to say.
    brief.steps.splice(
      1,
      0,
      shaping('items', { type: 'transform', transform: { template: '["a","b","c","d"]' } }),
    );
    brief.edges.push(['list', 'items'], ['items', 'each']);

    const outcome = await runAutomation(deps(db, 'run-10', brief, tools));

    const fan = outcome.steps.find((step) => step.nodeId === 'each');
    assert.ok(fan);
    assert.equal(fan.status, 'succeeded');
    assert.match(fan.output, /4 of 4 items done/);

    // The body ran once per item, under its own name each time. Asserted from
    // the trace rather than the step list: a fan-out over a thousand items
    // would otherwise return a thousand-entry summary, so the node's own
    // outcome summarises and the trace keeps the detail.
    const itemNodes = new Set(
      tracesRepository
        .listForRun(db, 'run-10')
        .map((event) => event.nodeId)
        .filter((nodeId) => nodeId.startsWith('each/')),
    );
    assert.equal(itemNodes.size, 4);
    assert.equal(
      outcome.steps.some((step) => step.nodeId === 'handle'),
      false,
      'the body also ran outside the fan-out',
    );

    // The run is finished once, by the outer run — a nested run that finalised
    // would have stamped an end time on a run that was still going.
    const run = runsRepository.get(db, 'run-10');
    assert.equal(run?.status, 'succeeded');

    const decision = tracesRepository
      .listForRun(db, 'run-10')
      .map((event) => JSON.parse(event.payloadJson) as { decision?: string; peakInFlight?: number })
      .find((payload) => payload.decision === 'fanout:finished');
    assert.ok(decision);
    assert.ok((decision.peakInFlight ?? 0) <= 3);
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an aggregate folds many answers into one, a chunk per model call', async () => {
  const { db, dir } = open('run-11');
  const tools = await toolsFor(dir, 'run-11');

  const brief: RunBrief = {
    name: 'folded',
    instruction: 'handle each, then combine',
    attachments: [],
    steps: [
      shaping('items', {
        type: 'transform',
        transform: { template: '["a","b","c","d","e"]' },
      }),
      shaping('each', {
        type: 'fanout',
        fanout: {
          source: 'items',
          parse: 'json',
          body: ['handle'],
          concurrency: 5,
          maxItems: 50,
          onItemError: 'continue',
          deadLetterLimit: 5,
        },
      }),
      agent('handle', 'summariser', 'Handle it.'),
      {
        nodeId: 'combine',
        type: 'aggregate',
        config: {
          type: 'aggregate',
          aggregate: {
            source: 'each',
            strategy: 'reduce_with_agent',
            separator: '',
            template: '',
            roleId: 'summariser',
            chunkSize: 2,
            instruction: 'Combine these into one answer.',
          },
        },
        roleId: '',
        instruction: '',
        // The aggregate node binds a model of its own, because this is the one
        // strategy that spends money.
        connectionId: 'conn-1',
        model: 'mock-frontier',
      },
    ],
    edges: [
      ['items', 'each'],
      ['each', 'handle'],
      ['each', 'combine'],
    ],
  };

  try {
    const outcome = await runAutomation(deps(db, 'run-11', brief, tools));

    const combined = outcome.steps.find((step) => step.nodeId === 'combine');
    assert.ok(combined);
    assert.equal(combined.status, 'succeeded');

    // Five answers at two per chunk is three calls, then those three fold to
    // two, then one: the point of folding is that a thousand answers never have
    // to fit in one context window.
    const foldNodes = new Set(
      tracesRepository
        .listForRun(db, 'run-11')
        .map((event) => event.nodeId)
        .filter((nodeId) => nodeId.startsWith('combine/round-')),
    );
    assert.equal([...foldNodes].filter((nodeId) => nodeId.includes('round-0')).length, 3);
    assert.ok(foldNodes.size > 3, 'it folded once and stopped with three answers');
    assert.ok(combined.iterations >= 2, 'it should have taken more than one round');
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a step joined to three others is given all three, each named', async () => {
  const { db, dir } = open('run-12');
  const tools = await toolsFor(dir, 'run-12');

  // The shape the one-in-one-out canvas could not express: three agents
  // working in parallel and one combining what they found.
  const brief: RunBrief = {
    name: 'joined',
    instruction: 'look at it three ways, then combine',
    attachments: [],
    steps: [
      // Roles with text contracts: the mock answers one fixed string, and a
      // role demanding JSON would fail on its contract rather than on what
      // this test is about.
      agent('legal', 'researcher', 'The legal view.'),
      agent('money', 'coder', 'The financial view.'),
      agent('risk', 'summariser', 'The risk view.'),
      agent('combine', 'summariser', 'Combine the three views into one answer.'),
    ],
    edges: [
      ['legal', 'combine'],
      ['money', 'combine'],
      ['risk', 'combine'],
    ],
  };

  try {
    const outcome = await runAutomation(deps(db, 'run-12', brief, tools));
    assert.equal(outcome.status, 'succeeded');

    // What the combining step was actually sent: every input, each labelled
    // with the agent it came from. Read from the trace, because the prompt is
    // the thing under test.
    const prompt = tracesRepository
      .listForRun(db, 'run-12')
      .filter((event) => event.nodeId === 'combine' && event.eventType === 'prompt')
      .map((event) => event.payloadJson)
      .join('\n');

    assert.match(prompt, /This step has 3 inputs/);
    assert.match(prompt, /from researcher \(legal\)/);
    assert.match(prompt, /from coder \(money\)/);
    assert.match(prompt, /from summariser \(risk\)/);
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the brief reaches every step nothing feeds, even when the step has its own instruction', async () => {
  const { db, dir } = open('run-13');
  const tools = await toolsFor(dir, 'run-13');

  // The bug this is here for: a brief holding the material — a pasted
  // contract, a list of invoices — was *replaced* by a step's own instruction
  // rather than added to it. Against a real model the first agent answered
  // that the contract contained no such clause, because it had never been
  // shown the contract.
  const brief: RunBrief = {
    name: 'material',
    instruction: 'Here is the contract: clause 2 says it renews automatically.',
    attachments: [],
    steps: [
      agent('left', 'researcher', 'What happens at the end of the term?'),
      agent('right', 'summariser', 'What does it cost?'),
      agent('join', 'summariser', 'Combine them.'),
    ],
    edges: [
      ['left', 'join'],
      ['right', 'join'],
    ],
  };

  try {
    await runAutomation(deps(db, 'run-13', brief, tools));

    const promptsFor = (nodeId: string) =>
      tracesRepository
        .listForRun(db, 'run-13')
        .filter((event) => event.nodeId === nodeId && event.eventType === 'prompt')
        .map((event) => event.payloadJson)
        .join('\n');

    // Both entry steps were given the material, not just whichever sorted first.
    assert.match(promptsFor('left'), /renews automatically/);
    assert.match(promptsFor('left'), /What happens at the end of the term/);
    assert.match(promptsFor('right'), /renews automatically/);

    // The joining step gets what the others produced instead: it has already
    // been told everything the material could tell it, through them.
    assert.match(promptsFor('join'), /This step has 2 inputs/);
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an automation saved when the node was called "swarm" still loads', () => {
  // The rename freed the word for a genuine swarm — a simulated population —
  // and a rename that breaks every file somebody already saved is not a rename,
  // it is a deletion. The old spelling is accepted on read forever.
  assert.equal(normaliseType('swarm'), 'team');
  assert.equal(normaliseType('team'), 'team');
  // Everything else is itself, and a step with no type is an agent.
  assert.equal(normaliseType('fanout'), 'fanout');
  assert.equal(normaliseType(undefined), 'agent');
});

test('a swarm that cannot run is a denied step, not a run that never ends', async () => {
  // The failure this covers looked like a hang. A rejection out of
  // `runSwarmNode` unwound past the point that journals the step, so the run
  // ended with the step still recorded as "running" — on the canvas, a spinner
  // that stayed on for good with nothing anywhere saying why.
  const { db, dir } = open('run-swarm-fail');
  const tools = await toolsFor(dir, 'run-swarm-fail');

  const brief: RunBrief = {
    name: 'asking the crowd',
    instruction: 'ask about the price rise',
    attachments: [],
    steps: [
      shaping('crowd', {
        type: 'swarm',
        swarm: {
          question: 'Should we raise prices by ten per cent?',
          population: 120,
          maxRounds: 2,
          everyoneUpTo: 60,
        },
      }),
    ],
    edges: [],
  };

  try {
    const outcome = await runAutomation({
      ...deps(db, 'run-swarm-fail', brief, tools),
      runSwarmNode: () =>
        Promise.reject(new Error('This workspace has not said which model "standard" is.')),
    });

    const step = outcome.steps[0];
    assert.equal(step?.status, 'denied');
    assert.match(step?.output ?? '', /has not said which model/);
    assert.notEqual(step?.status, 'running');
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
