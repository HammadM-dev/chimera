import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import { ComposioDirectory, Logo, openLink, type Toolkit } from './ComposioDirectory.tsx';
import './composio.css';

// Apps: a section of its own, rather than a panel in Providers.
//
// It was under Providers because that is where keys go, and that was the wrong
// reading of what this is. Providers is where you say which models you can
// reach; this is where somebody's actual working life gets plugged in — their
// mailbox, their CRM, the sheet the business runs on. It is a place you come
// back to, search, and connect things from, and it does not belong three
// scrolls down a settings page next to the answer cache.

interface State {
  enabled: boolean;
  hasKey: boolean;
  userId: string;
}

interface ToolProbe {
  tools: { slug: string; toolkit: string; description: string }[];
  toolkits: { toolkit: string; connected: boolean }[];
}

const SIGN_UP = 'https://composio.dev';
const DASHBOARD = 'https://platform.composio.dev';

/**
 * Setting up Composio, for somebody who has never heard of it.
 *
 * Written as the whole path from nothing to a working connected app, because
 * that is the thing that was missing: the panel had a key field and a list, and
 * no answer at all to "what is this and what do I do". Every step here is one a
 * person can carry out and check.
 */
function Setup({ onNote }: { onNote: (note: string) => void }): JSX.Element {
  const open = (url: string): void => {
    void (async () => {
      const failed = await openLink(url);
      if (failed !== '') onNote(failed);
    })();
  };

  return (
    <div className="setup" data-testid="composio-setup">
      <ol className="setup__steps">
        <li className="setup__step">
          <span className="setup__num">1</span>
          <div>
            <p className="setup__what">Make a Composio account.</p>
            <p className="setup__why">
              Composio is the service that holds your sign-ins to Gmail, Slack, Notion and several
              hundred other apps, and gives your agents a safe way to act in them. There is a free
              tier. You need an account before anything else here does something.
            </p>
            <button
              type="button"
              className="button"
              data-testid="composio-open-signup"
              onClick={() => {
                open(SIGN_UP);
              }}
            >
              Open composio.dev
            </button>
          </div>
        </li>

        <li className="setup__step">
          <span className="setup__num">2</span>
          <div>
            <p className="setup__what">Copy your API key from the dashboard.</p>
            <p className="setup__why">
              After signing up you land on the dashboard. The API key is under Settings, or on the
              first screen it shows you. It starts with <code>ak_</code>.
            </p>
            <button
              type="button"
              className="button button--quiet"
              data-testid="composio-open-dashboard"
              onClick={() => {
                open(DASHBOARD);
              }}
            >
              Open the dashboard
            </button>
          </div>
        </li>

        <li className="setup__step">
          <span className="setup__num">3</span>
          <div>
            <p className="setup__what">Paste it in the box below and save.</p>
            <p className="setup__why">
              The key goes into your operating system’s keychain — Windows Credential Manager, the
              macOS Keychain, or libsecret on Linux. It is not written to CHIMERA’s database, into a
              log, or into anything an agent can read.
            </p>
          </div>
        </li>

        <li className="setup__step">
          <span className="setup__num">4</span>
          <div>
            <p className="setup__what">Connect the apps you want to use.</p>
            <p className="setup__why">
              A list of everything Composio reaches appears once the key is saved. Search for the
              app, choose Connect, and finish signing in on the page that opens in your browser.
              This window notices when you are done — you do not have to come back and press
              anything. Each app’s <strong>How</strong> button spells out exactly what it will ask
              you for.
            </p>
          </div>
        </li>

        <li className="setup__step">
          <span className="setup__num">5</span>
          <div>
            <p className="setup__what">Put an App operator step in an automation.</p>
            <p className="setup__why">
              That is the agent that uses all this. On the canvas, drop in an{' '}
              <strong>App operator (Composio)</strong> step and choose which of your connected apps
              it works with — the same way you choose its model. Two App operators in one automation
              can hold different apps, so the one that reads your mail is not also the one that can
              post in Slack.
            </p>
          </div>
        </li>
      </ol>
    </div>
  );
}

