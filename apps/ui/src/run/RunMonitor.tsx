import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { bridge } from '../chat/useChimera.ts';
import './run.css';

// The window a run gets to itself.
//
// Watching a run used to mean staring at the canvas you were still editing,
// with the answer arriving in a panel over the top of it. This is the same
// information given room: what each step is doing, in the order it happens,
// while it happens — and then what the whole thing produced.
//
// One idea carries the design: a run is a sequence of moments down a spine,
// and colour says only what state something is in. Nothing else is coloured.

type Phase = 'waiting' | 'running' | 'succeeded' | 'failed' | 'needs-approval' | 'skipped';

interface Activity {
  nodeId: string;
  at: number;
  text: string;
  kind: 'thinking' | 'search' | 'web' | 'file' | 'mail' | 'tool' | 'done' | 'problem';
  artifact?: { path: string; name: string; bytes: number | null };
  image?: string;
}

interface StepView {
  nodeId: string;
  label: string;
  phase: Phase;
  detail: string;
  output: string;
  startedAt: number | null;
  endedAt: number | null;
  /** Everything this step has done, newest last. Shown behind "Show more". */
  activity: Activity[];
}

/** The mark beside a line of activity. Enough to scan by, not a decoration. */
const KIND_MARK: Record<Activity['kind'], string> = {
  thinking: '…',
  search: '⌕',
  web: '↗',
  file: '▤',
  mail: '✉',
  tool: '⚙',
  done: '✓',
  problem: '!',
};

/**
 * The icon for a thing a run produced.
 *
 * By what it is, because that is what somebody scanning for their spreadsheet
 * is looking for — not by which agent made it.
 */
function artifactMark(name: string): string {
  const extension = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  if (extension === '') return '🗀';
  if (['zip', 'tar', 'gz', '7z'].includes(extension)) return '🗜';
  if (['csv', 'tsv', 'xlsx', 'xls', 'ods'].includes(extension)) return '▦';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension)) return '🖼';
  if (['pdf'].includes(extension)) return '🗎';
  if (['doc', 'docx', 'odt', 'md', 'txt', 'rtf'].includes(extension)) return '🗏';
  if (['ppt', 'pptx', 'odp'].includes(extension)) return '🗔';
  return '🗎';
}

const PHASE_WORD: Record<Phase, string> = {
  waiting: 'Waiting',
  running: 'Working',
  succeeded: 'Done',
  failed: 'Stopped',
  'needs-approval': 'Needs you',
  skipped: 'Skipped',
};

/** Maps an engine status onto the six states this window shows. */
function phaseOf(status: string): Phase {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'skipped') return 'skipped';
  if (status === 'running') return 'running';
  if (status === 'awaiting' || status === 'needs-approval') return 'needs-approval';
  return 'failed';
}

function seconds(from: number, to: number): string {
  const total = Math.max(0, Math.round((to - from) / 1000));
  const mins = Math.floor(total / 60);
  return mins === 0 ? `${String(total)}s` : `${String(mins)}m ${String(total % 60)}s`;
}

