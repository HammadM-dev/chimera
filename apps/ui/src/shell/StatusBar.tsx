import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, type ConnectionSummary } from '../chat/useChimera.ts';
import { subscribeToSession, sessionTotals, type SessionTotals } from './sessionMeter.ts';

// M1-11's exit criterion: live health state and a running session cost across
// every connection. The minimal version the ticket asks for — M4's shell work
// builds out the rest of the bar.

const SWEEP_INTERVAL_MS = 15_000;

export function StatusBar(): JSX.Element {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [totals, setTotals] = useState<SessionTotals>(sessionTotals());

  useEffect(() => subscribeToSession(setTotals), []);

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
  }, []);

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
    </footer>
  );
}
