import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

// The only code permitted to write SQL against `memories`.

export type MemoryKind =
  'fact' | 'project' | 'goal' | 'habit' | 'preference' | 'decision' | 'person' | 'tool';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'fact',
  'project',
  'goal',
  'habit',
  'preference',
  'decision',
  'person',
  'tool',
];

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  subject: string;
  body: string;
  source: string;
  runId: string | null;
  confidence: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WriteMemoryInput {
  id?: string;
  kind: MemoryKind;
  subject: string;
  body: string;
  source: string;
  runId?: string | null;
  confidence?: number;
  tags?: string[];
}

interface MemoryRow {
  id: string;
  kind: string;
  subject: string;
  body: string;
  source: string;
  run_id: string | null;
  confidence: number;
  tags_json: string;
  created_at: string;
  updated_at: string;
}

function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    kind: row.kind as MemoryKind,
    subject: row.subject,
    body: row.body,
    source: row.source,
    runId: row.run_id,
    confidence: row.confidence,
    tags: JSON.parse(row.tags_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Writes a memory, replacing one that says the same thing about the same
 * subject.
 *
 * Deduplicated on (kind, subject, body) rather than appended blindly: an agent
 * that learns the same fact on every run would otherwise turn one true thing
 * into forty rows, and a memory list nobody can read is a memory nobody uses.
 */
export function remember(db: Database.Database, input: WriteMemoryInput): MemoryRecord {
  const now = new Date().toISOString();

  const existing = db
    .prepare('SELECT id, created_at FROM memories WHERE kind = ? AND subject = ? AND body = ?')
    .get(input.kind, input.subject, input.body) as { id: string; created_at: string } | undefined;

  const id = existing?.id ?? input.id ?? randomUUID();

  db.prepare(
    `INSERT INTO memories
       (id, kind, subject, body, source, run_id, confidence, tags_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source = excluded.source,
       run_id = excluded.run_id,
       confidence = MAX(memories.confidence, excluded.confidence),
       tags_json = excluded.tags_json,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    input.kind,
    input.subject,
    input.body,
    input.source,
    input.runId ?? null,
    input.confidence ?? 0.6,
    JSON.stringify(input.tags ?? []),
    existing?.created_at ?? now,
    now,
  );

  const stored = get(db, id);
  if (!stored) throw new Error(`Memory "${id}" vanished immediately after being written`);
  return stored;
}

export function get(db: Database.Database, id: string): MemoryRecord | undefined {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function list(db: Database.Database): MemoryRecord[] {
  return (db.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all() as MemoryRow[]).map(
    toRecord,
  );
}

/** Substring search across subject, body and tags. */
export function search(db: Database.Database, query: string, limit = 20): MemoryRecord[] {
  const like = `%${query}%`;
  return (
    db
      .prepare(
        `SELECT * FROM memories
         WHERE subject LIKE ? OR body LIKE ? OR tags_json LIKE ?
         ORDER BY confidence DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(like, like, like, limit) as MemoryRow[]
  ).map(toRecord);
}

export function forget(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
}

export function countByKind(db: Database.Database): Record<string, number> {
  const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind').all() as {
    kind: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((row) => [row.kind, row.n]));
}
