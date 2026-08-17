import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

// The only code permitted to write SQL against `workflows` and
// `workflow_versions`. An automation is a workflow; each save is a new version,
// so a run started against one is not changed underneath it by an edit made
// while it was going.

export interface WorkflowSummary {
  id: string;
  name: string;
  updatedAt: string;
  latestVersionId: string | null;
}

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  versionNumber: number;
  definitionJson: string;
  createdAt: string;
}

interface WorkflowRow {
  id: string;
  name: string;
  updated_at: string;
  latest_version_id: string | null;
}

interface VersionRow {
  id: string;
  workflow_id: string;
  version_number: number;
  definition_json: string;
  created_at: string;
}

/** The reserved row ad-hoc runs attach to. Never a saved automation. */
const AD_HOC = '00000000-0000-0000-0000-00000000ad0c';

export function list(db: Database.Database): WorkflowSummary[] {
  return (
    db
      .prepare(
        `SELECT id, name, updated_at, latest_version_id FROM workflows
         WHERE id != ? AND archived_at IS NULL ORDER BY updated_at DESC`,
      )
      .all(AD_HOC) as WorkflowRow[]
  ).map((row) => ({
    id: row.id,
    name: row.name,
    updatedAt: row.updated_at,
    latestVersionId: row.latest_version_id,
  }));
}

/**
 * Saves an automation as a new version.
 *
 * Always a new version, never an overwrite: a run holds the version id it
 * started with, so editing an automation while it runs changes what happens
 * next time rather than what is happening now.
 */
export function save(
  db: Database.Database,
  input: { workflowId?: string; name: string; definitionJson: string },
): { workflowId: string; versionId: string; versionNumber: number } {
  const now = new Date().toISOString();
  const workflowId = input.workflowId ?? randomUUID();
  const versionId = randomUUID();

  const existing = db.prepare('SELECT id FROM workflows WHERE id = ?').get(workflowId);
  if (!existing) {
    db.prepare('INSERT INTO workflows (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      workflowId,
      input.name,
      now,
      now,
    );
  }

  const previous = db
    .prepare(
      'SELECT COALESCE(MAX(version_number), 0) AS n FROM workflow_versions WHERE workflow_id = ?',
    )
    .get(workflowId) as { n: number };
  const versionNumber = previous.n + 1;

  // Schema 3: M5 added the fan-out, aggregate and swarm node types and
  // `steps[].tier`. Schema 2 added the other node types, pre-authorisation and
  // layout. Every added field is optional, so a version 1 definition still
  // loads — the number records what wrote it, not what can read it.
  db.prepare(
    `INSERT INTO workflow_versions
       (id, workflow_id, version_number, schema_version, definition_json, created_at, created_by)
     VALUES (?, ?, ?, 3, ?, ?, 'user')`,
  ).run(versionId, workflowId, versionNumber, input.definitionJson, now);

  db.prepare(
    'UPDATE workflows SET name = ?, updated_at = ?, latest_version_id = ? WHERE id = ?',
  ).run(input.name, now, versionId, workflowId);

  return { workflowId, versionId, versionNumber };
}

/** The latest version of an automation, or a specific one. */
export function get(
  db: Database.Database,
  workflowId: string,
  versionId?: string,
): WorkflowVersion | undefined {
  const row = (
    versionId === undefined
      ? db
          .prepare(
            `SELECT v.* FROM workflow_versions v
             JOIN workflows w ON w.latest_version_id = v.id
             WHERE w.id = ?`,
          )
          .get(workflowId)
      : db.prepare('SELECT * FROM workflow_versions WHERE id = ?').get(versionId)
  ) as VersionRow | undefined;

  return row
    ? {
        id: row.id,
        workflowId: row.workflow_id,
        versionNumber: row.version_number,
        definitionJson: row.definition_json,
        createdAt: row.created_at,
      }
    : undefined;
}

export function remove(db: Database.Database, workflowId: string): void {
  // Archived, not deleted: runs reference their version, and a foreign key
  // that stops you removing history is the schema working rather than failing.
  db.prepare('UPDATE workflows SET archived_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    workflowId,
  );
}
