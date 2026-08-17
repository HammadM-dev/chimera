import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  openDatabase,
  connectionsRepository,
  settingsRepository,
  type AuthRef,
} from '@chimera/store';
import { createConnectionRegistry, isLocalEndpoint, isLocalConnection } from './registry.ts';

const migrationsDir = path.join(import.meta.dirname, '..', '..', 'store', 'src', 'migrations');
const HANDLE = 'vault:connection:11111111-2222-3333-4444-555555555555' as AuthRef;

function withDb(fn: (db: Database.Database) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'chimera-localonly-test-'));
  const db = openDatabase({ dbPath: path.join(dir, 'chimera.sqlite'), migrationsDir });
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seed(db: Database.Database): void {
  connectionsRepository.create(db, {
    id: 'anthropic',
    label: 'Claude',
    kind: 'anthropic',
    authRef: HANDLE,
  });
  connectionsRepository.create(db, { id: 'openai', label: 'GPT', kind: 'openai', authRef: HANDLE });
  connectionsRepository.create(db, {
    id: 'router',
    label: 'OpenRouter',
    kind: 'openrouter',
    authRef: HANDLE,
  });
  connectionsRepository.create(db, {
    id: 'ollama',
    label: 'Ollama',
    kind: 'ollama',
    authRef: HANDLE,
  });
  connectionsRepository.create(db, {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'lmstudio',
    baseUrl: 'http://localhost:1234/v1',
    authRef: HANDLE,
  });
  connectionsRepository.create(db, {
    id: 'omni-local',
    label: 'OmniRoute (local)',
    kind: 'omniroute',
    baseUrl: 'http://localhost:20128/v1',
    authRef: HANDLE,
  });
  connectionsRepository.create(db, {
    id: 'omni-remote',
    label: 'OmniRoute (hosted)',
    kind: 'omniroute',
    baseUrl: 'https://gateway.example.com/v1',
    authRef: HANDLE,
  });
  connectionsRepository.create(db, {
    id: 'selfhosted',
    label: 'Self-hosted vLLM',
    kind: 'openai-compatible',
    baseUrl: 'http://192.168.1.50:8000/v1',
    authRef: HANDLE,
  });
}

test('the migration creates workspace settings with local-only mode off', () => {
  withDb((db) => {
    const settings = settingsRepository.read(db);
    assert.equal(settings.localOnlyMode, false);
    // M5-4 put the tier map on the same row. A fresh workspace has all three
    // unset, which is what a step bound to a tier reports rather than guessing.
    assert.deepEqual(settings.modelTiers, {
      cheap: { connectionId: '', model: '' },
      standard: { connectionId: '', model: '' },
      frontier: { connectionId: '', model: '' },
    });
  });
});

test('with the flag off, every usable connection is listed', () => {
  withDb((db) => {
    seed(db);
    const registry = createConnectionRegistry(db);
    assert.equal(registry.list().length, 8);
    assert.equal(registry.localOnlyMode(), false);
    registry.close();
  });
});

test('with the flag on, cloud connections are excluded even though their rows exist', () => {
  withDb((db) => {
    seed(db);
    const registry = createConnectionRegistry(db);
    settingsRepository.setLocalOnlyMode(db, true);

    const visible = registry
      .list()
      .map((c) => c.id)
      .sort();
    assert.deepEqual(visible, ['lmstudio', 'ollama', 'omni-local', 'selfhosted']);

    // The rows are still there — this is a visibility policy, not a deletion.
    assert.equal(connectionsRepository.list(db).length, 8);
    assert.equal(registry.listAll().length, 8);
    registry.close();
  });
});

test('a hosted OmniRoute is excluded under local-only mode, a local one is not', () => {
  withDb((db) => {
    seed(db);
    const registry = createConnectionRegistry(db);
    settingsRepository.setLocalOnlyMode(db, true);
    const ids = registry.list().map((c) => c.id);
    assert.ok(ids.includes('omni-local'));
    assert.ok(!ids.includes('omni-remote'), 'a gateway on the public internet is not local');
    registry.close();
  });
});

test('get() honours the filter, so a hidden connection cannot be resolved by id', () => {
  withDb((db) => {
    seed(db);
    const registry = createConnectionRegistry(db);
    settingsRepository.setLocalOnlyMode(db, true);

    // The failure this flag exists to prevent is a run reaching a cloud
    // provider. A list() that filtered while get() did not would let any caller
    // holding an id route straight past the policy.
    assert.equal(registry.get('anthropic'), undefined);
    assert.ok(registry.get('ollama'));
    registry.close();
  });
});

test('toggling the flag back off restores visibility with no re-import and no restart', () => {
  withDb((db) => {
    seed(db);
    const registry = createConnectionRegistry(db);

    settingsRepository.setLocalOnlyMode(db, true);
    assert.equal(registry.list().length, 4);

    settingsRepository.setLocalOnlyMode(db, false);
    assert.equal(registry.list().length, 8, 'toggling off must not require a re-import');
    assert.ok(registry.get('anthropic'));
    registry.close();
  });
});

test('a cloud kind stays excluded even when pointed at a loopback URL', () => {
  withDb((db) => {
    connectionsRepository.create(db, {
      id: 'proxied',
      label: 'Anthropic via local proxy',
      kind: 'anthropic',
      baseUrl: 'http://localhost:8080/v1',
      authRef: HANDLE,
    });
    const registry = createConnectionRegistry(db);
    settingsRepository.setLocalOnlyMode(db, true);

    // A loopback URL in front of Anthropic is a proxy to Anthropic, not a local
    // model. Judging by URL alone would defeat the flag for the exact buyer who
    // set it.
    assert.equal(registry.list().length, 0);
    registry.close();
  });
});

test('isLocalEndpoint accepts loopback, private ranges and .local; rejects public hosts', () => {
  for (const url of [
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234',
    'http://[::1]:8080',
    'http://10.0.0.5:8000',
    'http://192.168.1.50:8000',
    'http://172.16.4.1:8000',
    'http://172.31.255.1:8000',
    'http://workstation.local:8000',
  ]) {
    assert.equal(isLocalEndpoint(url), true, `${url} should be local`);
  }

  for (const url of [
    'https://api.openai.com/v1',
    'https://gateway.example.com/v1',
    // Just outside the private range — an off-by-one here would leak traffic
    // off the network for a buyer who set the flag precisely to stop that.
    'http://172.15.0.1:8000',
    'http://172.32.0.1:8000',
    'http://11.0.0.1:8000',
    'http://192.169.1.1:8000',
    'not a url',
    '',
  ]) {
    assert.equal(isLocalEndpoint(url), false, `${url} should not be local`);
  }
  assert.equal(isLocalEndpoint(null), false);
});

test('a local-defaulting kind with no explicit baseUrl counts as local', () => {
  // ollama and lmstudio default to loopback, so a row with no URL is local by
  // construction — requiring one would make the common setup fail the filter.
  assert.equal(isLocalConnection('ollama', null), true);
  assert.equal(isLocalConnection('lmstudio', null), true);
  // omniroute and openai-compatible can point anywhere, so an unspecified URL
  // is not enough to call them local.
  assert.equal(isLocalConnection('omniroute', null), false);
  assert.equal(isLocalConnection('openai-compatible', null), false);
});
