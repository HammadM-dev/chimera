import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import { HowTo, Step, Steps } from './HowTo.tsx';

// Composio: hundreds of apps behind one account.
//
// A workspace is one Composio user, so an app connected here is reachable by
// every automation in it — which is what somebody means when they connect their
// Gmail once. The sign-in itself happens on Composio's side; this opens the
// page and is honest that nothing is connected until they finish there.

interface State {
  enabled: boolean;
  hasKey: boolean;
  userId: string;
}

interface Toolkit {
  name: string;
  slug: string;
  isNoAuth: boolean;
  connected: boolean;
}

export function ComposioPanel({ refreshToken }: { refreshToken: number }): JSX.Element {
  const [state, setState] = useState<State | null>(null);
  const [toolkits, setToolkits] = useState<Toolkit[]>([]);
  const [filter, setFilter] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const loadToolkits = useCallback(async () => {
    try {
      const result = await bridge().invoke<{ toolkits: Toolkit[]; reason: string }>(
        'composio:toolkits',
        {},
      );
      setToolkits(result.toolkits);
      if (result.reason !== '') setNote(result.reason);
    } catch (err) {
      setNote(describeError(err).message);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await bridge().invoke<State>('composio:get', {});
        setState(loaded);
        if (loaded.enabled && loaded.hasKey) await loadToolkits();
      } catch (err) {
        setNote(describeError(err).message);
      }
    })();
  }, [refreshToken, loadToolkits]);

  const save = useCallback(
    async (enabled: boolean, key?: string) => {
      setBusy(true);
      setNote('');
      try {
        const saved = await bridge().invoke<State>('composio:set', {
          enabled,
          ...(key === undefined || key === '' ? {} : { apiKey: key }),
        });
        setState(saved);
        setApiKey('');
        if (saved.enabled && saved.hasKey) await loadToolkits();
        else setToolkits([]);
      } catch (err) {
        setNote(describeError(err).message);
      } finally {
        setBusy(false);
      }
    },
    [loadToolkits],
  );

  const connect = useCallback(async (slug: string) => {
    setNote('');
    try {
      const result = await bridge().invoke<{ url: string; reason: string }>('composio:connect', {
        toolkit: slug,
      });
      if (result.url !== '') {
        window.open(result.url, '_blank');
        setNote('Finish signing in on the page that opened, then refresh this list.');
      } else {
        setNote(result.reason);
      }
    } catch (err) {
      setNote(describeError(err).message);
    }
  }, []);

  if (state === null) return <p className="agent-card__prompt">Loading.</p>;

  const shown = toolkits.filter(
    (toolkit) =>
      filter.trim() === '' || toolkit.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const connected = toolkits.filter((toolkit) => toolkit.connected).length;

  return (
    <div data-testid="composio">
      <p className="agent-card__prompt">
        One account, and your agents can reach Gmail, Slack, Notion, Jira, HubSpot and several
        hundred others. Anything that sends, posts or creates needs an approval step in front of it
        — CHIMERA cannot tell which of Composio’s tools are the harmless ones, so it assumes none of
        them are.
      </p>

      <label className="canvas__check">
        <input
          type="checkbox"
          data-testid="composio-enabled"
          checked={state.enabled}
          onChange={(event) => {
            void save(event.target.checked);
          }}
        />
        <span>Use Composio in this workspace.</span>
      </label>

      {state.enabled && (
        <>
          <div className="field">
            <label className="field__label" htmlFor="composio-key">
              API key
            </label>
            <input
              id="composio-key"
              className="control"
              type="password"
              data-testid="composio-key"
              placeholder={state.hasKey ? 'A key is stored. Type a new one to replace it.' : ''}
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
              }}
            />
          </div>

          <button
            type="button"
            className="button"
            data-testid="composio-save"
            disabled={busy}
            onClick={() => {
              void save(true, apiKey);
            }}
          >
            {busy ? 'Saving' : 'Save key'}
          </button>

          {state.hasKey && (
            <>
              <p className="agent-card__prompt">
                {connected} of {toolkits.length} apps connected.
              </p>

              <div className="field">
                <label className="field__label" htmlFor="composio-filter">
                  Find an app
                </label>
                <input
                  id="composio-filter"
                  className="control"
                  data-testid="composio-filter"
                  placeholder="gmail, slack, notion…"
                  value={filter}
                  onChange={(event) => {
                    setFilter(event.target.value);
                  }}
                />
              </div>

              <div className="toolkits scroll" data-testid="composio-toolkits">
                {shown.length === 0 && (
                  <p className="agent-card__prompt">
                    {toolkits.length === 0 ? 'No apps loaded yet.' : 'Nothing matches that.'}
                  </p>
                )}
                {shown.slice(0, 60).map((toolkit) => (
                  <div key={toolkit.slug} className="toolkit">
                    <span className="toolkit__name">{toolkit.name}</span>
                    {toolkit.connected ? (
                      <span className="chip chip--ok">Connected</span>
                    ) : toolkit.isNoAuth ? (
                      <span className="toolkit__note">No sign-in needed</span>
                    ) : (
                      <button
                        type="button"
                        className="button button--quiet"
                        data-testid={`composio-connect-${toolkit.slug}`}
                        onClick={() => void connect(toolkit.slug)}
                      >
                        Connect
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <button
                type="button"
                className="button button--quiet"
                data-testid="composio-refresh"
                onClick={() => void loadToolkits()}
              >
                Refresh
              </button>
            </>
          )}

          <HowTo label="Not sure how?">
            <Steps>
              <Step>Open composio.dev and sign up. There is a free tier.</Step>
              <Step>Copy the API key from your dashboard.</Step>
              <Step>Paste it above and save — it goes into your operating system’s keychain.</Step>
              <Step>
                Connect the apps you want. Each opens that app’s own sign-in page; CHIMERA never
                sees those passwords.
              </Step>
            </Steps>
          </HowTo>
        </>
      )}

      {note !== '' && (
        <p className="agent-card__prompt" data-testid="composio-note">
          {note}
        </p>
      )}
    </div>
  );
}
