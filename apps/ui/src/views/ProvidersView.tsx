import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, type ConnectionSummary } from '../chat/useChimera.ts';
import { ConnectionForm } from '../connections/ConnectionForm.tsx';
import { ModelTiers } from './ModelTiers.tsx';
import { OmniRouteSetup } from '../onboarding/OmniRouteSetup.tsx';
import './views.css';

// Where models come from. Kept out of the builder deliberately: choosing which
// provider serves a step is a decision about the step, and setting a provider
// up is a decision about the workspace. Mixing them is how a first run turns
// into a configuration session.

interface Props {
  refreshToken: number;
  onChanged: () => void;
}

export function ProvidersView({ refreshToken, onChanged }: Props): JSX.Element {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const result = await bridge().invoke<{
        connections: ConnectionSummary[];
        kinds: string[];
      }>('connection:list', {});
      setConnections(result.connections);
      setKinds(result.kinds);
    } catch {
      // Rendered empty rather than taking the view down; the status bar and the
      // chat panel both surface the same failure with a message.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  return (
    <div className="providers" data-testid="providers-view">
      <div className="panel">
        <h3 className="panel__title">Connected</h3>
        {connections.length === 0 ? (
          <p className="agent-card__prompt">
            Nothing connected yet. Add one on the right, or import OmniRoute if you run it.
          </p>
        ) : (
          connections.map((connection) => (
            <div key={connection.id} className="connection-row" data-testid="connection-row">
              <span>{connection.label}</span>
              <span className="connection-row__meta">
                {connection.kind} ·{' '}
                {connection.models.length === 0
                  ? 'no catalogue'
                  : `${String(connection.models.length)} models`}{' '}
                · {connection.healthState}
              </span>
            </div>
          ))
        )}
      </div>

      <div>
        <div className="panel">
          <h3 className="panel__title">Add a provider</h3>
          <ConnectionForm kinds={kinds} onCreated={onChanged} />
        </div>
        <div className="panel" style={{ marginTop: 'var(--space-3)' }}>
          <h3 className="panel__title">OmniRoute</h3>
          <OmniRouteSetup onImported={onChanged} />
        </div>
        <div className="panel" style={{ marginTop: 'var(--space-3)' }}>
          <h3 className="panel__title">Model tiers</h3>
          <p className="agent-card__prompt">
            An automation can ask for a tier instead of naming a model, so the same automation runs
            wherever it is opened.
          </p>
          <ModelTiers refreshToken={refreshToken} />
        </div>
      </div>
    </div>
  );
}
