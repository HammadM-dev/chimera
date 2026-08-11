import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { ChimeraError, ValidationError } from '@chimera/errors';
import { openDatabase } from '@chimera/store';
import { MockProvider } from '@chimera/providers';
import { createToolRegistry } from '@chimera/tools';
import { Governor } from '../../governor/Governor.ts';
import { STARTER_ROLES } from '../roleRegistry.ts';
import { runAgentLoop } from '../agentLoop.ts';
import { createScratchpad, discardScratchpad, discardAllScratchpads } from './scratchpad.ts';
import { createWorkspaceFacts } from './workspaceFacts.ts';
import { assertMemoryAvailable, createVectorStore } from './vectorStore.ts';

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

function openTemp(): { db: Database.Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-memory-'));
  return { db: openDatabase({ dbPath: path.join(dir, 'w.sqlite'), migrationsDir }), dir };
}

test('scratchpad entries are readable within a run and gone in the next', () => {
  discardAllScratchpads();

  const first = createScratchpad('run-1');
  first.set('finding', 'the invoice total is 412.50');
  first.set('source', 'invoices/march.pdf');

  // Within the run: readable, and rendered in a stable order so a prompt does
  // not change just because a Map iterated differently.
  assert.equal(first.get('finding'), 'the invoice total is 412.50');
  assert.equal(first.render(), 'finding: the invoice total is 412.50\nsource: invoices/march.pdf');

  // Same run, obtained again — an agent loop and its node runner both ask for
  // the pad by run id and must get the same one.
  assert.equal(createScratchpad('run-1').get('finding'), 'the invoice total is 412.50');

  // Run ends.
  discardScratchpad('run-1');

  const second = createScratchpad('run-2');
  assert.equal(second.get('finding'), undefined);
  assert.equal(second.render(), '');
  // And the same run id reused later starts empty too — a pad that survived
  // would leak one task's context into an unrelated one.
  assert.equal(createScratchpad('run-1').get('finding'), undefined);
});

test('workspace facts written by one run are readable by a later, unrelated run', () => {
  const { db, dir } = openTemp();
  try {
    const fromFirstRun = createWorkspaceFacts(db);
    fromFirstRun.set('billing.contact', 'ap@acme.example', { source: 'run-1' });

    // A different store object over the same workspace — which is what a later
    // run, or a restarted app, actually is.
    const fromLaterRun = createWorkspaceFacts(db);
    assert.equal(fromLaterRun.get('billing.contact'), 'ap@acme.example');

    // The source travels with the fact: what an agent asserted and what a
    // person stated are not equally trustworthy, and the rendering says which.
    assert.match(fromLaterRun.render(), /source: run-1/);

    fromLaterRun.set('billing.contact', 'finance@acme.example', { source: 'user' });
    assert.equal(fromLaterRun.get('billing.contact'), 'finance@acme.example');
    assert.match(fromLaterRun.render(), /source: user/);

    assert.equal(fromLaterRun.remove('billing.contact'), true);
    assert.equal(fromLaterRun.remove('billing.contact'), false);
    assert.deepEqual(fromLaterRun.list(), []);
    assert.equal(fromLaterRun.render(), '');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fact is bounded in size, and an empty key is refused', () => {
  const { db, dir } = openTemp();
  try {
    const facts = createWorkspaceFacts(db);

    assert.throws(
      () => facts.set('   ', 'x', { source: 'user' }),
      (err: unknown) => err instanceof ValidationError && err.code === 'FACT_KEY_EMPTY',
    );

    // Facts go into every prompt for the workspace. An agent that could write
    // an unbounded one could push the real instructions out of the context
    // window with its own text.
    assert.throws(
      () => facts.set('k', 'x'.repeat(4_001), { source: 'run-1' }),
      (err: unknown) => err instanceof ValidationError && err.code === 'FACT_TOO_LARGE',
    );
    assert.throws(
      () => facts.set('k'.repeat(201), 'x', { source: 'run-1' }),
      (err: unknown) => err instanceof ValidationError && err.code === 'FACT_TOO_LARGE',
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the vector store fails fast and clearly rather than silently doing nothing', async () => {
  const store = createVectorStore();

  await assert.rejects(
    () => store.search('anything'),
    (err: unknown) =>
      err instanceof ChimeraError &&
      err.code === 'MEMORY_VECTOR_STORE_UNAVAILABLE' &&
      // The message has to tell the user what to do instead, not just that
      // something is missing.
      /M9/.test(err.message) &&
      /workspace facts/.test(err.message),
  );
  await assert.rejects(() => store.add('id', 'text'), ChimeraError);

  assert.throws(
    () => {
      assertMemoryAvailable({ vectorStore: true }, { nodeId: 'node-1' });
    },
    (err: unknown) => err instanceof ChimeraError && err.details.nodeId === 'node-1',
  );
  // The tiers that do exist pass through.
  assert.doesNotThrow(() => {
    assertMemoryAvailable({ scratchpad: true, workspaceFacts: true, vectorStore: false });
  });
  assert.doesNotThrow(() => {
    assertMemoryAvailable(undefined);
  });
});

test('a node asking for the vector store fails before any model call is made', async () => {
  const summariser = STARTER_ROLES.find((role) => role.id === 'summariser');
  assert.ok(summariser);

  let calls = 0;
  const provider = new MockProvider({ script: { default: { kind: 'text', content: 'hi' } } });
  const counting = {
    ...provider,
    chat: async (...args: Parameters<MockProvider['chat']>) => {
      calls += 1;
      return provider.chat(...args);
    },
  } as unknown as MockProvider;

  await assert.rejects(
    () =>
      runAgentLoop(
        {
          runId: 'run-1',
          nodeId: 'node-1',
          role: summariser,
          task: 'Summarise.',
          connectionId: 'conn-1',
          model: 'mock-frontier',
          memory: { vectorStore: true },
        },
        {
          governor: new Governor(),
          provider: counting,
          tools: createToolRegistry(),
          callOptions: { authRef: 'vault:connection:0'.padEnd(48, '0') as never },
        },
      ),
    (err: unknown) => err instanceof ChimeraError && err.code === 'MEMORY_VECTOR_STORE_UNAVAILABLE',
  );

  // Fails before spending anything. A check that ran after the first call
  // would bill the user for a run that was never going to work.
  assert.equal(calls, 0);
});
