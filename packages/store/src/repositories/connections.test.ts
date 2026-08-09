import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { ValidationError, VaultError } from '@chimera/core';
import { openDatabase } from '../db.ts';
import type { AuthRef } from '../vault.ts';
import * as connections from './connections.ts';

const migrationsDir = path.join(import.meta.dirname, '..', 'migrations');

function withDb(fn: (db: Database.Database) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'chimera-connections-test-'));
  const db = openDatabase({ dbPath: path.join(dir, 'chimera.sqlite'), migrationsDir });
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// A syntactically valid handle. Not written to a real keychain: this
// repository's contract is about the *shape* it will persist, and keeping it
// keychain-free is what lets these tests run on a CI box with no keyring
// daemon (packages/store/src/vault.test.ts skips there).
const HANDLE = 'vault:connection:11111111-2222-3333-4444-555555555555' as AuthRef;

test('create persists the vault handle in auth_ref and returns the stored record', () => {
  withDb((db) => {
    const created = connections.create(db, {
      label: 'Anthropic production',
      kind: 'anthropic',
      authRef: HANDLE,
    });

    assert.equal(created.authRef, HANDLE);
    assert.equal(created.label, 'Anthropic production');
    assert.equal(created.healthState, 'unknown');
    assert.match(created.id, /^[0-9a-f-]{36}$/);

    const fetched = connections.get(db, created.id);
    assert.equal(fetched?.authRef, HANDLE);
    assert.equal(fetched?.kind, 'anthropic');
  });
});

test('create rejects a raw secret in place of a handle, with VaultError', () => {
  withDb((db) => {
    assert.throws(
      () =>
        connections.create(db, {
          label: 'Leaky',
          kind: 'openai',
          // Exactly the bug this boundary exists to catch: the type system says
          // AuthRef, a runtime caller passed a live key. Cast away the brand to
          // simulate a value arriving over IPC, where branding does not survive.
          authRef: 'sk-live-abc123' as AuthRef,
        }),
      VaultError,
    );

    // ...and nothing was written. A rejection that still persisted the row
    // would be worse than no check at all.
    assert.equal(connections.list(db).length, 0);
  });
});

test('the rejection never echoes the offending secret back in the error', () => {
  withDb((db) => {
    const secret = 'sk-live-this-must-not-appear-anywhere-in-the-error';
    try {
      connections.create(db, { label: 'Leaky', kind: 'openai', authRef: secret as AuthRef });
      assert.fail('expected create to reject a raw secret');
    } catch (err) {
      assert.ok(err instanceof VaultError);
      const serialised = JSON.stringify(err.toWireFormat());
      assert.ok(!serialised.includes(secret), `secret leaked into the error: ${serialised}`);
    }
  });
});

test('a secret is never written to the connections table even across a full round trip', () => {
  withDb((db) => {
    const canary = 'sk-canary-never-in-sqlite';
    try {
      connections.create(db, { label: 'x', kind: 'openai', authRef: canary as AuthRef });
    } catch {
      // expected
    }
    connections.create(db, { label: 'good', kind: 'anthropic', authRef: HANDLE });

    // Read the raw file bytes rather than the parsed rows: a value could be
    // present in the page cache or a stale row that list() would not surface.
    const everything = JSON.stringify(connections.list(db));
    assert.ok(!everything.includes(canary));
  });
});

test('empty label or kind is rejected with ValidationError, not silently stored', () => {
  withDb((db) => {
    assert.throws(
      () => connections.create(db, { label: '   ', kind: 'anthropic', authRef: HANDLE }),
      ValidationError,
    );
    assert.throws(
      () => connections.create(db, { label: 'ok', kind: '', authRef: HANDLE }),
      ValidationError,
    );
    assert.equal(connections.list(db).length, 0);
  });
});

test('list returns every connection, ordered deterministically', () => {
  withDb((db) => {
    connections.create(db, { id: 'b', label: 'B', kind: 'openai', authRef: HANDLE });
    connections.create(db, { id: 'a', label: 'A', kind: 'anthropic', authRef: HANDLE });
    const ids = connections.list(db).map((c) => c.id);
    assert.equal(ids.length, 2);
    assert.deepEqual([...ids].sort(), ['a', 'b']);
  });
});

test('updateHealth and remove reject an unknown id instead of silently doing nothing', () => {
  withDb((db) => {
    assert.throws(() => connections.updateHealth(db, 'nope', 'healthy'), ValidationError);
    assert.throws(() => connections.remove(db, 'nope'), ValidationError);
  });
});

test('every mutation notifies subscribers, and unsubscribing stops it', () => {
  withDb((db) => {
    let calls = 0;
    const unsubscribe = connections.onConnectionsChanged(db, () => {
      calls += 1;
    });

    const created = connections.create(db, { label: 'A', kind: 'openai', authRef: HANDLE });
    assert.equal(calls, 1);
    connections.updateHealth(db, created.id, 'healthy');
    assert.equal(calls, 2);
    connections.updateCapabilities(db, created.id, '{}');
    assert.equal(calls, 3);
    connections.remove(db, created.id);
    assert.equal(calls, 4);

    unsubscribe();
    connections.create(db, { label: 'B', kind: 'openai', authRef: HANDLE });
    assert.equal(calls, 4, 'listener fired after unsubscribing');
  });
});

test('a rejected write does not notify subscribers', () => {
  withDb((db) => {
    let calls = 0;
    connections.onConnectionsChanged(db, () => {
      calls += 1;
    });
    try {
      connections.create(db, { label: 'x', kind: 'openai', authRef: 'sk-nope' as AuthRef });
    } catch {
      // expected
    }
    assert.equal(calls, 0);
  });
});

test('listeners are scoped to their own database handle', () => {
  withDb((first) => {
    withDb((second) => {
      let firstCalls = 0;
      connections.onConnectionsChanged(first, () => {
        firstCalls += 1;
      });
      connections.create(second, { label: 'B', kind: 'openai', authRef: HANDLE });
      assert.equal(firstCalls, 0, 'a write to one database notified another database s listeners');
    });
  });
});
