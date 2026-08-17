import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blackboardRepository, openDatabase, runsRepository } from '@chimera/store';
import { MAX_CONCURRENT_AGENTS, runSwarm } from './swarm.ts';
import type { SwarmConfig } from '../nodeTypes.ts';

// M5-3. The three ways it stops, the cap it cannot exceed, and the board the
// participants actually share.

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'store',
  'src',
  'migrations',
);

function open(runId: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-swarm-'));
  const db = openDatabase({ dbPath: path.join(dir, 'w.sqlite'), migrationsDir });
  runsRepository.create(db, { id: runId });
  return { db, dir };
}

function config(over: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    goal: 'Write the report.',
    orchestratorRoleId: 'planner',
    agents: [
      { roleId: 'researcher', instruction: 'Find the facts.' },
      { roleId: 'qa', instruction: 'Check them.' },
    ],
    maxRounds: 3,
    maxConcurrentAgents: 5,
    stallRounds: 0,
    ...over,
  };
}

test('it stops when the orchestrator says the goal is met', async () => {
  const { db, dir } = open('run-1');
  try {
    const outcome = await runSwarm({
      db,
      runId: 'run-1',
      nodeId: 'swarm',
      config: config({
        goalPredicate: {
          source: '',
          test: 'contains',
          value: 'DONE',
          whenTrue: [],
          whenFalse: [],
        },
      }),
      runAgent: ({ roleId }) =>
        Promise.resolve({
          ok: true,
          output: roleId === 'planner' ? 'Everything is covered. DONE' : 'my bit',
        }),
    });

    assert.equal(outcome.stopped, 'goal');
    assert.equal(outcome.rounds.length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('it stops when the rounds run out', async () => {
  const { db, dir } = open('run-2');
  let round = 0;
  try {
    const outcome = await runSwarm({
      db,
      runId: 'run-2',
      nodeId: 'swarm',
      config: config({ maxRounds: 3 }),
      runAgent: ({ roleId }) => {
        if (roleId === 'planner') round += 1;
        // Different every time, so the stall rule never fires and the round
        // limit is the only thing that can stop this.
        return Promise.resolve({ ok: true, output: `still working ${String(round)}` });
      },
    });

    assert.equal(outcome.stopped, 'max-rounds');
    assert.equal(outcome.rounds.length, 3);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('it stops when nothing changes, rather than paying for more of the same', async () => {
  const { db, dir } = open('run-3');
  try {
    const outcome = await runSwarm({
      db,
      runId: 'run-3',
      nodeId: 'swarm',
      config: config({ maxRounds: 50, stallRounds: 2 }),
      // Every participant says the same thing every round. The board stops
      // changing, and a swarm that cannot make progress should not spend fifty
      // rounds demonstrating it.
      runAgent: () => Promise.resolve({ ok: true, output: 'the same thing' }),
    });

    assert.equal(outcome.stopped, 'stalled');
    assert.ok(outcome.rounds.length < 6, `it ran ${String(outcome.rounds.length)} rounds`);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the engine caps concurrent agents at 20, whatever the workflow asks for', async () => {
  const { db, dir } = open('run-4');
  let live = 0;
  let peak = 0;

  try {
    const outcome = await runSwarm({
      db,
      runId: 'run-4',
      nodeId: 'swarm',
      config: config({
        maxRounds: 1,
        // A workflow asking for a hundred. Past twenty, coordination costs more
        // than it produces, and the cap is enforced rather than documented.
        maxConcurrentAgents: 100,
        agents: Array.from({ length: 60 }, (_, index) => ({
          roleId: 'researcher',
          instruction: `part ${String(index)}`,
        })),
      }),
      runAgent: async ({ roleId }) => {
        if (roleId === 'planner') return { ok: true, output: 'go' };
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 1));
        live -= 1;
        return { ok: true, output: 'done' };
      },
    });

    assert.equal(peak, MAX_CONCURRENT_AGENTS);
    assert.equal(outcome.peakConcurrentAgents, MAX_CONCURRENT_AGENTS);
    // All sixty still ran — the cap is on how many at once, not how many.
    assert.equal(outcome.rounds[0]?.workers.length, 60);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every participant reads the board, and every write is attributed and scoped', async () => {
  const { db, dir } = open('run-5');
  const seen: string[] = [];

  try {
    await runSwarm({
      db,
      runId: 'run-5',
      nodeId: 'swarm',
      config: config({ maxRounds: 2 }),
      runAgent: ({ roleId, context }) => {
        seen.push(`${roleId}:${context === '' ? 'empty' : 'has-board'}`);
        return Promise.resolve({ ok: true, output: `${roleId} says something new` });
      },
    });

    // The first orchestrator turn sees an empty board; everyone after it sees
    // what has been written so far.
    assert.equal(seen[0], 'planner:empty');
    assert.ok(seen.slice(1).every((entry) => entry.endsWith('has-board')));

    const entries = blackboardRepository.history(db, 'run-5');
    assert.ok(entries.length >= 6);
    // The orchestrator writes to its own scope and the workers to theirs.
    const orchestrator = entries.filter((entry) => entry.roleId === 'planner');
    assert.ok(orchestrator.every((entry) => entry.scope === 'orchestrator'));
    assert.ok(
      entries
        .filter((entry) => entry.roleId !== 'planner')
        .every((entry) => entry.scope === 'workers'),
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an orchestrator that fails stops the swarm rather than leaving it leaderless', async () => {
  const { db, dir } = open('run-6');
  try {
    const outcome = await runSwarm({
      db,
      runId: 'run-6',
      nodeId: 'swarm',
      config: config(),
      runAgent: ({ roleId }) =>
        Promise.resolve(
          roleId === 'planner'
            ? { ok: false, output: 'the budget ran out' }
            : { ok: true, output: 'fine' },
        ),
    });

    assert.equal(outcome.stopped, 'failed');
    assert.match(outcome.reason, /budget ran out/);
    assert.equal(outcome.rounds.length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
