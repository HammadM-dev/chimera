import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

// The only code permitted to write SQL against `traces`. Append-only by
// construction: there is deliberately no update and no delete here, because
// F7.5's audit trace is worth nothing if the thing being audited can edit it.

export type TraceEventType =
  | 'prompt'
  | 'response'
  | 'tool_call'
  | 'tool_result'
  | 'retry'
  | 'decision'
  | 'checkpoint'
  | 'compaction';

export interface TraceRecord {
  id: string;
  runId: string;
  nodeId: string;
  seq: number;
  ts: string;
  eventType: TraceEventType;
  payloadJson: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

export interface AppendTraceInput {
  runId: string;
  nodeId: string;
  eventType: TraceEventType;
  payloadJson: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
}

interface TraceRow {
  id: string;
  run_id: string;
  node_id: string;
  seq: number;
  ts: string;
  event_type: string;
  payload_json: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
}

function toRecord(row: TraceRow): TraceRecord {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    seq: row.seq,
    ts: row.ts,
    eventType: row.event_type as TraceEventType,
    payloadJson: row.payload_json,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
  };
}

/**
 * Appends one event and returns it.
 *
 * `seq` is allocated inside the same statement as the insert, from the current
 * maximum for that run. Computing it in JavaScript and passing it in would race
 * two writers of the same run against each other and produce duplicate sequence
 * numbers, which is exactly the thing `seq` exists to prevent — it defines
 * replay order.
 */
export function append(db: Database.Database, input: AppendTraceInput): TraceRecord {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO traces (id, run_id, node_id, seq, ts, event_type, payload_json, tokens_in, tokens_out, cost_usd)
     VALUES (
       ?, ?, ?,
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM traces WHERE run_id = ?),
       ?, ?, ?, ?, ?, ?
     )`,
  ).run(
    id,
    input.runId,
    input.nodeId,
    input.runId,
    new Date().toISOString(),
    input.eventType,
    input.payloadJson,
    input.tokensIn ?? null,
    input.tokensOut ?? null,
    input.costUsd ?? null,
  );

  const row = db.prepare('SELECT * FROM traces WHERE id = ?').get(id) as TraceRow | undefined;
  if (!row) throw new Error(`Trace ${id} vanished immediately after being written`);
  return toRecord(row);
}

/** Every event for a run, in replay order. */
export function listForRun(db: Database.Database, runId: string): TraceRecord[] {
  return (
    db.prepare('SELECT * FROM traces WHERE run_id = ? ORDER BY seq').all(runId) as TraceRow[]
  ).map(toRecord);
}

export function countForRun(db: Database.Database, runId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM traces WHERE run_id = ?').get(runId) as {
    count: number;
  };
  return row.count;
}
