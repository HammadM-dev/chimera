import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from './db.ts';

const migrationsDir = path.join(import.meta.dirname, 'migrations');

function withTempDbPath(fn: (dbPath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'chimera-db-test-'));
  try {
    fn(path.join(dir, 'chimera.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('fresh open creates the file, applies 0001_init.sql, and records one migration', () => {
  withTempDbPath((dbPath) => {
    const db = openDatabase({ dbPath, migrationsDir });
    const rows = db.prepare('SELECT id, name FROM _migrations').all() as Array<{
      id: number;
      name: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, 1);
    assert.equal(rows[0]?.name, '0001_init.sql');
    db.close();
  });
});

test('re-opening an already-migrated database applies zero migrations and does not error', () => {
  withTempDbPath((dbPath) => {
    const first = openDatabase({ dbPath, migrationsDir });
    first.close();

    const second = openDatabase({ dbPath, migrationsDir });
    const rows = second.prepare('SELECT id FROM _migrations').all();
    assert.equal(rows.length, 1, 'a second open must not re-apply or duplicate the migration row');
    second.close();
  });
});

test('journal_mode is wal after init (file-backed database, not :memory:)', () => {
  withTempDbPath((dbPath) => {
    const db = openDatabase({ dbPath, migrationsDir });
    const mode = db.pragma('journal_mode', { simple: true });
    assert.equal(mode, 'wal');
    db.close();
  });
});

const EXPECTED_COLUMNS: Record<string, string[]> = {
  workflows: [
    'id',
    'name',
    'created_at',
    'updated_at',
    'latest_version_id',
    'production_version_id',
    'archived_at',
  ],
  workflow_versions: [
    'id',
    'workflow_id',
    'version_number',
    'schema_version',
    'definition_json',
    'created_at',
    'created_by',
    'tag',
  ],
  runs: [
    'id',
    'workflow_id',
    'workflow_version_id',
    'status',
    'started_at',
    'ended_at',
    'trigger_type',
    'input_json',
    'budget_tokens_used',
    'budget_cost_usd_used',
    'error_summary',
  ],
  traces: [
    'id',
    'run_id',
    'node_id',
    'seq',
    'ts',
    'event_type',
    'payload_json',
    'tokens_in',
    'tokens_out',
    'cost_usd',
  ],
  node_states: [
    'run_id',
    'node_id',
    'status',
    'iteration_count',
    'tokens_used',
    'cost_used',
    'checkpoint_json',
  ],
  cache: ['key_hash', 'kind', 'embedding', 'response_json', 'created_at', 'hits', 'workflow_id'],
  connections: [
    'id',
    'label',
    'kind',
    'base_url',
    'auth_ref',
    'capabilities_json',
    'health_state',
    'created_at',
  ],
  licence: ['id', 'tier', 'activation_token_ref', 'activated_at', 'grace_expires_at', 'seat_id'],
  blackboard_entries: ['id', 'run_id', 'role_id', 'key', 'value_json', 'written_at', 'scope'],
  dead_letter: ['run_id', 'node_id', 'item_json', 'error', 'ts'],
  evals: ['workflow_id', 'eval_id'],
  eval_runs: [
    'id',
    'workflow_id',
    'workflow_version_id',
    'eval_id',
    'ran_at',
    'pass_fail',
    'assertions_json',
    'provider',
  ],
};

test('all twelve kernel tables exist with exactly the documented columns', () => {
  withTempDbPath((dbPath) => {
    const db = openDatabase({ dbPath, migrationsDir });

    const tableNames = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != '_migrations'")
        .all() as Array<{ name: string }>
    )
      .map((r) => r.name)
      .sort();

    assert.deepEqual(tableNames, Object.keys(EXPECTED_COLUMNS).sort());

    for (const [table, expectedColumns] of Object.entries(EXPECTED_COLUMNS)) {
      const actualColumns = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
        (c) => c.name,
      );
      assert.deepEqual(actualColumns, expectedColumns, `column mismatch for table "${table}"`);
    }

    db.close();
  });
});

test('rejects a migration file whose name does not match NNNN_description.sql', () => {
  withTempDbPath((dbPath) => {
    const badDir = mkdtempSync(path.join(tmpdir(), 'chimera-bad-migrations-'));
    try {
      writeFileSync(path.join(badDir, 'not-numbered.sql'), 'CREATE TABLE x (id TEXT);');
      assert.throws(() => openDatabase({ dbPath, migrationsDir: badDir }), /does not match/);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });
});