export function RunMonitor({ runId, name }: { runId: string; name: string }): JSX.Element {
  const [steps, setSteps] = useState<StepView[]>([]);
  const [status, setStatus] = useState<'running' | 'succeeded' | 'failed' | 'awaiting'>('running');
  const [note, setNote] = useState('');
  const [output, setOutput] = useState('');
  const [spend, setSpend] = useState<{ tokens: number; costUsd: number }>({
    tokens: 0,
    costUsd: 0,
  });
  const [copied, setCopied] = useState(false);
  const startedAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  const tail = useRef<HTMLDivElement | null>(null);

  // A clock, only while there is something to time.
  useEffect(() => {
    if (status !== 'running' && status !== 'awaiting') return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [status]);

  const upsert = useCallback((nodeId: string, patch: Partial<StepView>) => {
    setSteps((current) => {
      const at = current.findIndex((step) => step.nodeId === nodeId);
      if (at === -1) {
        return [
          ...current,
          {
            nodeId,
            label: nodeId,
            phase: 'waiting',
            detail: '',
            output: '',
            startedAt: null,
            endedAt: null,
            activity: [],
            ...patch,
          },
        ];
      }
      const next = [...current];
      next[at] = { ...(next[at] as StepView), ...patch };
      return next;
    });
  }, []);

  useEffect(() => {
    const off = bridge().on<{ runId: string; type: string; data: unknown }>(
      'run:event',
      (event) => {
        if (event.runId !== runId) return;

        if (event.type === 'started' || event.type === 'resumed') {
          const detail = event.data as {
            steps?: string[];
            plan?: { nodeId: string; label: string }[];
          };
          const planned =
            detail.plan ?? (detail.steps ?? []).map((nodeId) => ({ nodeId, label: nodeId }));
          setSteps(
            planned.map((step) => ({
              nodeId: step.nodeId,
              label: step.label,
              phase: 'waiting' as Phase,
              detail: '',
              output: '',
              startedAt: null,
              endedAt: null,
              activity: [],
            })),
          );
          return;
        }

        if (event.type === 'activity') {
          const activity = event.data as Activity;
          setSteps((current) => {
            const at = current.findIndex((step) => step.nodeId === activity.nodeId);
            if (at === -1) return current;
            const next = [...current];
            const step = next[at] as StepView;
            // Capped. A step that loops for an hour would otherwise grow this
            // window's memory without bound, and nobody scrolls back past the
            // last hundred lines of anything.
            const kept = [...step.activity, activity].slice(-200);
            next[at] = { ...step, activity: kept, detail: activity.text };
            return next;
          });
          return;
        }

        if (event.type.startsWith('step:')) {
          const detail = event.data as {
            nodeId: string;
            phase: 'started' | 'finished';
            outcome?: { status: string; output: string; haltCause?: string };
          };
          if (detail.phase === 'started') {
            upsert(detail.nodeId, { phase: 'running', detail: '', startedAt: Date.now() });
          } else {
            upsert(detail.nodeId, {
              phase: phaseOf(detail.outcome?.status ?? 'succeeded'),
              detail: detail.outcome?.haltCause ?? '',
              output: detail.outcome?.output ?? '',
              endedAt: Date.now(),
            });
          }
          return;
        }

        if (event.type === 'spend') {
          const detail = event.data as { tokens?: number; costUsd?: number };
          setSpend({ tokens: detail.tokens ?? 0, costUsd: detail.costUsd ?? 0 });
          return;
        }

        if (event.type === 'approval:requested') {
          const detail = event.data as { nodeId: string; prompt: string };
          setStatus('awaiting');
          upsert(detail.nodeId, { phase: 'needs-approval', detail: detail.prompt });
          return;
        }

        if (event.type === 'finished') {
          const detail = event.data as { status: string; summary: string | null; output: string };
          setStatus(detail.status === 'succeeded' ? 'succeeded' : 'failed');
          setNote(detail.summary ?? '');
          setOutput(detail.output);
          return;
        }

        if (event.type === 'failed') {
          setStatus('failed');
          setNote((event.data as { message: string }).message);
        }
      },
    );

    // Subscribing also asks what has already happened. This window takes long
    // enough to open that a short run is over before it is listening, and
    // without the snapshot it sat on "Starting…" for exactly the runs that
    // succeeded quickest.
    void bridge()
      .invoke<{
        subscribed: boolean;
        snapshot: {
          status: string;
          output: string;
          errorSummary: string;
          startedAt: string;
          endedAt: string;
          steps: { nodeId: string; label: string; status: string }[];
          activity: Activity[];
        };
      }>('run:subscribe', { runId })
      .then((result) => {
        const snapshot = result.snapshot;
        if (snapshot.steps.length > 0) {
          setSteps((current) =>
            current.length > 0
              ? current
              : snapshot.steps.map((step) => ({
                  nodeId: step.nodeId,
                  label: step.label,
                  phase: phaseOf(step.status),
                  detail: '',
                  output: '',
                  startedAt: null,
                  endedAt: null,
                  // The feed, caught up from the trace.
                  //
                  // Live events go out as they happen, so a window that is not
                  // open yet gets none of them — which is every window for the
                  // first moment of a run, and *all* of a run that finishes in
                  // two seconds. Attached here, where the steps are built,
                  // because a map over steps that do not exist yet produces
                  // nothing at all: the first version of this ran before this
                  // block and quietly did nothing.
                  activity: snapshot.activity.filter((line) => line.nodeId === step.nodeId),
                })),
          );
        }

        // A window that *was* open already has these lines from the live feed;
        // one that opened mid-run has some of them. Fill only the gaps.
        setSteps((current) =>
          current.map((step) =>
            step.activity.length > 0
              ? step
              : {
                  ...step,
                  activity: snapshot.activity.filter((line) => line.nodeId === step.nodeId),
                },
          ),
        );
        // The run's own clock, not this window's. A monitor that opened after
        // the run finished was timing itself, and reported "0s".
        if (snapshot.startedAt !== '') {
          const began = Date.parse(snapshot.startedAt);
          if (!Number.isNaN(began)) startedAt.current = began;
        }
        if (snapshot.endedAt !== '') {
          const ended = Date.parse(snapshot.endedAt);
          if (!Number.isNaN(ended)) setNow(ended);
        }
        if (snapshot.status === 'succeeded' || snapshot.status === 'failed') {
          setStatus(snapshot.status);
          setOutput((current) => (current === '' ? snapshot.output : current));
          setNote((current) => (current === '' ? snapshot.errorSummary : current));
        }
      })
      .catch(() => {
        setNote('This window lost touch with the run. Open it in Runs to see what happened.');
      });

    return off;
  }, [runId, upsert]);

  // Follow the work. Only while it is moving, so reading a finished run does
  // not fight the scroll.
  useEffect(() => {
    if (status !== 'running') return;
    tail.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [steps, status]);

  // Which steps are opened out. A set rather than a flag on the step: a person
  // watching a five-agent run opens the one they are curious about, and it
  // stays open while the rest keep moving.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Record<string, string>>({});

  const save = useCallback(
    async (artifact: NonNullable<Activity['artifact']>) => {
      setSaved((current) => ({ ...current, [artifact.path]: 'Saving…' }));
      try {
        const result = await bridge().invoke<{ saved: boolean; path: string; reason: string }>(
          'run:saveArtifact',
          { runId, path: artifact.path, name: artifact.name },
        );
        setSaved((current) => ({
          ...current,
          // Cancelling the dialog is not a failure and must not read as one:
          // the control simply goes back to offering.
          [artifact.path]: result.saved ? 'Saved' : result.reason === '' ? 'Save' : result.reason,
        }));
      } catch {
        setSaved((current) => ({ ...current, [artifact.path]: 'Could not save' }));
      }
    },
    [runId],
  );

  const elapsed = useMemo(() => seconds(startedAt.current, now), [now]);
  const done = status === 'succeeded' || status === 'failed';

  return (
    <main className="monitor" data-testid="run-monitor" data-status={status}>
      <header className="monitor__head">
        <div className="monitor__title">
          <span className={`monitor__state monitor__state--${status}`} aria-hidden="true" />
          <h1 className="monitor__name">{name === '' ? 'Automation' : name}</h1>
        </div>
        <p className="monitor__meta" data-testid="monitor-meta">
          {status === 'running'
            ? 'Running'
            : status === 'awaiting'
              ? 'Waiting for you'
              : status === 'succeeded'
                ? 'Finished'
                : 'Stopped'}
          {' · '}
          {elapsed}
          {spend.tokens > 0 && ` · ${spend.tokens.toLocaleString()} tokens`}
          {spend.costUsd > 0 && ` · $${spend.costUsd.toFixed(4)}`}
        </p>
      </header>

      <div className="monitor__body scroll">
        <ol className="monitor__steps" data-testid="monitor-steps">
          {steps.length === 0 && <li className="monitor__empty">Starting…</li>}
          {steps.map((step) => (
            <li key={step.nodeId} className={`moment moment--${step.phase}`}>
              <span className="moment__mark" aria-hidden="true" />
              <div className="moment__body">
                <p className="moment__label">
                  {step.label}
                  <span className="moment__phase">{PHASE_WORD[step.phase]}</span>
                </p>
                {step.detail !== '' && <p className="moment__detail">{step.detail}</p>}
                {step.activity.length > 0 && (
                  <button
                    type="button"
                    className="moment__more"
                    data-testid={`moment-more-${step.nodeId}`}
                    aria-expanded={expanded.has(step.nodeId)}
                    onClick={() => {
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(step.nodeId)) next.delete(step.nodeId);
                        else next.add(step.nodeId);
                        return next;
                      });
                    }}
                  >
                    {expanded.has(step.nodeId)
                      ? 'Show less'
                      : `Show more · ${String(step.activity.length)} step${
                          step.activity.length === 1 ? '' : 's'
                        }`}
                  </button>
                )}

                {expanded.has(step.nodeId) && (
                  <ol className="doing" data-testid={`moment-activity-${step.nodeId}`}>
                    {step.activity.map((activity, index) => (
                      <li key={`${String(activity.at)}-${String(index)}`} className="doing__row">
                        <span className={`doing__mark doing__mark--${activity.kind}`}>
                          {KIND_MARK[activity.kind]}
                        </span>
                        <div className="doing__body">
                          <span className="doing__text">{activity.text}</span>
                          {activity.image !== undefined && (
                            <img className="doing__image" src={activity.image} alt="" />
                          )}
                          {activity.artifact !== undefined && (
                            <span className="artifact">
                              <span className="artifact__mark" aria-hidden="true">
                                {artifactMark(activity.artifact.name)}
                              </span>
                              <span className="artifact__name">{activity.artifact.name}</span>
                              {activity.artifact.bytes !== null && (
                                <span className="artifact__size">
                                  {activity.artifact.bytes.toLocaleString()} bytes
                                </span>
                              )}
                              <button
                                type="button"
                                className="button button--quiet"
                                data-testid={`artifact-save-${activity.artifact.name}`}
                                onClick={() => {
                                  void save(activity.artifact as NonNullable<Activity['artifact']>);
                                }}
                              >
                                {saved[activity.artifact.path] ?? 'Save'}
                              </button>
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}

                {step.output !== '' && (
                  <p className="moment__output" title={step.output}>
                    {step.output}
                  </p>
                )}
                {step.startedAt !== null && (
                  <p className="moment__time">{seconds(step.startedAt, step.endedAt ?? now)}</p>
                )}
              </div>
            </li>
          ))}
          <div ref={tail} />
        </ol>

        {done && (
          <section className="monitor__result" data-testid="monitor-result">
            <div className="monitor__resultHead">
              <p className="monitor__resultTitle">
                {status === 'succeeded' ? 'What it produced' : 'Where it stopped'}
              </p>
              {output !== '' && (
                <button
                  type="button"
                  className="button button--quiet"
                  data-testid="monitor-copy"
                  onClick={() => {
                    void navigator.clipboard.writeText(output);
                    setCopied(true);
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              )}
            </div>
            {note !== '' && <p className="monitor__note">{note}</p>}
            {output === '' ? (
              <p className="monitor__note">
                Nothing was produced as text. Open the run in Runs to see each step.
              </p>
            ) : (
              <pre className="monitor__output" data-testid="monitor-output">
                {output}
              </pre>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
