import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

// The notes and reminders a workspace keeps.
//
// Shared ground between the person and the agents: they can both read it and
// both write to it. That is the point of it existing rather than being one more
// thing only the person sees — an assistant that notices a licence expires next
// month should be able to leave that where somebody will find it, and an
// automation asked to follow something up should be able to say so somewhere
// other than in a run trace nobody opens.
//
// Distinct from `memories` and `workspace_facts`, which look similar. Those are
// read by prompts; this is read by people.

export type NoteKind = 'note' | 'reminder';

export interface NoteRecord {
  id: string;
  kind: NoteKind;
  title: string;
  body: string;
  /** ISO 8601. Null for a note. */
  dueAt: string | null;
  /** ISO 8601 when it was ticked off. Null while outstanding. */
  doneAt: string | null;
  /** `user`, `assistant`, or the id of the run that wrote it. */
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface NoteRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  due_at: string | null;
  done_at: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

function toNote(row: NoteRow): NoteRecord {
  return {
    id: row.id,
    kind: row.kind === 'reminder' ? 'reminder' : 'note',
    title: row.title,
    body: row.body,
    dueAt: row.due_at,
    doneAt: row.done_at,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NoteInput {
  kind: NoteKind;
  title: string;
  body?: string;
  dueAt?: string | null;
  source?: string;
}

export function create(db: Database.Database, input: NoteInput): NoteRecord {
  const now = new Date().toISOString();
  const record: NoteRecord = {
    id: randomUUID(),
    kind: input.kind,
    title: input.title,
    body: input.body ?? '',
    // A reminder with no date is a note. Enforced here rather than trusted from
    // the caller, so the two lists cannot disagree about which is which.
    dueAt: input.kind === 'reminder' ? (input.dueAt ?? null) : null,
    doneAt: null,
    source: input.source ?? 'user',
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO notes (id, kind, title, body, due_at, done_at, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.kind,
    record.title,
    record.body,
    record.dueAt,
    record.doneAt,
    record.source,
    record.createdAt,
    record.updatedAt,
  );

  return record;
}

export function get(db: Database.Database, id: string): NoteRecord | undefined {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
  return row ? toNote(row) : undefined;
}

/**
 * Everything on the board.
 *
 * Outstanding first, and within that the soonest due — which is the order the
 * question "what needs doing" wants. Completed things sink to the bottom rather
 * than vanishing: a reminder you ticked off yesterday is still the evidence
 * that you did.
 */
export function list(db: Database.Database, options: { includeDone?: boolean } = {}): NoteRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM notes
       ${options.includeDone === false ? 'WHERE done_at IS NULL' : ''}
       ORDER BY done_at IS NOT NULL,
                CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
                due_at ASC,
                created_at DESC`,
    )
    .all() as NoteRow[];
  return rows.map(toNote);
}

/** Reminders that are due, for anything that wants to say so. */
export function due(db: Database.Database, asOf: string = new Date().toISOString()): NoteRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM notes
       WHERE done_at IS NULL AND due_at IS NOT NULL AND due_at <= ?
       ORDER BY due_at ASC`,
    )
    .all(asOf) as NoteRow[];
  return rows.map(toNote);
}

export interface NoteUpdate {
  title?: string;
  body?: string;
  kind?: NoteKind;
  dueAt?: string | null;
  /** True to tick it off, false to put it back. */
  done?: boolean;
}

export function update(
  db: Database.Database,
  id: string,
  patch: NoteUpdate,
): NoteRecord | undefined {
  const existing = get(db, id);
  if (!existing) return undefined;

  const kind = patch.kind ?? existing.kind;
  const dueAt =
    kind === 'reminder' ? (patch.dueAt !== undefined ? patch.dueAt : existing.dueAt) : null;
  const doneAt =
    patch.done === undefined
      ? existing.doneAt
      : patch.done
        ? (existing.doneAt ?? new Date().toISOString())
        : null;

  db.prepare(
    `UPDATE notes SET kind = ?, title = ?, body = ?, due_at = ?, done_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    kind,
    patch.title ?? existing.title,
    patch.body ?? existing.body,
    dueAt,
    doneAt,
    new Date().toISOString(),
    id,
  );

  return get(db, id);
}

export function remove(db: Database.Database, id: string): { removed: boolean } {
  const info = db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  return { removed: info.changes > 0 };
}
