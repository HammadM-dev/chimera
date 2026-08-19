import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, type ConnectionSummary } from '../chat/useChimera.ts';
import {
  recordRunSpend,
  subscribeToSession,
  sessionTotals,
  type SessionTotals,
} from './sessionMeter.ts';

// M1-11's exit criterion: live health state and a running session cost across
// every connection. The minimal version the ticket asks for — M4's shell work
// builds out the rest of the bar.

const SWEEP_INTERVAL_MS = 15_000;

interface ControlSession {
  granted: boolean;
  reason: string;
  dryRun: boolean;
}

export function StatusBar({ changed = 0 }: { changed?: number }): JSX.Element {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [totals, setTotals] = useState<SessionTotals>(sessionTotals());
  const [control, setControl] = useState<ControlSession | null>(null);
  const [panicKey, setPanicKey] = useState('');
  const [stopped, setStopped] = useState('');
  const [runsInFlight, setRunsInFlight] = useState(0);

  useEffect(() => subscribeToSession(setTotals), []);

  // What runs are spending, as they spend it. The bar showed chat exchanges
  // only, so an automation could run for a minute against a paid model and the
  // bar would still read "No spend yet".
  useEffect(() => {
    return bridge().on<{ runId: string; type: string; data: unknown }>('run:event', (event) => {
      if (event.type !== 'spend') return;
      const snapshot = event.data as { costUsd: number; hasUnpricedCalls: boolean };
      recordRunSpend(event.runId, {
        costUsd: snapshot.costUsd,
        unpriced: snapshot.hasUnpricedCalls,
      });
    });
  }, []);

  // M8-3's indicator. Always visible while anything is running or control is
  // granted — a machine being driven by something other than the person at it
  // should never be a thing you have to go and check.
  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{ session: ControlSession; panicKey: string }>(
          'control:get',
          {},
        );
        setControl(result.session);
        setPanicKey(result.panicKey);
      } catch {
        setControl(null);
      }
    })();

    return bridge().on<{ session: ControlSession; cancelledRuns?: number }>(
      'control:event',
      (event) => {
        setControl(event.session);
        if (event.cancelledRuns !== undefined) {
          setRunsInFlight(0);
          setStopped(
            event.cancelledRuns === 0
              ? 'Stopped. Nothing was running.'
              : `Stopped ${String(event.cancelledRuns)} ${event.cancelledRuns === 1 ? 'run' : 'runs'}.`,
          );
        }
      },
    );
  }, []);

  // How many runs are live, counted from the same events the canvas watches.
  useEffect(() => {
    return bridge().on<{ runId: string; type: string }>('run:event', (event) => {
      if (event.type === 'started' || event.type === 'resumed') {
        setRunsInFlight((current) => current + 1);
        setStopped('');
      }
      if (event.type === 'finished' || event.type === 'failed') {
        setRunsInFlight((current) => Math.max(0, current - 1));
      }
    });
  }, []);

  const stopEverything = useCallback(async () => {
    try {
      const result = await bridge().invoke<{ cancelledRuns: number }>('control:panic', {});
      setStopped(
        result.cancelledRuns === 0
          ? 'Stopped. Nothing was running.'
          : `Stopped ${String(result.cancelledRuns)} ${result.cancelledRuns === 1 ? 'run' : 'runs'}.`,
      );
    } catch {
      setStopped('Could not stop everything.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const sweep = async (): Promise<void> => {
      try {
        const result = await bridge().invoke<{ connections: ConnectionSummary[] }>(
          'health:sweep',
          {},
        );
        if (!cancelled) setConnections(result.connections);
      } catch {
        // A failed sweep leaves the last known states on screen rather than
        // blanking the bar: "we could not check just now" is not the same
        // claim as "these providers are down".
      }
    };

    void sweep();
    const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `changed` as well as the timer: connecting a provider and then reading
    // "No connections" for up to fifteen seconds is the first thing a new user
    // sees, at the exact moment they are looking for confirmation it worked.
  }, [changed]);

  const costLabel =
    totals.exchanges === 0
      ? 'No spend yet'
      : `$${totals.costUsd.toFixed(4)} this session` +
        (totals.unpricedExchanges > 0 ? ` · ${String(totals.unpricedExchanges)} unpriced` : '');

  return (
    <footer className="shell__status" data-testid="status-bar">
      <span data-testid="status-health">
        {connections.length === 0
          ? 'No connections'
          : connections
              .map((connection) => `${connection.label}: ${connection.healthState}`)
              .join(' · ')}
      </span>
      <span data-testid="status-cost">{costLabel}</span>

      {(runsInFlight > 0 || control?.granted === true) && (
        <span className="status__control" data-testid="status-control">
          <span className="status__pulse" aria-hidden="true" />
          {control?.granted === true
            ? `${control.dryRun ? 'Watching' : 'Controlling'} this machine — ${control.reason}`
            : `${String(runsInFlight)} running`}
          <button
            type="button"
            className="button"
            data-testid="status-panic"
            onClick={() => void stopEverything()}
          >
            Stop everything{panicKey === '' ? '' : ` (${panicKey})`}
          </button>
        </span>
      )}

      {stopped !== '' && <span data-testid="status-stopped">{stopped}</span>}
    </footer>
  );
}
