import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@chimera/store';
import type { NormalisedResponse } from '@chimera/providers';
import { CACHE_OFF, cosine, lookup, promptKey, remember } from './promptCache.ts';

// M9-3. What the cache will and will not hand back.

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'store',
  'src',
  'migrations',
);

function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-cache-'));
  const db = openDatabase({ dbPath: path.join(dir, 'w.sqlite'), migrationsDir });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function answer(text: string, toolCalls: NormalisedResponse['toolCalls'] = []): NormalisedResponse {
  return {
    id: 'r1',
    model: 'mock',
    content: [{ type: 'text', text }],
    toolCalls,
    finishReason: 'stop',
    usage: { inputTokens: 100, outputTokens: 20 },
  };
}

test('the key changes when anything that changes the answer changes', () => {
  const base = promptKey('m1', 'be helpful', [{ role: 'user', content: 'hello' }]);
  assert.equal(base, promptKey('m1', 'be helpful', [{ role: 'user', content: 'hello' }]));
  assert.notEqual(base, promptKey('m2', 'be helpful', [{ role: 'user', content: 'hello' }]));
  assert.notEqual(base, promptKey('m1', 'be terse', [{ role: 'user', content: 'hello' }]));
  assert.notEqual(base, promptKey('m1', 'be helpful', [{ role: 'user', content: 'hi' }]));
});

test('an exact hit comes back, and only when exact caching is on', () => {
  const { db, cleanup } = open();
  const policy = { exact: true, semantic: false, threshold: 0.97 };
  try {
    const key = promptKey('m1', 's', [{ role: 'user', content: 'q' }]);
    remember(db, policy, { key, response: answer('the answer'), costUsd: 0.02 });

    const hit = lookup(db, policy, { key });
    assert.equal(hit?.kind, 'exact');
    assert.equal(hit?.savedCostUsd, 0.02);

    // Off means off: the entry is still there, and nothing reads it.
    assert.equal(lookup(db, CACHE_OFF, { key }), null);
  } finally {
    db.close();
    cleanup();
  }
});

test('a response with a tool call is never cached, and never returned', () => {
  const { db, cleanup } = open();
  const policy = { exact: true, semantic: false, threshold: 0.97 };
  try {
    const key = promptKey('m1', 's', [{ role: 'user', content: 'send it' }]);
    remember(db, policy, {
      key,
      response: answer('sending', [{ id: 'c1', name: 'email__send', arguments: {} }]),
      costUsd: 0.02,
    });

    // Handing a tool call back would replay a side effect that already
    // happened — the opposite end of the guarantee M2-9's idempotency keys
    // make.
    assert.equal(lookup(db, policy, { key }), null);
  } finally {
    db.close();
    cleanup();
  }
});

test('a semantic hit needs to be close enough, and off by default', () => {
  const { db, cleanup } = open();
  const semantic = { exact: false, semantic: true, threshold: 0.95 };
  try {
    const key = promptKey('m1', 's', [{ role: 'user', content: 'summarise invoice 12' }]);
    remember(db, semantic, {
      key,
      response: answer('invoice 12 is for two widgets'),
      costUsd: 0.05,
      embedding: [1, 0, 0.1],
    });

    // Nearly the same direction: a hit.
    const near = lookup(db, semantic, { key: 'other', embedding: [1, 0.02, 0.1] });
    assert.equal(near?.kind, 'semantic');
    assert.ok((near?.similarity ?? 0) >= 0.95);

    // A different question: no hit, however much the user wishes there was.
    assert.equal(lookup(db, semantic, { key: 'other', embedding: [0, 1, 0] }), null);

    // And with semantic off, the same near-miss returns nothing at all.
    assert.equal(
      lookup(
        db,
        { exact: true, semantic: false, threshold: 0.95 },
        {
          key: 'other',
          embedding: [1, 0.02, 0.1],
        },
      ),
      null,
    );
  } finally {
    db.close();
    cleanup();
  }
});

test('cosine similarity behaves at the edges', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], [1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});
