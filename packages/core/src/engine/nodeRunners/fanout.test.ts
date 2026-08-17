import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deadLetterRepository, openDatabase, runsRepository } from '@chimera/store';
import { itemsFrom, runFanout } from './fanout.ts';
import type { FanoutConfig } from '../nodeTypes.ts';

// M5-1. The pool, the bound, and the failure report — tested at the level the
// acceptance criteria are written at: a thousand items, twenty-five at a time,
// with failures that do not take the batch down with them.

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-fanout-'));
  const db = openDatabase({ dbPath: path.join(dir, 'w.sqlite'), migrationsDir });
  runsRepository.create(db, { id: runId });
  return { db, dir };
}

function config(over: Partial<FanoutConfig> = {}): FanoutConfig {
  return {
    source: '',
    parse: 'json',
    body: ['work'],
    concurrency: 25,
    maxItems: 5000,
    onItemError: 'continue',
    deadLetterLimit: 100,
    ...over,
  };
}

test('a thousand items at concurrency 25 never has more than 25 in flight', async () => {
  const { db, dir } = open('run-1');
  const items = Array.from({ length: 1000 }, (_, index) => ({ id: index }));

  // The counter is on the work itself rather than on the pool's own bookkeeping:
  // a pool that reported its own limit correctly while exceeding it is exactly
  // the bug this criterion exists to catch.
  let live = 0;
  let peak = 0;

  try {
    const outcome = await runFanout({
      db,
      runId: 'run-1',
      nodeId: 'fan',
      config: config(),
      items,
      runItem: async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 1));
        live -= 1;
        return { ok: true, output: 'done' };
      },
    });

    assert.equal(outcome.succeeded, 1000);
    assert.equal(peak, 25, `peak concurrency was ${String(peak)}`);
    assert.equal(outcome.peakInFlight, 25);
    // In flight, not queued: all thousand were processed.
    assert.equal(outcome.results.length, 1000);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed item lands in the dead letter and the rest keep going', async () => {
  const { db, dir } = open('run-2');
  const items = ['a', 'b', 'c', 'd', 'e'];

  try {
    const outcome = await runFanout({
      db,
      runId: 'run-2',
      nodeId: 'fan',
      config: config({ concurrency: 2 }),
      items,
      runItem: ({ item }) =>
        Promise.resolve(
          item === 'c'
            ? { ok: false, output: 'the model refused' }
            : { ok: true, output: `did ${String(item)}` },
        ),
    });

    assert.equal(outcome.succeeded, 4);
    assert.equal(outcome.failed, 1);
    assert.equal(outcome.halted, false);

    const dead = deadLetterRepository.listForRun(db, 'run-2');
    assert.equal(dead.length, 1);
    assert.equal(dead[0]?.itemJson, '"c"');
    assert.equal(dead[0]?.itemIndex, 2);
    assert.match(dead[0]?.error ?? '', /refused/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a body that throws is one failed item, not a failed run', async () => {
  const { db, dir } = open('run-3');

  try {
    const outcome = await runFanout({
      db,
      runId: 'run-3',
      nodeId: 'fan',
      config: config({ concurrency: 3 }),
      items: [1, 2, 3],
      runItem: ({ item }) => {
        if (item === 2) throw new Error('socket hang up');
        return Promise.resolve({ ok: true, output: 'fine' });
      },
    });

    assert.equal(outcome.succeeded, 2);
    assert.equal(outcome.failed, 1);
    assert.match(deadLetterRepository.listForRun(db, 'run-3')[0]?.error ?? '', /socket hang up/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('past the dead-letter limit the whole node stops', async () => {
  const { db, dir } = open('run-4');
  const items = Array.from({ length: 200 }, (_, index) => index);
  let attempted = 0;

  try {
    const outcome = await runFanout({
      db,
      runId: 'run-4',
      nodeId: 'fan',
      config: config({ concurrency: 4, deadLetterLimit: 5 }),
      items,
      runItem: () => {
        attempted += 1;
        return Promise.resolve({ ok: false, output: 'the provider is down' });
      },
    });

    assert.equal(outcome.halted, true);
    assert.match(outcome.haltReason, /past the limit of 5/);
    // It stopped rather than proving the same failure two hundred times. The
    // slack is the workers already in flight when the limit was passed.
    assert.ok(attempted < 20, `it attempted ${String(attempted)} items after halting`);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('maxItems is the bound, and it is enforced', async () => {
  const { db, dir } = open('run-5');

  try {
    const outcome = await runFanout({
      db,
      runId: 'run-5',
      nodeId: 'fan',
      config: config({ maxItems: 10 }),
      items: Array.from({ length: 500 }, (_, index) => index),
      runItem: () => Promise.resolve({ ok: true, output: 'done' }),
    });

    assert.equal(outcome.results.length, 10);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('items are read from a declared shape, never an expression', () => {
  assert.deepEqual(itemsFrom('["a","b"]', 'json'), ['a', 'b']);
  assert.deepEqual(itemsFrom('a\n\n b \n', 'lines'), ['a', 'b']);
  // One object where the graph expected many is one item, not an error.
  assert.deepEqual(itemsFrom('{"id":1}', 'json'), [{ id: 1 }]);
  // The commonest thing a model returns when asked for a list is a list, so
  // unparseable JSON falls back to lines rather than failing the node.
  assert.deepEqual(itemsFrom('first\nsecond', 'json'), ['first', 'second']);
});
