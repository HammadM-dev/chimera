import type Database from 'better-sqlite3';

// The only code permitted to write SQL against `cache`.
//
// Two kinds live here. An `exact` entry answers the identical prompt to the
// identical model — safe by construction, because nothing about the question
// changed. A `semantic` entry answers a *similar* prompt, which is a different
// claim entirely and is why it is off unless a workspace turns it on.

export interface CacheEntry {
  keyHash: string;
  kind: string;
  /** The prompt's vector, for semantic lookups. Absent for exact entries. */
  embedding: number[] | null;
  responseJson: string;
  createdAt: string;
  hits: number;
  workflowId: string | null;
}

interface CacheRow {
  key_hash: string;
  kind: string;
  embedding: Buffer | null;
  response_json: string;
  created_at: string;
  hits: number;
  workflow_id: string | null;
}

/**
 * Vectors are stored as raw float32, not JSON.
 *
 * A 1536-dimension embedding is 6KB as bytes and about 20KB as JSON text, and
 * every semantic lookup reads every candidate. The difference is the whole
 * budget of the feature.
 */
function toBlob(embedding: number[] | null): Buffer | null {
  if (!embedding || embedding.length === 0) return null;
  return Buffer.from(new Float32Array(embedding).buffer);
}

function fromBlob(blob: Buffer | null): number[] | null {
  if (!blob || blob.length === 0) return null;
  const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.length / 4);
  return [...floats];
}

function toEntry(row: CacheRow): CacheEntry {
  return {
    keyHash: row.key_hash,
    kind: row.kind,
    embedding: fromBlob(row.embedding),
    responseJson: row.response_json,
    createdAt: row.created_at,
    hits: row.hits,
    workflowId: row.workflow_id,
  };
}

export function put(
  db: Database.Database,
  input: {
    keyHash: string;
    kind: string;
    responseJson: string;
    embedding?: number[] | null;
    workflowId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO cache (key_hash, kind, embedding, response_json, created_at, hits, workflow_id)
     VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(key_hash) DO UPDATE SET
       response_json = excluded.response_json,
       embedding = excluded.embedding,
       created_at = excluded.created_at`,
  ).run(
    input.keyHash,
    input.kind,
    toBlob(input.embedding ?? null),
    input.responseJson,
    new Date().toISOString(),
    input.workflowId ?? null,
  );
}

export function getExact(db: Database.Database, keyHash: string): CacheEntry | undefined {
  const row = db.prepare('SELECT * FROM cache WHERE key_hash = ?').get(keyHash) as
    CacheRow | undefined;
  return row ? toEntry(row) : undefined;
}

/** Candidates for a semantic lookup: everything with a vector, newest first. */
export function withEmbeddings(db: Database.Database, limit = 500): CacheEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM cache
       WHERE kind = 'semantic' AND embedding IS NOT NULL
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as CacheRow[];
  return rows.map(toEntry);
}

/** Counts a hit. Separate from reading, so a lookup that finds nothing counts nothing. */
export function recordHit(db: Database.Database, keyHash: string): void {
  db.prepare('UPDATE cache SET hits = hits + 1 WHERE key_hash = ?').run(keyHash);
}

export function stats(db: Database.Database): { entries: number; hits: number } {
  const row = db
    .prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits FROM cache')
    .get() as { entries: number; hits: number };
  return row;
}

export function clear(db: Database.Database): void {
  db.prepare('DELETE FROM cache').run();
}
