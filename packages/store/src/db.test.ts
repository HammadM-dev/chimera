import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Every migration file on disk, in the order they must apply.
 *
 * Read from the directory rather than hardcoded. These tests originally
 * asserted a literal count of one and broke the moment M1-9 added
 * `0002_workspace_settings.sql` — a test that has to be edited every time a
 * migration lands is a test that will eventually be edited carelessly. The
 * invariant worth asserting is "every migration applies exactly once, in
 * order", which does not change.
 */
function migrationFilesOnDisk(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

test('fresh open applies every migration on disk, once each, in order', () => {
  withTempDbPath((dbPath) => {
    const db = openDatabase({ dbPath, migrationsDir });
    const rows = db.prepare('SELECT id, name FROM _migrations ORDER BY id').all() as Array<{
      id: number;
      name: string;
    }>;

    const expected = migrationFilesOnDisk();
    assert.ok(expected.length > 0, 'no migrations found — the fixture path is wrong');
    assert.deepEqual(
      rows.map((row) => row.name),
      expected,
    );
    // Ids come from the NNNN prefix, so they must match the filenames rather
    // than merely being sequential.
    assert.deepEqual(
      rows.map((row) => row.id),
      expected.map((name) => Number(name.slice(0, 4))),
    );
    db.close();
  });
});

test('re-opening an already-migrated database applies zero migrations and does not error', () => {
  withTempDbPath((dbPath) => {
    const first = openDatabase({ dbPath, migrationsDir });
    const before = (first.prepare('SELECT id FROM _migrations').all() as unknown[]).length;
    first.close();

    const second = openDatabase({ dbPath, migrationsDir });
    const after = (second.prepare('SELECT id FROM _migrations').all() as unknown[]).length;
    assert.equal(after, before, 'a second open must not re-apply or duplicate migration rows');
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
    'frontier_cost_usd',
    'saved_by_cache_usd',
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
    'role_id',
    'model',
  ],
  plugins: [
    'id',
    'name',
    'kind',
    'command',
    'args_json',
    'url',
    'env_json',
    'headers_json',
    'enabled',
    'tools_json',
    'last_error',
    'created_at',
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
  dead_letter: ['id', 'run_id', 'node_id', 'item_index', 'item_json', 'error', 'ts'],
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
  // Added by 0002 for M1-9's local-only mode. Not part of the original kernel
  // twelve — a workspace-scoped policy row rather than application data, and
  // documented as such in docs/ARCHITECTURE.md section 5.
  workspace_settings: [
    'id',
    'local_only_mode',
    'model_tiers_json',
    'cache_policy_json',
    'telemetry_json',
  ],
  // Added by 0003 for M2-5's role registry. Workspace-level configuration:
  // roles are shared by every workflow in a workspace, so tightening one
  // holds everywhere rather than in the workflow that happened to be edited.
  // Added by 0004 for M2-10's workspace facts: curated knowledge that outlives
  // a run, kept apart from `cache` because a user's own note must never be
  // evicted to make room for derived data.
  workspace_facts: ['key', 'value', 'source', 'updated_at'],
  // Added by 0005. Separate from workspace_facts because that is a small
  // curated store a person maintains and this is a growing record agents
  // write during runs — merging them would give a user's note and an agent's
  // guess the same shape and the same trust.
  memories: [
    'id',
    'kind',
    'subject',
    'body',
    'source',
    'run_id',
    'confidence',
    'tags_json',
    'created_at',
    'updated_at',
  ],
  file_grants: ['path', 'granted_at'],
  roles: [
    'id',
    'name',
    'system_prompt',
    'tool_allowlist_json',
    'model_binding_json',
    'budget_json',
    'output_contract_json',
    'max_iterations',
    'is_builtin',
    'updated_at',
    'combines_many',
  ],
};

test('every documented table exists with exactly the documented columns', () => {
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
