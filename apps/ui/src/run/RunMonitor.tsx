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

interface StepView {
  nodeId: string;
  label: string;
  phase: Phase;
  detail: string;
  output: string;
  startedAt: number | null;
  endedAt: number | null;
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
            })),
          );
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

    void bridge()
      .invoke('run:subscribe', { runId })
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

      <ol className="monitor__steps scroll" data-testid="monitor-steps">
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
    </main>
  );
}
