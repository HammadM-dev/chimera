import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import './runs.css';

// M4-7 and M4-8. Every run the workspace has made, what it cost, and — for the
// one selected — the trace the engine has been writing since M2-11 with nothing
// to read it.
//
// A run you cannot inspect afterwards is a run you cannot trust: "it worked"
// and "it produced something" are different claims, and only the trace tells
// them apart.

interface RunListItem {
  id: string;
  name: string;
  status: string;
  triggerType: string;
  startedAt: string;
  endedAt: string | null;
  tokensUsed: number;
  costUsd: number;
  frontierCostUsd: number | null;
  savedByCacheUsd: number;
  errorSummary: string | null;
}

interface CostSlice {
  key: string;
  label: string;
  costUsd: number;
  tokens: number;
  runs: number;
}

interface CostSummary {
  totalCostUsd: number;
  totalTokens: number;
  runCount: number;
  byAutomation: CostSlice[];
  byAgent: CostSlice[];
  byModel: CostSlice[];
  byDay: CostSlice[];
}

interface RunFailure {
  nodeId: string;
  itemIndex: number;
  itemJson: string;
  error: string;
  ts: string;
}

interface TraceEvent {
  seq: number;
  ts: string;
  nodeId: string;
  eventType: string;
  payloadJson: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

const STATUS_WORD: Record<string, string> = {
  running: 'Running',
  awaiting_approval: 'Waiting for approval',
  succeeded: 'Succeeded',
  halted: 'Halted',
  cancelled: 'Cancelled',
  failed: 'Failed',
  incomplete: 'Incomplete',
};

/** The one line an event is worth in a timeline, before it is expanded. */
function headline(event: TraceEvent): string {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
  } catch {
    return event.payloadJson.slice(0, 120);
  }

  const say = (key: string): string | null => {
    const value = payload[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };

  switch (event.eventType) {
    case 'request':
      return say('model') ?? 'Model call';
    case 'response':
      return (say('text') ?? say('finishReason') ?? 'Answer').slice(0, 160);
    case 'tool_call':
      return `${say('toolId') ?? 'tool'}(${JSON.stringify(payload['args'] ?? {}).slice(0, 80)})`;
    case 'tool_result':
      return (say('output') ?? '').slice(0, 160);
    case 'decision':
      return say('decision') ?? 'Decision';
    case 'error':
      return say('message') ?? 'Error';
    default:
      return JSON.stringify(payload).slice(0, 160);
  }
}

/**
 * The screenshot a `tool_result` refers to, if it refers to one.
 *
 * The trace carries the name rather than the picture — a PNG is hundreds of
 * kilobytes, and the trace is read whole every time a run is opened.
 */
function shotNameOf(event: TraceEvent): string {
  if (event.eventType !== 'tool_result') return '';
  const match = /Screenshot saved as (\d{3}\.png)/.exec(event.payloadJson);
  return match?.[1] ?? '';
}

/** One screenshot, fetched when its event is opened rather than with the trace. */
function Screenshot({ runId, name }: { runId: string; name: string }): JSX.Element {
  const [dataUrl, setDataUrl] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{ dataUrl: string }>('trace:screenshot', {
          runId,
          name,
        });
        setDataUrl(result.dataUrl);
      } catch {
        setDataUrl('');
      }
    })();
  }, [runId, name]);

  if (dataUrl === '') {
    return <p className="canvas__prompt">That screenshot is no longer on disk.</p>;
  }
  return (
    <img
      className="event__shot"
      data-testid="trace-screenshot"
      src={dataUrl}
      alt="Page as the agent saw it"
    />
  );
}

