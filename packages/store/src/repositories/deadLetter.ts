import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

// The only code permitted to write SQL against `dead_letter`.

export interface DeadLetterRecord {
  id: string;
  runId: string;
  nodeId: string;
  itemIndex: number;
  itemJson: string;
  error: string;
  ts: string;
}

interface DeadLetterRow {
  id: string;
  run_id: string;
  node_id: string;
  item_index: number;
  item_json: string;
  error: string;
  ts: string;
}

function toRecord(row: DeadLetterRow): DeadLetterRecord {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    itemIndex: row.item_index,
    itemJson: row.item_json,
    error: row.error,
    ts: row.ts,
  };
}

export function record(
  db: Database.Database,
  input: { runId: string; nodeId: string; itemIndex: number; itemJson: string; error: string },
): DeadLetterRecord {
  const row: DeadLetterRecord = {
    id: randomUUID(),
    ...input,
    ts: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO dead_letter (id, run_id, node_id, item_index, item_json, error, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.runId, row.nodeId, row.itemIndex, row.itemJson, row.error, row.ts);

  return row;
}

/** Failures for a run, in the order the user's own list is in. */
export function listForRun(db: Database.Database, runId: string): DeadLetterRecord[] {
  const rows = db
    .prepare('SELECT * FROM dead_letter WHERE run_id = ? ORDER BY node_id, item_index')
    .all(runId) as DeadLetterRow[];
  return rows.map(toRecord);
}

export function countForNode(db: Database.Database, runId: string, nodeId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM dead_letter WHERE run_id = ? AND node_id = ?')
    .get(runId, nodeId) as { n: number };
  return row.n;
}
