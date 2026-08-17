import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

// The only code permitted to write SQL against `runs`, and — for now — the
// minimum of `workflows`/`workflow_versions` needed to satisfy the foreign keys
// a run carries. M4 builds those two out properly; this file creates exactly
// the rows `node_states` cannot exist without.

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  triggerType: string;
  inputJson: string;
  errorSummary: string | null;
}

interface RunRow {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  trigger_type: string;
  input_json: string;
  budget_tokens_used: number;
  budget_cost_usd_used: number;
  error_summary: string | null;
}

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    triggerType: row.trigger_type,
    inputJson: row.input_json,
    errorSummary: row.error_summary,
  };
}

/**
 * The reserved workflow every workflow-less agent run belongs to.
 *
 * A run's `workflow_id` and `workflow_version_id` are `NOT NULL REFERENCES`,
 * and M2 has agent runs but no workflows yet. Rather than weakening the schema
 * for the milestone that happens to come first — a foreign key removed for
 * convenience is never put back — those runs attach to one reserved row, with a
 * fixed id so it is recognisable and filterable rather than looking like a
 * workflow the user created and forgot.
 */
export const AD_HOC_WORKFLOW_ID = '00000000-0000-0000-0000-00000000ad0c';
const AD_HOC_VERSION_ID = '00000000-0000-0000-0000-00000000ad01';

export function ensureAdHocWorkflow(db: Database.Database): {
  workflowId: string;
  workflowVersionId: string;
} {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO workflows (id, name, created_at, updated_at, latest_version_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(AD_HOC_WORKFLOW_ID, 'Ad-hoc agent runs', now, now, AD_HOC_VERSION_ID);

  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version_number, schema_version, definition_json, created_at, created_by
     ) VALUES (?, ?, 1, 1, ?, ?, 'chimera')
     ON CONFLICT(id) DO NOTHING`,
  ).run(AD_HOC_VERSION_ID, AD_HOC_WORKFLOW_ID, '{"nodes":[],"edges":[]}', now);

  return { workflowId: AD_HOC_WORKFLOW_ID, workflowVersionId: AD_HOC_VERSION_ID };
}

export interface CreateRunInput {
  id?: string;
  workflowId?: string;
  workflowVersionId?: string;
  status?: string;
  triggerType?: string;
  inputJson?: string;
}

export function create(db: Database.Database, input: CreateRunInput = {}): RunRecord {
  const adHoc = ensureAdHocWorkflow(db);
  const record: RunRecord = {
    id: input.id ?? randomUUID(),
    workflowId: input.workflowId ?? adHoc.workflowId,
    workflowVersionId: input.workflowVersionId ?? adHoc.workflowVersionId,
    status: input.status ?? 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    triggerType: input.triggerType ?? 'manual',
    inputJson: input.inputJson ?? '{}',
    errorSummary: null,
  };

  db.prepare(
    `INSERT INTO runs (
       id, workflow_id, workflow_version_id, status, started_at, trigger_type, input_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    record.id,
    record.workflowId,
    record.workflowVersionId,
    record.status,
    record.startedAt,
    record.triggerType,
    record.inputJson,
  );

  const stored = get(db, record.id);
  if (!stored) throw new Error(`Run "${record.id}" vanished immediately after being written`);
  return stored;
}

export function get(db: Database.Database, id: string): RunRecord | undefined {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  return row ? toRecord(row) : undefined;
}

/** Adds to the run's totals. Additive for the same reason node spend is. */
export function addSpend(
  db: Database.Database,
  runId: string,
  tokens: number,
  costUsd: number,
): void {
  db.prepare(
    `UPDATE runs
     SET budget_tokens_used = budget_tokens_used + ?,
         budget_cost_usd_used = budget_cost_usd_used + ?
     WHERE id = ?`,
  ).run(tokens, costUsd, runId);
}

export function spendOf(db: Database.Database, runId: string): { tokens: number; costUsd: number } {
  const row = db
    .prepare(
      'SELECT budget_tokens_used AS tokens, budget_cost_usd_used AS cost FROM runs WHERE id = ?',
    )
    .get(runId) as { tokens: number; cost: number } | undefined;
  return { tokens: row?.tokens ?? 0, costUsd: row?.cost ?? 0 };
}

/**
 * Moves a run between non-terminal states.
 *
 * Separate from `finish` because it must not stamp `ended_at`: a run waiting
 * for an approval has not ended, and a row that claims it has is a row nothing
 * will pick back up.
 */
export function setStatus(db: Database.Database, id: string, status: string): void {
  db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id);
}

export interface RunSummary extends RunRecord {
  tokensUsed: number;
  costUsd: number;
}

/** The most recent runs, newest first, with what each one spent. */
export function listRecent(db: Database.Database, limit = 50): RunSummary[] {
  const rows = db
    .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
    .all(limit) as RunRow[];
  return rows.map((row) => ({
    ...toRecord(row),
    tokensUsed: row.budget_tokens_used,
    costUsd: row.budget_cost_usd_used,
  }));
}

export function listByStatus(db: Database.Database, status: string): RunRecord[] {
  const rows = db
    .prepare('SELECT * FROM runs WHERE status = ? ORDER BY started_at DESC')
    .all(status) as RunRow[];
  return rows.map(toRecord);
}

export function finish(
  db: Database.Database,
  id: string,
  status: string,
  errorSummary: string | null = null,
): void {
  db.prepare('UPDATE runs SET status = ?, ended_at = ?, error_summary = ? WHERE id = ?').run(
    status,
    new Date().toISOString(),
    errorSummary,
    id,
  );
}
