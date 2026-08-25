import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import { HowTo, Step, Steps } from './HowTo.tsx';
import { ComposioDirectory } from './ComposioDirectory.tsx';

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

interface ToolProbe {
  tools: { slug: string; toolkit: string; description: string }[];
  toolkits: { toolkit: string; connected: boolean }[];
}

interface Toolkit {
  name: string;
  slug: string;
  isNoAuth: boolean;
  connected: boolean;
}

export function ComposioPanel({ refreshToken }: { refreshToken: number }): JSX.Element {
  const [state, setState] = useState<State | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [connectedApps, setConnectedApps] = useState<Toolkit[]>([]);
  const [question, setQuestion] = useState('');
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ToolProbe>({ tools: [], toolkits: [] });

  // Just the connected ones, for the section at the top. The whole catalogue
  // and its search live in `ComposioDirectory`, which owns that job entirely.
  const loadConnected = useCallback(async () => {
    try {
      const result = await bridge().invoke<{ toolkits: Toolkit[] }>('composio:toolkits', {
        connectedOnly: true,
      });
      setConnectedApps(result.toolkits);
    } catch {
      // The list below still renders, and each row says whether it is
      // connected. This section is a convenience, not the source of truth.
    }
  }, []);

  const probeFor = useCallback(async (asked: string) => {
    if (asked.trim() === '') return;
    setProbing(true);
    setNote('');
    try {
      const found = await bridge().invoke<ToolProbe & { reason: string }>('composio:search', {
        query: asked.trim(),
      });
      setProbe({ tools: found.tools.slice(0, 8), toolkits: found.toolkits });
      if (found.reason !== '') setNote(found.reason);
    } catch (err) {
      setNote(describeError(err).message);
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await bridge().invoke<State>('composio:get', {});
        setState(loaded);
        if (loaded.enabled && loaded.hasKey) await loadConnected();
      } catch (err) {
        setNote(describeError(err).message);
      }
    })();
  }, [refreshToken, loadConnected]);

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
        if (saved.enabled && saved.hasKey) await loadConnected();
        else setConnectedApps([]);
      } catch (err) {
        setNote(describeError(err).message);
      } finally {
        setBusy(false);
      }
    },
    [loadConnected],
  );

  if (state === null) return <p className="agent-card__prompt">Loading.</p>;

  return (
    <div data-testid="composio">
      <p className="agent-card__prompt composio__intro">
        One account, and your agents can reach Gmail, Slack, Notion, Jira, HubSpot and several
        hundred others. Anything that sends, posts or creates needs an approval step in front of it
        — CHIMERA cannot tell which of Composio’s tools are the harmless ones, so it assumes none of
        them are.
      </p>

      <label className="canvas__check composio__enable">
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
          <div className="field composio__key">
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

          <HowTo label="Not sure how?">
            <Steps>
              <Step>Open composio.dev and sign up. There is a free tier.</Step>
              <Step>Copy the API key from your dashboard.</Step>
              <Step>Paste it above and save — it goes into your operating system’s keychain.</Step>
              <Step>
                Connect the apps you want. Each opens that app’s own sign-in page; CHIMERA never
                sees those passwords.
              </Step>
              <Step>
                Add an <strong>App operator</strong> step to an automation. That is the agent that
                uses them.
              </Step>
            </Steps>
          </HowTo>

          {state.hasKey && (
            <>
              {/* What you have, before what you could have. The panel used to
                  open on a search box over a thousand apps, which answers a
                  question nobody had yet — the first one is "is anything
                  actually hooked up", and it had no answer anywhere. */}
              <section className="composio__section">
                <header className="composio__head">
                  <h4 className="composio__title">Your apps</h4>
                  <span className="composio__count">
                    {connectedApps.length === 0
                      ? 'none yet'
                      : `${String(connectedApps.length)} connected`}
                  </span>
                </header>

                {connectedApps.length === 0 ? (
                  <p className="agent-card__prompt">
                    Nothing connected yet. Find an app below and sign in — it happens on Composio’s
                    site, and CHIMERA never sees the password.
                  </p>
                ) : (
                  <div className="toolkits" data-testid="composio-connected">
                    {connectedApps.map((toolkit) => (
                      <div key={toolkit.slug} className="toolkit toolkit--on">
                        <span className="toolkit__name">{toolkit.name}</span>
                        <span className="chip chip--ok">Connected</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="composio__section">
                <header className="composio__head">
                  <h4 className="composio__title">Every app Composio reaches</h4>
                </header>
                <ComposioDirectory refreshToken={refreshToken} onNote={setNote} />
              </section>

              {/* The question this panel could not answer: what can it actually
                  do? Asked in the words somebody would use, answered with the
                  tools an agent would really be given. */}
              <section className="composio__section">
                <header className="composio__head">
                  <h4 className="composio__title">What can it do?</h4>
                  <span className="composio__count">
                    {probe.tools.length === 0
                      ? 'try a task'
                      : `${String(probe.tools.length)} tools`}
                  </span>
                </header>

                <form
                  className="composio__ask"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void probeFor(question);
                  }}
                >
                  <input
                    className="control"
                    data-testid="composio-question"
                    placeholder="send an email, add a row to a sheet, create an issue…"
                    value={question}
                    onChange={(event) => {
                      setQuestion(event.target.value);
                    }}
                  />
                  <button
                    type="submit"
                    className="button"
                    data-testid="composio-ask"
                    disabled={probing || question.trim() === ''}
                  >
                    {probing ? 'Looking' : 'Find tools'}
                  </button>
                </form>

                {probe.tools.length > 0 && (
                  <div className="tools scroll" data-testid="composio-tools">
                    {probe.tools.map((tool) => (
                      <div key={tool.slug} className="tool">
                        <div className="tool__head">
                          <span className="tool__slug">{tool.slug}</span>
                          <span className="tool__kit">{tool.toolkit.toLowerCase()}</span>
                        </div>
                        <p className="tool__what">{tool.description}</p>
                      </div>
                    ))}
                  </div>
                )}

                {probe.toolkits.length > 0 && (
                  <p className="agent-card__prompt">
                    {probe.toolkits.every((toolkit) => toolkit.connected)
                      ? 'Every app this needs is connected. An App operator step can do this now.'
                      : `Needs ${probe.toolkits
                          .filter((toolkit) => !toolkit.connected)
                          .map((toolkit) => toolkit.toolkit)
                          .join(', ')} connected first.`}
                  </p>
                )}
              </section>

              {/* The missing link. Apps were connectable and there was nothing
                  anywhere saying which agent uses them. */}
              <p className="agent-card__prompt">
                To use these, add an <strong>App operator (Composio)</strong> step to an automation.
                It searches Composio for the right tool and asks before anything sends, posts or
                deletes.
              </p>
            </>
          )}
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
