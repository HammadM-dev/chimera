import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

// Swarm runs and the conversation each becomes.
//
// A swarm outlives the question that started it: the population stays, and the
// person asks it something else. So the row is the *thread* and the turns are
// what was asked of it, which is the same shape a chat has and for the same
// reason.

export interface SwarmRecord {
  id: string;
  name: string;
  question: string;
  seed: string;
  createdAt: string;
  updatedAt: string;
  /** `manual`, or the id of the automation run that started it. */
  source: string;
  archivedAt: string | null;
}

export interface SwarmTurnRecord {
  id: string;
  swarmId: string;
  seq: number;
  asked: string;
  answer: string;
  resultJson: string;
  costUsd: number;
  tokens: number;
  createdAt: string;
}

interface SwarmRow {
  id: string;
  name: string;
  question: string;
  seed: string;
  created_at: string;
  updated_at: string;
  source: string;
  archived_at: string | null;
}

interface TurnRow {
  id: string;
  swarm_id: string;
  seq: number;
  asked: string;
  answer: string;
  result_json: string;
  cost_usd: number;
  tokens: number;
  created_at: string;
}

function toSwarm(row: SwarmRow): SwarmRecord {
  return {
    id: row.id,
    name: row.name,
    question: row.question,
    seed: row.seed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: row.source,
    archivedAt: row.archived_at,
  };
}

function toTurn(row: TurnRow): SwarmTurnRecord {
  return {
    id: row.id,
    swarmId: row.swarm_id,
    seq: row.seq,
    asked: row.asked,
    answer: row.answer,
    resultJson: row.result_json,
    costUsd: row.cost_usd,
    tokens: row.tokens,
    createdAt: row.created_at,
  };
}

export function create(
  db: Database.Database,
  input: { name: string; question: string; source?: string },
): SwarmRecord {
  const now = nextUpdatedAt(db);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO swarms (id, name, question, seed, created_at, updated_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    // The seed is the id: a run repeats exactly when replayed, and there is no
    // second thing to keep in step.
  ).run(id, input.name, input.question, id, now, now, input.source ?? 'manual');

  return {
    id,
    name: input.name,
    question: input.question,
    seed: id,
    createdAt: now,
    updatedAt: now,
    source: input.source ?? 'manual',
    archivedAt: null,
  };
}

export function get(db: Database.Database, id: string): SwarmRecord | undefined {
  const row = db.prepare('SELECT * FROM swarms WHERE id = ?').get(id) as SwarmRow | undefined;
  return row === undefined ? undefined : toSwarm(row);
}

/** Newest first. Archived ones are left out — they are hidden, not deleted. */
/**
 * A timestamp that sorts after every thread already in the list.
 *
 * `new Date().toISOString()` has millisecond resolution, and two threads
 * created or touched inside one millisecond carry the same value — so the list
 * ordered by it came back differently between reads on a fast machine. A
 * `rowid` tiebreak fixes creation order and gets touching wrong, because
 * speaking to an old thread does not change its rowid.
 *
 * So the value itself is made to advance: the wall clock when that is already
 * later than everything stored, and one millisecond past the newest otherwise.
 * The times stay honest to within a millisecond and the order stops depending
 * on how fast the machine is.
 */
function nextUpdatedAt(db: Database.Database): string {
  const now = new Date().toISOString();
  const top = (
    db.prepare('SELECT MAX(updated_at) AS newest FROM swarms').get() as
      { newest: string | null } | undefined
  )?.newest;
  if (top === null || top === undefined || now > top) return now;
  return new Date(new Date(top).getTime() + 1).toISOString();
}

export function list(db: Database.Database, limit = 200): SwarmRecord[] {
  return (
    (
      db
        // `rowid` breaks the tie, and the tie is not hypothetical: two threads
        // created in the same millisecond sort arbitrarily, so the list flipped
        // order between reads on a fast machine. Insertion order is the right
        // answer when the timestamps are equal — the later row is the later
        // thread, whatever the clock managed to record.
        .prepare(
          'SELECT * FROM swarms WHERE archived_at IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT ?',
        )
        .all(limit) as SwarmRow[]
    ).map(toSwarm)
  );
}

export function rename(db: Database.Database, id: string, name: string): void {
  db.prepare('UPDATE swarms SET name = ?, updated_at = ? WHERE id = ?').run(
    name,
    nextUpdatedAt(db),
    id,
  );
}

export function archive(db: Database.Database, id: string): void {
  db.prepare('UPDATE swarms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function addTurn(
  db: Database.Database,
  input: {
    swarmId: string;
    asked: string;
    answer: string;
    resultJson: string;
    costUsd?: number;
    tokens?: number;
  },
): SwarmTurnRecord {
  const now = new Date().toISOString();
  const id = randomUUID();
  const next =
    ((
      db
        .prepare('SELECT MAX(seq) AS top FROM swarm_turns WHERE swarm_id = ?')
        .get(input.swarmId) as { top: number | null } | undefined
    )?.top ?? 0) + 1;

  db.prepare(
    `INSERT INTO swarm_turns (id, swarm_id, seq, asked, answer, result_json, cost_usd, tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.swarmId,
    next,
    input.asked,
    input.answer,
    input.resultJson,
    input.costUsd ?? 0,
    input.tokens ?? 0,
    now,
  );

  // The thread moves up the list when it is spoken to, which is what makes the
  // list read as "what I have been working on". Strictly newer than everything
  // else, so speaking to a thread created in the same millisecond as another
  // still moves it above that one.
  db.prepare('UPDATE swarms SET updated_at = ? WHERE id = ?').run(nextUpdatedAt(db), input.swarmId);

  return {
    id,
    swarmId: input.swarmId,
    seq: next,
    asked: input.asked,
    answer: input.answer,
    resultJson: input.resultJson,
    costUsd: input.costUsd ?? 0,
    tokens: input.tokens ?? 0,
    createdAt: now,
  };
}

export function turnsOf(db: Database.Database, swarmId: string): SwarmTurnRecord[] {
  return (
    db
      .prepare('SELECT * FROM swarm_turns WHERE swarm_id = ? ORDER BY seq')
      .all(swarmId) as TurnRow[]
  ).map(toTurn);
}

/** The swarm an automation run created, if it created one. */
export function bySource(db: Database.Database, source: string): SwarmRecord | undefined {
  const row = db
    .prepare('SELECT * FROM swarms WHERE source = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(source) as SwarmRow | undefined;
  return row === undefined ? undefined : toSwarm(row);
}