function money(value: number): string {
  return value === 0 ? '—' : `$${value.toFixed(4)}`;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function RunsView(): JSX.Element {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [failures, setFailures] = useState<RunFailure[]>([]);
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [costs, setCosts] = useState<CostSummary | null>(null);
  const [costsOpen, setCostsOpen] = useState(false);
  const [costDays, setCostDays] = useState(30);

  const load = useCallback(async () => {
    try {
      const result = await bridge().invoke<{ runs: RunListItem[] }>('run:list', {});
      setRuns(result.runs);
      setSelected((current) => current ?? result.runs[0]?.id ?? null);
    } catch (err) {
      setNote(describeError(err).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The bill. Asked for only when the panel is open — it is a scan over every
  // node of every run in the window, which is cheap but not free, and most
  // visits to this screen are about one run rather than the total.
  useEffect(() => {
    if (!costsOpen) return;
    void (async () => {
      try {
        const result = await bridge().invoke<CostSummary>('run:costs', { days: costDays });
        setCosts(result);
      } catch (err) {
        setNote(describeError(err).message);
      }
    })();
  }, [costsOpen, costDays, runs.length]);

  // A run that is still going keeps writing. Polling rather than subscribing:
  // `run:event` carries step transitions, not trace rows, and a viewer that
  // showed a stale trace of a live run would be worse than one that lagged.
  useEffect(() => {
    if (selected === null) return;
    let stopped = false;

    const pull = async () => {
      try {
        const result = await bridge().invoke<{ events: TraceEvent[] }>('trace:list', {
          runId: selected,
        });
        if (!stopped) setEvents(result.events);
      } catch (err) {
        if (!stopped) setNote(describeError(err).message);
      }
    };

    void pull();
    const live = runs.find((run) => run.id === selected);
    if (live && (live.status === 'running' || live.status === 'awaiting_approval')) {
      const timer = setInterval(() => void pull(), 1500);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    }
    return () => {
      stopped = true;
    };
  }, [selected, runs]);

  // What the run could not process. Its own request rather than part of the
  // trace, because this is the list a person has to act on, not the record of
  // what happened.
  useEffect(() => {
    if (selected === null) {
      setFailures([]);
      return;
    }
    void (async () => {
      try {
        const result = await bridge().invoke<{ failures: RunFailure[] }>('run:failures', {
          runId: selected,
        });
        setFailures(result.failures);
      } catch {
        setFailures([]);
      }
    })();
  }, [selected, events.length]);

  const exportTrace = useCallback(async () => {
    if (selected === null) return;
    try {
      const result = await bridge().invoke<{ path: string; events: number }>('trace:export', {
        runId: selected,
      });
      setNote(
        result.path === ''
          ? ''
          : `Exported ${String(result.events)} events to ${result.path.split('/').pop() ?? ''}.`,
      );
    } catch (err) {
      setNote(describeError(err).message);
    }
  }, [selected]);

  const run = runs.find((candidate) => candidate.id === selected) ?? null;

  // The history, filtered. Name and status are what people actually look for —
  // "the invoice one that failed" is the whole query.
  const visibleRuns = runs.filter((candidate) => {
    const matchesSearch =
      search.trim() === '' || candidate.name.toLowerCase().includes(search.trim().toLowerCase());
    const matchesStatus = statusFilter === 'all' || candidate.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of events) {
      counts.set(event.eventType, (counts.get(event.eventType) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [events]);

  const shown = filter === 'all' ? events : events.filter((event) => event.eventType === filter);

  return (
    <div className="runs" data-testid="runs-view">
      <aside className="runs__list scroll" data-testid="runs-list" aria-label="Runs">
        <div className="runs__listHead">
          <p className="canvas__section">Runs</p>
          <div className="runs__listActions">
            <button
              type="button"
              className="button"
              data-testid="runs-costs-toggle"
              aria-expanded={costsOpen}
              onClick={() => {
                setCostsOpen((open) => !open);
              }}
            >
              {costsOpen ? 'Hide costs' : 'Costs'}
            </button>
            <button
              type="button"
              className="button"
              data-testid="runs-refresh"
              onClick={() => void load()}
            >
              Refresh
            </button>
          </div>
        </div>

        {costsOpen && (
          <section className="costs" data-testid="run-costs">
            <div className="costs__head">
              <span className="costs__total" data-testid="costs-total">
                {money(costs?.totalCostUsd ?? 0)}
              </span>
              <select
                className="control"
                data-testid="costs-window"
                aria-label="Period"
                value={String(costDays)}
                onChange={(event) => {
                  setCostDays(Number(event.target.value));
                }}
              >
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="365">Last year</option>
              </select>
            </div>
            <p className="runs__meta">
              {(costs?.totalTokens ?? 0).toLocaleString()} tokens across{' '}
              {String(costs?.runCount ?? 0)} runs
            </p>

            {(
              [
                ['By automation', costs?.byAutomation ?? [], 'automation'],
                ['By agent', costs?.byAgent ?? [], 'agent'],
                ['By model', costs?.byModel ?? [], 'model'],
              ] as const
            ).map(([label, slices, testid]) => (
              <div key={testid} data-testid={`costs-by-${testid}`}>
                <p className="canvas__section">{label}</p>
                {slices.length === 0 && <p className="canvas__prompt">Nothing yet.</p>}
                {slices.slice(0, 6).map((slice) => (
                  <div key={slice.key} className="costs__row">
                    <span className="costs__label">{slice.label}</span>
                    {/* The bar is the comparison; the number is the fact. A
                        list of numbers alone makes you do the arithmetic. */}
                    <span
                      className="costs__bar"
                      style={{
                        width: `${String(
                          Math.max(
                            2,
                            Math.round(
                              (slice.costUsd / Math.max(slices[0]?.costUsd ?? 1, 0.0001)) * 100,
                            ),
                          ),
                        )}%`,
                      }}
                    />
                    <span className="costs__value">{money(slice.costUsd)}</span>
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}

        <input
          className="control"
          data-testid="runs-search"
          aria-label="Search runs"
          placeholder="Search by name"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        <select
          className="control"
          data-testid="runs-status"
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(event) => {
            setStatusFilter(event.target.value);
          }}
        >
          <option value="all">Any outcome</option>
          <option value="succeeded">Succeeded</option>
          <option value="halted">Halted</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
          <option value="awaiting_approval">Waiting for approval</option>
          <option value="running">Running</option>
        </select>

        {runs.length === 0 && <p className="canvas__prompt">Nothing has run yet.</p>}
        {runs.length > 0 && visibleRuns.length === 0 && (
          <p className="canvas__prompt">No run matches that.</p>
        )}

        {visibleRuns.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={`runs__item ${candidate.id === selected ? 'runs__item--selected' : ''}`}
            data-testid={`run-${candidate.id}`}
            onClick={() => {
              setSelected(candidate.id);
              setExpanded(null);
              setFilter('all');
            }}
          >
            <span className="runs__name">{candidate.name}</span>
            <span className={`runs__status runs__status--${candidate.status}`}>
              {STATUS_WORD[candidate.status] ?? candidate.status}
            </span>
            <span className="runs__meta">
              {when(candidate.startedAt)} · {money(candidate.costUsd)}
              {candidate.triggerType !== 'manual' && ` · ${candidate.triggerType}`}
            </span>
          </button>
        ))}
      </aside>

      <section className="runs__trace scroll" aria-label="Trace">
        {run === null ? (
          <p className="canvas__prompt">Select a run to see what it did.</p>
        ) : (
          <>
            <header className="runs__head">
              <div>
                <p className="runs__title">{run.name}</p>
                <p className="runs__meta" data-testid="run-summary">
                  {STATUS_WORD[run.status] ?? run.status} ·{' '}
                  {run.triggerType === 'manual' ? 'started by you' : run.triggerType} ·{' '}
                  {run.tokensUsed.toLocaleString()} tokens · {money(run.costUsd)} ·{' '}
                  {String(events.length)} events
                </p>
                {/* Shown only when it is both known and favourable: a saving of
                    nothing is not worth a line, and an invented comparison is
                    worse than none. */}
                {run.savedByCacheUsd > 0 && (
                  <p className="runs__saved" data-testid="run-cache-saving">
                    {money(run.savedByCacheUsd)} of this was not spent — the answers were already
                    known.
                  </p>
                )}
                {run.frontierCostUsd !== null && run.frontierCostUsd > run.costUsd && (
                  <p className="runs__saved" data-testid="run-blended">
                    {money(run.costUsd)} instead of {money(run.frontierCostUsd)} — the same work on
                    the frontier tier throughout.
                  </p>
                )}
              </div>
              <button
                type="button"
                className="button"
                data-testid="trace-export"
                onClick={() => void exportTrace()}
              >
                Export JSON
              </button>
            </header>

            {run.errorSummary !== null && run.errorSummary !== '' && (
              <p className="runs__error" data-testid="run-error">
                {run.errorSummary}
              </p>
            )}

            {failures.length > 0 && (
              <section className="runs__failures" data-testid="run-failures">
                <p className="canvas__section">
                  {failures.length === 1
                    ? '1 item could not be processed'
                    : `${String(failures.length)} items could not be processed`}
                </p>
                <ol className="runs__failureList">
                  {failures.slice(0, 50).map((failure) => (
                    <li key={`${failure.nodeId}-${String(failure.itemIndex)}`}>
                      <span className="runs__failureItem">{failure.itemJson}</span>
                      <span className="runs__failureError">{failure.error}</span>
                    </li>
                  ))}
                </ol>
                {failures.length > 50 && (
                  <p className="canvas__prompt">
                    The first 50 are shown. Export the trace for all of them.
                  </p>
                )}
              </section>
            )}

            <div className="runs__filters">
              <button
                type="button"
                className={`runs__filter ${filter === 'all' ? 'runs__filter--on' : ''}`}
                onClick={() => {
                  setFilter('all');
                }}
              >
                All {events.length}
              </button>
              {kinds.map(([kind, count]) => (
                <button
                  key={kind}
                  type="button"
                  className={`runs__filter ${filter === kind ? 'runs__filter--on' : ''}`}
                  data-testid={`trace-filter-${kind}`}
                  onClick={() => {
                    setFilter(kind);
                  }}
                >
                  {kind} {count}
                </button>
              ))}
            </div>

            <ol className="runs__events" data-testid="trace-events">
              {shown.map((event) => (
                <li key={event.seq} className={`event event--${event.eventType}`}>
                  <button
                    type="button"
                    className="event__row"
                    data-testid={`trace-event-${String(event.seq)}`}
                    onClick={() => {
                      setExpanded((current) => (current === event.seq ? null : event.seq));
                    }}
                  >
                    <span className="event__seq">{event.seq}</span>
                    <span className="event__node">{event.nodeId}</span>
                    <span className="event__type">{event.eventType}</span>
                    <span className="event__headline">{headline(event)}</span>
                    <span className="event__cost">
                      {event.costUsd === null || event.costUsd === 0 ? '' : money(event.costUsd)}
                    </span>
                  </button>
                  {expanded === event.seq && shotNameOf(event) !== '' && selected !== null && (
                    <Screenshot runId={selected} name={shotNameOf(event)} />
                  )}
                  {expanded === event.seq && (
                    <pre className="event__payload" data-testid="trace-payload">
                      {(() => {
                        try {
                          return JSON.stringify(JSON.parse(event.payloadJson) as unknown, null, 2);
                        } catch {
                          return event.payloadJson;
                        }
                      })()}
                    </pre>
                  )}
                </li>
              ))}
            </ol>

            {events.length === 0 && (
              <p className="canvas__prompt">This run has not written anything yet.</p>
            )}
          </>
        )}

        {note !== '' && (
          <p className="canvas__prompt" data-testid="runs-note">
            {note}
          </p>
        )}
      </section>
    </div>
  );
}
