import type Database from 'better-sqlite3';
import { ChimeraError } from '@chimera/errors';

// The only code permitted to write SQL against `node_states`. Mirrors
// migrations/0001_init.sql exactly. `checkpoint_json` is an opaque string here:
// its shape belongs to packages/core, and packages/store does not import it.

export interface NodeStateRecord {
  runId: string;
  nodeId: string;
  status: string;
  iterationCount: number;
  tokensUsed: number;
  costUsed: number;
  checkpointJson: string | null;
}

interface NodeStateRow {
  run_id: string;
  node_id: string;
  status: string;
  iteration_count: number;
  tokens_used: number;
  cost_used: number;
  checkpoint_json: string | null;
}

function toRecord(row: NodeStateRow): NodeStateRecord {
  return {
    runId: row.run_id,
    nodeId: row.node_id,
    status: row.status,
    iterationCount: row.iteration_count,
    tokensUsed: row.tokens_used,
    costUsed: row.cost_used,
    checkpointJson: row.checkpoint_json,
  };
}

/**
 * Writes one node's state, replacing any previous row for that node.
 *
 * A failed write is raised as a typed `STORE_WRITE_FAILED` rather than letting
 * better-sqlite3's own error escape: a full disk is the failure this journal is
 * most likely to meet, and the caller has to be able to tell "the checkpoint
 * did not land" from any other exception without matching on message text.
 * The statement is a single atomic upsert, so a failure leaves the previously
 * journaled row exactly as it was.
 */
export function upsert(db: Database.Database, record: NodeStateRecord): void {
  try {
    db.prepare(
      `INSERT INTO node_states (
         run_id, node_id, status, iteration_count, tokens_used, cost_used, checkpoint_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, node_id) DO UPDATE SET
         status = excluded.status,
         iteration_count = excluded.iteration_count,
         tokens_used = excluded.tokens_used,
         cost_used = excluded.cost_used,
         checkpoint_json = excluded.checkpoint_json`,
    ).run(
      record.runId,
      record.nodeId,
      record.status,
      record.iterationCount,
      record.tokensUsed,
      record.costUsed,
      record.checkpointJson,
    );
  } catch (err) {
    throw new ChimeraError(
      'STORE_WRITE_FAILED',
      `Could not journal node state for ${record.runId}/${record.nodeId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { runId: record.runId, nodeId: record.nodeId },
    );
  }
}

export function get(
  db: Database.Database,
  runId: string,
  nodeId: string,
): NodeStateRecord | undefined {
  const row = db
    .prepare('SELECT * FROM node_states WHERE run_id = ? AND node_id = ?')
    .get(runId, nodeId) as NodeStateRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function listForRun(db: Database.Database, runId: string): NodeStateRecord[] {
  return (
    db
      .prepare('SELECT * FROM node_states WHERE run_id = ? ORDER BY node_id')
      .all(runId) as NodeStateRow[]
  ).map(toRecord);
}

export function clearRun(db: Database.Database, runId: string): void {
  db.prepare('DELETE FROM node_states WHERE run_id = ?').run(runId);
}