export function ComposioView(): JSX.Element {
  const [state, setState] = useState<State | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [connectedApps, setConnectedApps] = useState<Toolkit[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [accountOpen, setAccountOpen] = useState(true);
  const [question, setQuestion] = useState('');
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ToolProbe>({ tools: [], toolkits: [] });

  const loadConnected = useCallback(async () => {
    try {
      const result = await bridge().invoke<{ toolkits: Toolkit[] }>('composio:toolkits', {
        connectedOnly: true,
      });
      setConnectedApps(result.toolkits);
    } catch {
      // The directory below still renders and each row says whether it is
      // connected. This section is a summary, not the source of truth.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await bridge().invoke<State>('composio:get', {});
        setState(loaded);
        if (loaded.enabled && loaded.hasKey) {
          setAccountOpen(false);
          await loadConnected();
        }
      } catch (err) {
        setNote(describeError(err).message);
      }
    })();
  }, [loadConnected]);

  const save = useCallback(
    async (enabled: boolean, key?: string) => {
      setBusy(true);
      setNote('');
      // Moved before the round trip on purpose. The checkbox is controlled by
      // this state, so until the main process answered, clicking it did
      // nothing visible — the box stayed where it was for as long as the
      // keychain took, which reads as a control that is broken rather than one
      // that is working. The answer below is still authoritative and replaces
      // this the moment it lands.
      setState((current) => (current === null ? current : { ...current, enabled }));
      try {
        const saved = await bridge().invoke<State>('composio:set', {
          enabled,
          ...(key === undefined || key === '' ? {} : { apiKey: key }),
        });
        setState(saved);
        setApiKey('');
        if (saved.enabled && saved.hasKey) {
          if (key !== undefined && key !== '') setAccountOpen(false);
          await loadConnected();
          setRefreshToken((current) => current + 1);
        } else {
          setConnectedApps([]);
        }
      } catch (err) {
        setNote(describeError(err).message);
      } finally {
        setBusy(false);
      }
    },
    [loadConnected],
  );

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

  if (state === null) return <p className="agent-card__prompt">Loading.</p>;

  const ready = state.enabled && state.hasKey;

  return (
    <div className="apps scroll" data-testid="composio-view">
      <header className="apps__head">
        <div>
          <h2 className="apps__title">Your apps</h2>
          <p className="apps__sub">
            One account, and your agents can act in Gmail, Slack, Notion, Jira, HubSpot, Stripe and
            several hundred others. Anything that sends, posts, buys or deletes stops for your
            approval first — CHIMERA cannot tell which of Composio’s thousands of actions are the
            harmless ones, so it treats none of them as harmless.
          </p>
        </div>
        {ready && (
          <span className="apps__status" data-testid="composio-status">
            {connectedApps.length === 0
              ? 'nothing connected yet'
              : `${String(connectedApps.length)} connected`}
          </span>
        )}
      </header>

      {!ready && <Setup onNote={setNote} />}

      {/* Folded away once it is done. The key is a thing you set once and then
          never look at again, and while it was open it pushed the app
          directory — the part of this section anybody actually comes back
          for — most of the way off the screen. */}
      <section className="apps__panel">
        <button
          type="button"
          className="apps__fold"
          data-testid="composio-account-toggle"
          aria-expanded={accountOpen}
          onClick={() => {
            setAccountOpen(!accountOpen);
          }}
        >
          <span className="apps__panelTitle">Composio account</span>
          <span className="apps__foldMark">
            {ready && !accountOpen ? 'key saved' : accountOpen ? 'Hide' : 'Show'}
          </span>
        </button>

        {accountOpen && (
          <>
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
                    placeholder={
                      state.hasKey ? 'A key is stored. Type a new one to replace it.' : 'ak_…'
                    }
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
              </>
            )}
          </>
        )}
      </section>

      {ready && (
        <>
          {/* What you have, before what you could have. This section used to
              open on a search box over a thousand apps, which answers a
              question nobody had yet — the first one is "is anything actually
              hooked up", and it had no answer anywhere. */}
          <section className="apps__panel">
            <h3 className="apps__panelTitle">Connected</h3>
            {connectedApps.length === 0 ? (
              <p className="agent-card__prompt">
                Nothing yet. Find an app below and choose Connect — the sign-in happens on that
                app’s own site, and CHIMERA never sees the password.
              </p>
            ) : (
              <div className="apps__grid" data-testid="composio-connected">
                {connectedApps.map((toolkit) => (
                  <article
                    key={toolkit.slug}
                    className="mine"
                    data-testid={`composio-mine-${toolkit.slug}`}
                  >
                    <Logo toolkit={toolkit} />
                    <div className="mine__body">
                      <span className="mine__name">{toolkit.name}</span>
                      <span className="mine__count">
                        {toolkit.toolsCount > 0
                          ? `${String(toolkit.toolsCount)} actions available`
                          : 'ready'}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {connectedApps.length > 0 && (
              <p className="agent-card__prompt">
                An <strong>App operator (Composio)</strong> step can be pointed at any of these.
                Give two operators different apps and each can only reach its own.
              </p>
            )}
          </section>

          <section className="apps__panel">
            <h3 className="apps__panelTitle">Everything Composio reaches</h3>
            <ComposioDirectory
              refreshToken={refreshToken}
              onNote={setNote}
              onConnected={() => {
                void loadConnected();
              }}
            />
          </section>

          {/* The question the old panel could not answer: what can it actually
              do? Asked in the words somebody would use, answered with the
              tools an agent would really be handed. */}
          <section className="apps__panel">
            <h3 className="apps__panelTitle">What can it do?</h3>
            <p className="agent-card__prompt">
              Describe a job and this shows the exact tools an App operator would be given for it,
              and whether the apps behind them are connected.
            </p>

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
