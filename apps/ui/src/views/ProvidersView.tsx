import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, type ConnectionSummary } from '../chat/useChimera.ts';
import { ConnectionForm } from '../connections/ConnectionForm.tsx';
import { AnswerCache, ModelTiers, TelemetryPanel } from './ModelTiers.tsx';
import { Confirm } from '../shell/Confirm.tsx';
import { PluginsPanel } from './PluginsPanel.tsx';
import { FileGrantsPanel } from './FileGrantsPanel.tsx';
import { EmailAccountsPanel } from './EmailAccountsPanel.tsx';
import { SearchPanel } from './SearchPanel.tsx';
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
  const [confirming, setConfirming] = useState<ConnectionSummary | null>(null);

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

  const removeConfirmed = useCallback(async () => {
    const target = confirming;
    setConfirming(null);
    if (!target) return;
    await bridge().invoke('connection:remove', { id: target.id });
    await load();
    // The rest of the app cares too: the model pickers on the canvas are built
    // from this list.
    onChanged();
  }, [confirming, load, onChanged]);

  return (
    <div className="providers" data-testid="providers-view">
      <Confirm
        open={confirming !== null}
        title={`Remove ${confirming?.label ?? ''}?`}
        body={
          <>
            Its API key is deleted from your keychain, and any step bound to one of its models will
            need a new one before it can run.
          </>
        }
        confirmLabel="Remove connection"
        onCancel={() => {
          setConfirming(null);
        }}
        onConfirm={() => void removeConfirmed()}
      />

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
              <button
                type="button"
                className="button button--quiet"
                data-testid="connection-remove"
                onClick={() => {
                  setConfirming(connection);
                }}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      <div>
        <div className="panel">
          <h3 className="panel__title">Add a provider</h3>
          <ConnectionForm kinds={kinds} onCreated={onChanged} />
        </div>
        <div className="panel">
          <h3 className="panel__title">OmniRoute</h3>
          <OmniRouteSetup onImported={onChanged} />
        </div>
        <div className="panel">
          <h3 className="panel__title">Plugins</h3>
          <p className="agent-card__prompt">
            Tool servers your agents can be granted — email, calendars, issue trackers, anything
            that speaks MCP.
          </p>
          <PluginsPanel refreshToken={refreshToken} />
        </div>

        <div>
          <FileGrantsPanel />
        </div>

        <div>
          <EmailAccountsPanel />
        </div>
        <div className="panel">
          <h3 className="panel__title">Web search</h3>
          <SearchPanel refreshToken={refreshToken} />
        </div>
        <div className="panel">
          <h3 className="panel__title">Reusing answers</h3>
          <p className="agent-card__prompt">
            An answer already paid for can be given again instead of asked for again.
          </p>
          <AnswerCache refreshToken={refreshToken} />
        </div>
        <div className="panel">
          <h3 className="panel__title">Sending runs elsewhere</h3>
          <TelemetryPanel refreshToken={refreshToken} />
        </div>
        <div className="panel">
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
