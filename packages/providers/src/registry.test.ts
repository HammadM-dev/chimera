import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, connectionsRepository, type AuthRef } from '@chimera/store';
import { createConnectionRegistry } from './registry.ts';

const migrationsDir = path.join(import.meta.dirname, '..', '..', 'store', 'src', 'migrations');

function withDb(fn: (db: Database.Database) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'chimera-registry-test-'));
  const db = openDatabase({ dbPath: path.join(dir, 'chimera.sqlite'), migrationsDir });
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const HANDLE = 'vault:connection:11111111-2222-3333-4444-555555555555' as AuthRef;

test('a registry built over an empty table lists nothing', () => {
  withDb((db) => {
    const registry = createConnectionRegistry(db);
    assert.deepEqual(registry.list(), []);
    assert.deepEqual(registry.unusable(), []);
    registry.close();
  });
});

test('list reflects a repository write with no refresh and no restart', () => {
  withDb((db) => {
    const registry = createConnectionRegistry(db);

    // Read first, so the registry has definitely cached the empty state — the
    // point of this test is that the cache does not go stale, and a registry
    // that had never loaded would pass trivially.
    assert.equal(registry.list().length, 0);

    connectionsRepository.create(db, {
      label: 'Anthropic production',
      kind: 'anthropic',
      authRef: HANDLE,
    });

    const listed = registry.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.label, 'Anthropic production');
    assert.equal(listed[0]?.kind, 'anthropic');
    assert.equal(listed[0]?.authRef, HANDLE);
    assert.equal(listed[0]?.healthState, 'unknown');

    registry.close();
  });
});

test('list reflects updates and deletes too, not just inserts', () => {
  withDb((db) => {
    const registry = createConnectionRegistry(db);
    const created = connectionsRepository.create(db, {
      label: 'OpenAI',
      kind: 'openai',
      authRef: HANDLE,
    });
    assert.equal(registry.get(created.id)?.healthState, 'unknown');

    connectionsRepository.updateHealth(db, created.id, 'healthy');
    assert.equal(registry.get(created.id)?.healthState, 'healthy');

    connectionsRepository.remove(db, created.id);
    assert.equal(registry.get(created.id), undefined);
    assert.equal(registry.list().length, 0);

    registry.close();
  });
});

test('capabilities and limits round-trip through the single JSON column', () => {
  withDb((db) => {
    const registry = createConnectionRegistry(db);
    connectionsRepository.create(db, {
      id: 'c1',
      label: 'Tuned',
      kind: 'openai',
      authRef: HANDLE,
      capabilitiesJson: JSON.stringify({
        capabilities: { 'gpt-5': { streaming: true } },
        limits: { requestsPerMinute: 60, maxConcurrentRequests: 4 },
      }),
    });

    const connection = registry.get('c1');
    assert.deepEqual(connection?.capabilities, { 'gpt-5': { streaming: true } });
    assert.equal(connection?.limits.requestsPerMinute, 60);
    assert.equal(connection?.limits.maxConcurrentRequests, 4);

    registry.close();
  });
});

test('a connection with no capabilities blob gets empty capabilities and limits, not undefined', () => {
  withDb((db) => {
    const registry = createConnectionRegistry(db);
    connectionsRepository.create(db, { id: 'c1', label: 'Bare', kind: 'ollama', authRef: HANDLE });
    const connection = registry.get('c1');
    assert.deepEqual(connection?.capabilities, {});
    assert.deepEqual(connection?.limits, {});
    registry.close();
  });
});

test('an unknown provider kind is quarantined and reported, not dropped and not fatal', () => {
  withDb((db) => {
    const registry = createConnectionRegistry(db);
    connectionsRepository.create(db, {
      id: 'good',
      label: 'Works',
      kind: 'anthropic',
      authRef: HANDLE,
    });
    connectionsRepository.create(db, {
      id: 'bad',
      label: 'From the future',
      kind: 'quantum-oracle',
      authRef: HANDLE,
    });

    // The healthy connection is unaffected — one bad row must not take out the
    // workspace.
    const listed = registry.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, 'good');

    // ...and the bad one is reported rather than silently vanishing.
    const unusable = registry.unusable();
    assert.equal(unusable.length, 1);
    assert.equal(unusable[0]?.id, 'bad');
    assert.equal(unusable[0]?.kind, 'quantum-oracle');
    assert.match(unusable[0]?.reason ?? '', /unknown provider kind/i);

    registry.close();
  });
});

test('a corrupt capabilities blob quarantines only its own connection', () => {
  withDb((db) => {
    const registry = createConnectionRegistry(db);
    connectionsRepository.create(db, {
      id: 'ok',
      label: 'Fine',
      kind: 'openai',
      authRef: HANDLE,
    });
    connectionsRepository.create(db, {
      id: 'corrupt',
      label: 'Broken',
      kind: 'openai',
      authRef: HANDLE,
      capabilitiesJson: '{not valid json',
    });

    assert.deepEqual(
      registry.list().map((c) => c.id),
      ['ok'],
    );
    assert.equal(registry.unusable()[0]?.id, 'corrupt');
    registry.close();
  });
});

test('an unrecognised health state degrades to unknown rather than quarantining the row', () => {
  withDb((db) => {
    const registry = createConnectionRegistry(db);
    connectionsRepository.create(db, {
      id: 'c1',
      label: 'Odd health',
      kind: 'openai',
      authRef: HANDLE,
      healthState: 'sideways',
    });
    assert.equal(registry.get('c1')?.healthState, 'unknown');
    assert.equal(registry.unusable().length, 0);
    registry.close();
  });
});

test('list returns a copy — mutating it cannot corrupt the registry cache', () => {
  withDb((db) => {
    const registry = createConnectionRegistry(db);
    connectionsRepository.create(db, { id: 'c1', label: 'A', kind: 'openai', authRef: HANDLE });
    const first = registry.list();
    first.pop();
    assert.equal(registry.list().length, 1);
    registry.close();
  });
});

test('after close, the registry stops tracking further writes', () => {
  withDb((db) => {
    const registry = createConnectionRegistry(db);
    assert.equal(registry.list().length, 0);
    registry.close();

    connectionsRepository.create(db, { label: 'Late', kind: 'openai', authRef: HANDLE });

    // Deliberate: close() unsubscribes, so the cache is now frozen. Asserted
    // rather than left implicit because a caller that closes and keeps reading
    // should get a predictable answer, not an accidentally-fresh one.
    assert.equal(registry.list().length, 0);
    registry.refresh();
    assert.equal(registry.list().length, 1);
  });
});

test('no connection object ever carries a secret value, only a handle', () => {
  withDb((db) => {
    const registry = createConnectionRegistry(db);
    connectionsRepository.create(db, { id: 'c1', label: 'A', kind: 'openai', authRef: HANDLE });
    const serialised = JSON.stringify(registry.list());
    assert.ok(serialised.includes(HANDLE));
    assert.match(serialised, /vault:connection:/);
    assert.ok(!/sk-[a-zA-Z0-9]/.test(serialised));
    registry.close();
  });
});
