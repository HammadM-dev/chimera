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

/**
 * What `upsert` writes.
 *
 * Deliberately without the two spend columns. Spend accumulates through
 * `addSpend`, and a checkpoint write that carried a spend figure would reset it
 * to whatever the caller happened to pass — which, for a caller whose job is
 * journaling resumable state rather than accounting, is zero.
 */
export type UpsertNodeStateInput = Omit<NodeStateRecord, 'tokensUsed' | 'costUsed'>;

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
export function upsert(db: Database.Database, record: UpsertNodeStateInput): void {
  try {
    db.prepare(
      `INSERT INTO node_states (
         run_id, node_id, status, iteration_count, checkpoint_json
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, node_id) DO UPDATE SET
         status = excluded.status,
         iteration_count = excluded.iteration_count,
         checkpoint_json = excluded.checkpoint_json`,
    ).run(record.runId, record.nodeId, record.status, record.iterationCount, record.checkpointJson);
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

/**
 * Adds to a node's running spend, creating the row if the node has not been
 * journaled yet.
 *
 * Additive rather than absolute so two writers — the checkpoint journal and the
 * spend meter — cannot overwrite each other's column.
 */
export function addSpend(
  db: Database.Database,
  runId: string,
  nodeId: string,
  tokens: number,
  costUsd: number,
  attribution: { roleId?: string; model?: string } = {},
): void {
  db.prepare(
    `INSERT INTO node_states
       (run_id, node_id, status, iteration_count, tokens_used, cost_used, role_id, model)
     VALUES (?, ?, 'running', 0, ?, ?, ?, ?)
     ON CONFLICT(run_id, node_id) DO UPDATE SET
       tokens_used = node_states.tokens_used + excluded.tokens_used,
       cost_used = node_states.cost_used + excluded.cost_used,
       -- Written once and left alone: a node runs as one role, and a resumed
       -- run re-reporting the same pair should not blank it if a later call
       -- happens to arrive without one.
       role_id = COALESCE(excluded.role_id, node_states.role_id),
       model = COALESCE(excluded.model, node_states.model)`,
  ).run(runId, nodeId, tokens, costUsd, attribution.roleId ?? null, attribution.model ?? null);
}

export interface SpendRow {
  runId: string;
  nodeId: string;
  roleId: string | null;
  model: string | null;
  tokensUsed: number;
  costUsed: number;
  startedAt: string;
  workflowId: string;
  inputJson: string;
}

/**
 * Every node's spend in a window, with enough of its run to group by.
 *
 * One query rather than a query per run: a workspace with a year of runs has
 * tens of thousands of node rows, and a dashboard that made a round trip per
 * run would be the slowest screen in the app.
 */
export function spendSince(db: Database.Database, sinceIso: string): SpendRow[] {
  const rows = db
    .prepare(
      `SELECT n.run_id, n.node_id, n.role_id, n.model, n.tokens_used, n.cost_used,
              r.started_at, r.workflow_id, r.input_json
       FROM node_states n
       JOIN runs r ON r.id = n.run_id
       WHERE r.started_at >= ?
       ORDER BY r.started_at DESC`,
    )
    .all(sinceIso) as {
    run_id: string;
    node_id: string;
    role_id: string | null;
    model: string | null;
    tokens_used: number;
    cost_used: number;
    started_at: string;
    workflow_id: string;
    input_json: string;
  }[];

  return rows.map((row) => ({
    runId: row.run_id,
    nodeId: row.node_id,
    roleId: row.role_id,
    model: row.model,
    tokensUsed: row.tokens_used,
    costUsed: row.cost_used,
    startedAt: row.started_at,
    workflowId: row.workflow_id,
    inputJson: row.input_json,
  }));
}

export function clearRun(db: Database.Database, runId: string): void {
  db.prepare('DELETE FROM node_states WHERE run_id = ?').run(runId);
}
