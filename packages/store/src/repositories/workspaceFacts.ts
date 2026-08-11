import type Database from 'better-sqlite3';

// The only code permitted to write SQL against `workspace_facts`.

export interface WorkspaceFact {
  key: string;
  value: string;
  /** `user`, or the id of the run that wrote it. */
  source: string;
  updatedAt: string;
}

interface FactRow {
  key: string;
  value: string;
  source: string;
  updated_at: string;
}

function toRecord(row: FactRow): WorkspaceFact {
  return { key: row.key, value: row.value, source: row.source, updatedAt: row.updated_at };
}

export function list(db: Database.Database): WorkspaceFact[] {
  return (db.prepare('SELECT * FROM workspace_facts ORDER BY key').all() as FactRow[]).map(
    toRecord,
  );
}

export function get(db: Database.Database, key: string): WorkspaceFact | undefined {
  const row = db.prepare('SELECT * FROM workspace_facts WHERE key = ?').get(key) as
    FactRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function set(
  db: Database.Database,
  key: string,
  value: string,
  source: string,
): WorkspaceFact {
  db.prepare(
    `INSERT INTO workspace_facts (key, value, source, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       source = excluded.source,
       updated_at = excluded.updated_at`,
  ).run(key, value, source, new Date().toISOString());

  const stored = get(db, key);
  if (!stored) throw new Error(`Workspace fact "${key}" vanished immediately after being written`);
  return stored;
}

export function remove(db: Database.Database, key: string): boolean {
  return db.prepare('DELETE FROM workspace_facts WHERE key = ?').run(key).changes > 0;
}
