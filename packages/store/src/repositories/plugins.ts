import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

// The only code permitted to write SQL against `plugins`.

export interface PluginRecord {
  id: string;
  name: string;
  kind: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  /** Variable name to vault handle. Values are never here. */
  env: Record<string, string>;
  headers: Record<string, string>;
  enabled: boolean;
  /** What it advertised last time it connected. */
  tools: { name: string; description: string }[];
  lastError: string;
  createdAt: string;
}

interface PluginRow {
  id: string;
  name: string;
  kind: 'stdio' | 'http';
  command: string;
  args_json: string;
  url: string;
  env_json: string;
  headers_json: string;
  enabled: number;
  tools_json: string;
  last_error: string;
  created_at: string;
}

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: PluginRow): PluginRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    command: row.command,
    args: parse<string[]>(row.args_json, []),
    url: row.url,
    env: parse<Record<string, string>>(row.env_json, {}),
    headers: parse<Record<string, string>>(row.headers_json, {}),
    enabled: row.enabled === 1,
    tools: parse<{ name: string; description: string }[]>(row.tools_json, []),
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export function list(db: Database.Database): PluginRecord[] {
  return (db.prepare('SELECT * FROM plugins ORDER BY name').all() as PluginRow[]).map(toRecord);
}

export function get(db: Database.Database, id: string): PluginRecord | undefined {
  const row = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id) as PluginRow | undefined;
  return row ? toRecord(row) : undefined;
}

export type SavePluginInput = Omit<PluginRecord, 'id' | 'createdAt' | 'tools' | 'lastError'> & {
  id?: string;
};

export function save(db: Database.Database, input: SavePluginInput): PluginRecord {
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO plugins
       (id, name, kind, command, args_json, url, env_json, headers_json, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       kind = excluded.kind,
       command = excluded.command,
       args_json = excluded.args_json,
       url = excluded.url,
       env_json = excluded.env_json,
       headers_json = excluded.headers_json,
       enabled = excluded.enabled`,
  ).run(
    id,
    input.name,
    input.kind,
    input.command,
    JSON.stringify(input.args),
    input.url,
    JSON.stringify(input.env),
    JSON.stringify(input.headers),
    input.enabled ? 1 : 0,
    new Date().toISOString(),
  );

  const stored = get(db, id);
  if (!stored) throw new Error(`Plugin "${id}" vanished immediately after being written`);
  return stored;
}

/** Records what a plugin advertised, or why it could not be reached. */
export function recordConnection(
  db: Database.Database,
  id: string,
  result: { tools: { name: string; description: string }[]; error: string },
): void {
  db.prepare('UPDATE plugins SET tools_json = ?, last_error = ? WHERE id = ?').run(
    JSON.stringify(result.tools),
    result.error,
    id,
  );
}

export function remove(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM plugins WHERE id = ?').run(id);
}
