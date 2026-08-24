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
  /**
   * Called with every event, after redaction, as it is written.
   *
   * The trace is the record; this is the live feed. The run monitor needs to
   * say what a step is doing *while* it is doing it — which website it opened,
   * what it searched for — and until this existed the only events the renderer
   * saw were "step started" and "step finished". A person watching a step that
   * takes four minutes had nothing to look at and no way to tell working from
   * stuck.
   *
   * Given the redacted payload rather than the raw one: whatever the trace is
   * not allowed to hold, a window is not allowed to show.
   */
  onEvent?: (event: TraceEvent) => void;
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
      const redacted = secrets.length === 0 ? payload : scrub(payload, secrets);

      tracesRepository.append(db, {
        runId,
        nodeId: event.nodeId,
        eventType: event.eventType,
        payloadJson: redacted,
        tokensIn: event.tokensIn ?? null,
        tokensOut: event.tokensOut ?? null,
        costUsd: event.costUsd ?? null,
      });

      // After the write, and never allowed to affect it. A listener that throws
      // must not lose the audit record it was listening to.
      if (options.onEvent) {
        try {
          options.onEvent({
            ...event,
            payload: JSON.parse(redacted) as Record<string, unknown>,
          });
        } catch {
          // A window that cannot be told is not a run that should stop.
        }
      }
    },
  };
}
