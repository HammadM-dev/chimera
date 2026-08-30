import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { bridge, type ConnectionSummary } from '../chat/useChimera.ts';
import { ConnectionForm } from '../connections/ConnectionForm.tsx';
import { ModelCatalogue } from './ModelCatalogue.tsx';
import { AnswerCache, ModelTiers, TelemetryPanel } from './ModelTiers.tsx';
import { Confirm } from '../shell/Confirm.tsx';
import { PluginsPanel } from './PluginsPanel.tsx';
import { FileGrantsPanel } from './FileGrantsPanel.tsx';
import { EmailAccountsPanel } from './EmailAccountsPanel.tsx';
import { SearchPanel } from './SearchPanel.tsx';
import { UsageStatsPanel } from './UsageStatsPanel.tsx';
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
  /** Which connection's catalogue is open. One at a time. */
  const [opened, setOpened] = useState<string | null>(null);
  /**
   * Whether the first catalogue has been opened for them already.
   *
   * A ref rather than state: this must happen once and never fight the person
   * who then closes it.
   */
  const revealed = useRef(false);
  const [confirming, setConfirming] = useState<ConnectionSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await bridge().invoke<{
        connections: ConnectionSummary[];
        kinds: string[];
      }>('connection:list', {});
      setConnections(result.connections);
      setKinds(result.kinds);

      // The first connection's models are shown without being asked for.
      //
      // Every model action lives inside a catalogue — pinning especially — and
      // a collapsed row gives no sign of that. The tour's last step says "open
      // a connection below and press Pin next to a model", and somebody who
      // does not spot that the row is a button reads an instruction about a
      // button that is nowhere on their screen, with Finish disabled and
      // nothing to click. Opening it is also just what somebody wants after
      // connecting a provider: to see what they now have.
      if (!revealed.current && result.connections.length > 0) {
        revealed.current = true;
        setOpened((current) => current ?? result.connections[0]?.id ?? null);
      }
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
            <div key={connection.id} className="connection">
              <div className="connection-row" data-testid="connection-row">
                <span className="connection-row__label">
                  <span
                    className={`dot dot--${connection.healthState === 'healthy' ? 'ok' : connection.healthState === 'unknown' ? 'idle' : 'bad'}`}
                    title={connection.healthState}
                  />
                  {connection.label}
                </span>
                <span className="connection-row__meta">{connection.kind}</span>

                {/* The catalogue is a thing to open, not a number to read. It
                    was imported, stored, and then shown as "419 models" with
                    nowhere to go — which is indistinguishable from not having
                    imported it. */}
                <button
                  type="button"
                  className="button button--quiet"
                  data-testid="connection-models"
                  aria-expanded={opened === connection.id}
                  disabled={connection.models.length === 0}
                  onClick={() => {
                    setOpened((current) => (current === connection.id ? null : connection.id));
                  }}
                >
                  {connection.models.length === 0
                    ? 'No catalogue'
                    : `${String(connection.models.length)} models`}
                </button>

                <button
                  type="button"
                  className="button button--quiet button--destructive"
                  data-testid="connection-remove"
                  onClick={() => {
                    setConfirming(connection);
                  }}
                >
                  Remove
                </button>
              </div>

              {opened === connection.id && (
                <ModelCatalogue connectionId={connection.id} label={connection.label} />
              )}
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
          <h3 className="panel__title">Apps, through Composio</h3>
          {/* Moved out to its own section. Connecting somebody's mailbox and
              their CRM is not a setting, and it does not belong three scrolls
              down a settings page between the plugins and the answer cache —
              it is a place you come back to and search. A pointer stays here
              because this is where people who remember the old arrangement
              will look. */}
          <p className="agent-card__prompt">
            Gmail, Slack, Notion, Jira and several hundred others now live in <strong>Apps</strong>,
            in the sidebar — the key, the whole catalogue, and the guide to connecting each one.
          </p>
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
          <h3 className="panel__title">Counting installs</h3>
          <UsageStatsPanel />
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
