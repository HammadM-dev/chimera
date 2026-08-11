import type Database from 'better-sqlite3';
import { scrub } from '@chimera/providers';
import { tracesRepository, type TraceEventType } from '@chimera/store';

// F7.5's replayable audit trace. Every prompt sent, response received, tool
// call made, tool result returned, decision taken and checkpoint written is
// appended here as it happens.
//
// The trace viewer is M4-7. This ticket's job is that the data is correct from
// now on, so M4 only has to render it — a trace that starts being written
// properly at M4 would have nothing to show for every run before it.

export interface TraceEvent {
  nodeId: string;
  eventType: TraceEventType;
  payload: Record<string, unknown>;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

export interface TraceSink {
  append: (event: TraceEvent) => void;
}

/** A sink that discards. For unit tests and dry runs, not for a real run. */
export const NULL_TRACE_SINK: TraceSink = { append: () => undefined };

/**
 * Longest single string kept in a payload.
 *
 * A trace is an audit record, not a backup of every page an agent read. One
 * run that fetched a large document should not make the workspace database
 * unopenable; the truncation is marked so a reader can tell a short value from
 * a shortened one.
 */
const MAX_FIELD_CHARS = 20_000;

function truncateStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= MAX_FIELD_CHARS
      ? value
      : `${value.slice(0, MAX_FIELD_CHARS)}…[truncated, ${String(value.length)} characters total]`;
  }
  if (Array.isArray(value)) return value.map(truncateStrings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        truncateStrings(child),
      ]),
    );
  }
  return value;
}

export interface TraceSinkOptions {
  /**
   * Values to redact before write.
   *
   * CLAUDE.md: "secrets never leave the vault. Not into SQLite, not into logs,
   * not into run traces." Nothing in the agent runtime holds a plaintext
   * credential today — the adapter resolves the vault handle and lets the value
   * go out of scope inside `packages/providers` — so this list is normally
   * empty. It exists because the redaction has to happen at the write, and a
   * hook added later is a hook added after the first leak.
   */
  secrets?: readonly string[];
}

export function createTraceSink(
  db: Database.Database,
  runId: string,
  options: TraceSinkOptions = {},
): TraceSink {
  const secrets = options.secrets ?? [];

  return {
    append(event) {
      const payload = JSON.stringify(truncateStrings(event.payload));
      tracesRepository.append(db, {
        runId,
        nodeId: event.nodeId,
        eventType: event.eventType,
        payloadJson: secrets.length === 0 ? payload : scrub(payload, secrets),
        tokensIn: event.tokensIn ?? null,
        tokensOut: event.tokensOut ?? null,
        costUsd: event.costUsd ?? null,
      });
    },
  };
}
