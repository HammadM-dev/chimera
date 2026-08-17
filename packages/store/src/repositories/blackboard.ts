import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ChimeraError } from '@chimera/errors';

// F5.3's blackboard: the shared state a swarm works on.
//
// Append-only, and that is the design rather than a limitation. Several agents
// writing to one key at the same time is the normal case in a swarm, and a
// store that overwrote would silently lose whichever write lost the race — with
// no record that there had been a race at all. Appending keeps both, attributes
// both, and lets "the current value" be a reading rule instead of a lock.

export interface BlackboardEntry {
  id: string;
  runId: string;
  roleId: string;
  key: string;
  valueJson: string;
  writtenAt: string;
  scope: string;
}

interface BlackboardRow {
  id: string;
  run_id: string;
  role_id: string;
  key: string;
  value_json: string;
  written_at: string;
  scope: string;
}

function toEntry(row: BlackboardRow): BlackboardEntry {
  return {
    id: row.id,
    runId: row.run_id,
    roleId: row.role_id,
    key: row.key,
    valueJson: row.value_json,
    writtenAt: row.written_at,
    scope: row.scope,
  };
}

export interface WriteInput {
  runId: string;
  roleId: string;
  key: string;
  valueJson: string;
  scope: string;
  /**
   * The scopes this role may write to.
   *
   * Checked here rather than trusted from the caller, for the reason every
   * other allowlist in this codebase is checked at the boundary it protects: a
   * rule enforced only where it is convenient is a rule with a bypass.
   */
  writeScopes: readonly string[];
}

/**
 * Appends one entry.
 *
 * Never updates. Two writes to the same key are two rows, and the reader
 * decides which one is current.
 */
export function write(db: Database.Database, input: WriteInput): BlackboardEntry {
  if (!input.writeScopes.includes(input.scope) && !input.writeScopes.includes('*')) {
    throw new ChimeraError(
      'BLACKBOARD_SCOPE_NOT_ALLOWED',
      `"${input.roleId}" may not write to the "${input.scope}" scope.`,
      { roleId: input.roleId, scope: input.scope, allowed: [...input.writeScopes] },
    );
  }

  const entry: BlackboardEntry = {
    id: randomUUID(),
    runId: input.runId,
    roleId: input.roleId,
    key: input.key,
    valueJson: input.valueJson,
    writtenAt: new Date().toISOString(),
    scope: input.scope,
  };

  db.prepare(
    `INSERT INTO blackboard_entries (id, run_id, role_id, key, value_json, written_at, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.runId,
    entry.roleId,
    entry.key,
    entry.valueJson,
    entry.writtenAt,
    entry.scope,
  );

  return entry;
}

/** Every entry for a run, oldest first. The history, not the current state. */
export function history(
  db: Database.Database,
  runId: string,
  options: { key?: string; scope?: string } = {},
): BlackboardEntry[] {
  const clauses = ['run_id = ?'];
  const values: unknown[] = [runId];
  if (options.key !== undefined) {
    clauses.push('key = ?');
    values.push(options.key);
  }
  if (options.scope !== undefined) {
    clauses.push('scope = ?');
    values.push(options.scope);
  }

  const rows = db
    .prepare(
      `SELECT * FROM blackboard_entries
       WHERE ${clauses.join(' AND ')}
       ORDER BY written_at ASC, rowid ASC`,
    )
    .all(...values) as BlackboardRow[];
  return rows.map(toEntry);
}

/**
 * The current value of a key: the latest write within the scopes given.
 *
 * "Latest" is by insertion order, not by timestamp. Two writes in the same
 * millisecond are ordinary at swarm speeds, and an ISO string cannot separate
 * them — `rowid` can, and it is the order they actually happened in.
 */
export function current(
  db: Database.Database,
  runId: string,
  key: string,
  readScopes?: readonly string[],
): BlackboardEntry | undefined {
  if (readScopes && readScopes.length === 0) return undefined;

  const scopeClause =
    readScopes && !readScopes.includes('*')
      ? ` AND scope IN (${readScopes.map(() => '?').join(', ')})`
      : '';

  const row = db
    .prepare(
      `SELECT * FROM blackboard_entries
       WHERE run_id = ? AND key = ?${scopeClause}
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(runId, key, ...(scopeClause === '' ? [] : (readScopes ?? []))) as
    BlackboardRow | undefined;

  return row ? toEntry(row) : undefined;
}

/** The current value of every key a run has written, for a reader's scopes. */
export function snapshot(
  db: Database.Database,
  runId: string,
  readScopes?: readonly string[],
): BlackboardEntry[] {
  const keys = db
    .prepare('SELECT DISTINCT key FROM blackboard_entries WHERE run_id = ?')
    .all(runId) as { key: string }[];

  return keys
    .map((row) => current(db, runId, row.key, readScopes))
    .filter((entry): entry is BlackboardEntry => entry !== undefined)
    .sort((a, b) => a.key.localeCompare(b.key));
}
