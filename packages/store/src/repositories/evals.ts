import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

// The only code permitted to write SQL against `evals` and `eval_runs`.
//
// The cases themselves live in the workflow definition — they travel with the
// file, so an automation somebody sends you arrives with its tests. These two
// tables are the workspace's own record: which cases a workflow has, and how
// they have gone.

export interface EvalRunRecord {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  evalId: string;
  ranAt: string;
  passFail: string;
  assertionsJson: string;
  provider: string;
}

interface EvalRunRow {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  eval_id: string;
  ran_at: string;
  pass_fail: string;
  assertions_json: string;
  provider: string;
}

function toRecord(row: EvalRunRow): EvalRunRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    evalId: row.eval_id,
    ranAt: row.ran_at,
    passFail: row.pass_fail,
    assertionsJson: row.assertions_json,
    provider: row.provider,
  };
}

/** Records which cases this workflow has, and forgets the ones it no longer does. */
export function register(db: Database.Database, workflowId: string, evalIds: string[]): void {
  const remove = db.prepare('DELETE FROM evals WHERE workflow_id = ?');
  const add = db.prepare(
    'INSERT INTO evals (workflow_id, eval_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
  );

  const write = db.transaction(() => {
    remove.run(workflowId);
    for (const evalId of evalIds) add.run(workflowId, evalId);
  });
  write();
}

export function recordRun(
  db: Database.Database,
  input: Omit<EvalRunRecord, 'id' | 'ranAt'>,
): EvalRunRecord {
  const record: EvalRunRecord = { id: randomUUID(), ranAt: new Date().toISOString(), ...input };
  db.prepare(
    `INSERT INTO eval_runs
       (id, workflow_id, workflow_version_id, eval_id, ran_at, pass_fail, assertions_json, provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.workflowId,
    record.workflowVersionId,
    record.evalId,
    record.ranAt,
    record.passFail,
    record.assertionsJson,
    record.provider,
  );
  return record;
}

/**
 * The most recent result for each case of a workflow.
 *
 * Latest-per-case rather than every row: "does this automation pass its tests"
 * is a question about now, and the history is only interesting once you know
 * the answer is no.
 */
export function latestResults(db: Database.Database, workflowId: string): EvalRunRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM eval_runs
       WHERE workflow_id = ?
         AND ran_at = (
           SELECT MAX(inner.ran_at) FROM eval_runs inner
           WHERE inner.workflow_id = eval_runs.workflow_id AND inner.eval_id = eval_runs.eval_id
         )
       ORDER BY eval_id`,
    )
    .all(workflowId) as EvalRunRow[];
  return rows.map(toRecord);
}

/**
 * True when every case this workflow declares passed *on this version*.
 *
 * Scoped to the version deliberately. A workflow trusted on the strength of
 * tests that passed two edits ago is a workflow whose tag means nothing, which
 * is the whole reason the tag exists.
 */
export function allPassingOnVersion(
  db: Database.Database,
  workflowId: string,
  workflowVersionId: string,
  evalIds: readonly string[],
): boolean {
  if (evalIds.length === 0) return false;

  const rows = db
    .prepare(
      `SELECT eval_id, pass_fail, ran_at FROM eval_runs
       WHERE workflow_id = ? AND workflow_version_id = ?
       ORDER BY ran_at ASC`,
    )
    .all(workflowId, workflowVersionId) as { eval_id: string; pass_fail: string }[];

  // Last word per case: a case that failed, was fixed and passed is passing.
  const latest = new Map<string, string>();
  for (const row of rows) latest.set(row.eval_id, row.pass_fail);

  return evalIds.every((evalId) => latest.get(evalId) === 'pass');
}
