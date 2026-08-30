import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';

// Every app Composio reaches, as something you can browse and actually connect.
//
// The panel used to list names. A name is not enough to decide with: "Attio"
// and "Ashby" and "Airtable" tell somebody who already knows what they are
// nothing they did not know, and somebody who does not know is no better off.
// So each row carries what the app is, what signing in will ask for, and how
// many actions it brings — and the logo, which is the thing the eye finds
// first in a list of a thousand.

export interface Toolkit {
  name: string;
  slug: string;
  isNoAuth: boolean;
  connected: boolean;
  description: string;
  logo: string;
  categories: string[];
  toolsCount: number;
  authSchemes: string[];
  appUrl: string;
}

/**
 * A logo, fetched through the main process and cached across mounts.
 *
 * The renderer has no egress of its own, so an external `src` never loads —
 * see `toolkitLogo`. The module-level cache means scrolling back up a long
 * list does not re-request anything.
 */
const logoCache = new Map<string, string>();

export function Logo({ toolkit }: { toolkit: Toolkit }): JSX.Element {
  const [dataUri, setDataUri] = useState(logoCache.get(toolkit.slug) ?? '');

  useEffect(() => {
    if (toolkit.logo === '' || logoCache.has(toolkit.slug)) return undefined;
    let alive = true;
    void (async () => {
      try {
        const got = await bridge().invoke<{ dataUri: string }>('composio:logo', {
          slug: toolkit.slug,
          url: toolkit.logo,
        });
        logoCache.set(toolkit.slug, got.dataUri);
        if (alive) setDataUri(got.dataUri);
      } catch {
        // A row without a picture is a normal row.
      }
    })();
    return () => {
      alive = false;
    };
  }, [toolkit.slug, toolkit.logo]);

  return dataUri === '' ? (
    // The first letter, until there is a logo. Better than an empty square,
    // and it keeps every row the same height so the list does not jump as
    // pictures arrive.
    <span className="app__logo app__logo--letter" aria-hidden="true">
      {toolkit.name.slice(0, 1)}
    </span>
  ) : (
    <img className="app__logo" src={dataUri} alt="" aria-hidden="true" />
  );
}

/** Opens a link in the user's own browser. The renderer cannot do this itself. */
export async function openLink(url: string): Promise<string> {
  try {
    const result = await bridge().invoke<{ opened: boolean; reason: string }>(
      'shell:openExternal',
      { url },
    );
    return result.opened ? '' : result.reason;
  } catch (err) {
    return describeError(err).message;
  }
}

/** Composio keeps a page per app. Verified live: a slug with no page 404s. */
function docsFor(toolkit: Toolkit): string {
  return `https://docs.composio.dev/toolkits/${toolkit.slug}`;
}

/**
 * What connecting this app will actually involve, step by step.
 *
 * Written from the auth scheme rather than from a table of a thousand apps,
 * because a table of a thousand apps is a thousand things to go stale. What
 * the scheme decides is exactly what a person needs to know before they start:
 * whether they are about to be asked to sign in somewhere, or to go and find
 * an API key first, and where the credential ends up.
 *
 * The last two steps are the ones that were missing entirely. Somebody who has
 * just connected Gmail has no idea what to do next, and "connected" on its own
 * is not an outcome — using it is.
 */
export function guideFor(toolkit: Toolkit): { lead: string; steps: string[] } {
  const app = toolkit.name;
  const scheme = toolkit.authSchemes[0] ?? '';

  const after = [
    `Come back to this window. It checks every few seconds and marks ${app} connected on its own — there is nothing to press.`,
    `Then put an App operator step in an automation and choose ${app} as its connection. That is the agent that uses it.`,
  ];

  if (toolkit.isNoAuth) {
    return {
      lead: `${app} needs no sign-in at all.`,
      steps: [
        `Nothing to connect. ${app} is open, so an App operator step can use its ${
          toolkit.toolsCount > 0 ? `${String(toolkit.toolsCount)} actions` : 'actions'
        } straight away.`,
        `Add an App operator step to an automation and choose ${app} as its connection.`,
      ],
    };
  }

  if (scheme.startsWith('OAUTH')) {
    return {
      lead: `${app} signs you in on its own site. CHIMERA never sees the password.`,
      steps: [
        'Choose Connect. Your browser opens on a Composio link page.',
        `Sign in to ${app} with the account you want your agents to act as. If you are already signed in there, it will use that account — check it is the right one.`,
        `Approve the access ${app} asks for. The token goes to Composio and is held there; it never reaches this machine and never goes into an agent's prompt.`,
        ...after,
      ],
    };
  }

  if (scheme === 'API_KEY' || scheme === 'BEARER_TOKEN') {
    return {
      lead: `${app} is connected with an API key you get from ${app} itself.`,
      steps: [
        `Open ${app} and find your API key first — it is usually under Settings, then Developers or API. Copy it.`,
        'Choose Connect. Your browser opens on a Composio page that asks for that key.',
        'Paste it there. It goes to Composio, not to this machine, and no agent ever sees its value.',
        ...after,
      ],
    };
  }

  if (scheme === 'BASIC') {
    return {
      lead: `${app} asks for a username and password, on Composio's page.`,
      steps: [
        'Choose Connect. Your browser opens on a Composio page.',
        `Enter the ${app} username and password you want your agents to act as.`,
        'Composio holds them. They do not reach this machine and no agent sees them.',
        ...after,
      ],
    };
  }

  return {
    lead: `${app} is connected on Composio's own page, which asks for whatever it needs.`,
    steps: [
      'Choose Connect. Your browser opens on a Composio page.',
      `Give it whatever ${app} asks for. Whatever it is, it stays with Composio.`,
      ...after,
    ],
  };
}

/** How often to look for a sign-in finishing, and for how long. */
const POLL_MS = 4_000;
const POLL_FOR_MS = 5 * 60_000;

export function ComposioDirectory({
  refreshToken,
  onNote,
  onConnected,
}: {
  refreshToken: number;
  onNote: (note: string) => void;
  /** Told when an app finishes connecting, so a surrounding panel can refresh. */
  onConnected?: () => void;
}): JSX.Element {
  const [toolkits, setToolkits] = useState<Toolkit[]>([]);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  /** Apps whose sign-in is open in a browser and has not come back yet. */
  const [pending, setPending] = useState<string[]>([]);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await bridge().invoke<{ toolkits: Toolkit[]; reason: string }>(
        'composio:toolkits',
        {},
      );
      setToolkits(result.toolkits);
      if (result.reason !== '') onNote(result.reason);
    } catch (err) {
      onNote(describeError(err).message);
    } finally {
      setLoading(false);
    }
  }, [onNote]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running) clearInterval(timer);
    };
  }, []);

  // Filtering runs here over the whole catalogue rather than at Composio's
  // end — theirs ranks rather than filters, so asking for "gmail" comes back
  // with a thousand rows that merely begin with Gmail.
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return toolkits.filter(
      (toolkit) =>
        (category === '' || toolkit.categories.includes(category)) &&
        (needle === '' ||
          toolkit.name.toLowerCase().includes(needle) ||
          toolkit.slug.includes(needle) ||
          toolkit.description.toLowerCase().includes(needle)),
    );
  }, [toolkits, filter, category]);

  const categories = useMemo(() => {
    const counted = new Map<string, number>();
    for (const toolkit of toolkits) {
      for (const one of toolkit.categories) counted.set(one, (counted.get(one) ?? 0) + 1);
    }
    return [...counted.entries()]
      .filter(([, count]) => count >= 3)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 14)
      .map(([slug]) => slug);
  }, [toolkits]);

  const connected = toolkits.filter((toolkit) => toolkit.connected);

  /**
   * Watches for a sign-in finishing, rather than asking the user to press
   * Refresh.
   *
   * Composio's OAuth happens in a browser this app does not own, so there is
   * no callback to wait on — the only way to know is to ask. Polling for five
   * minutes and then stopping is honest about that: an abandoned sign-in stops
   * costing anything, and the row goes back to offering Connect.
   */
  const watch = useCallback(
    (toolkit: Toolkit) => {
      const until = Date.now() + POLL_FOR_MS;
      const timer = setInterval(() => {
        void (async () => {
          if (Date.now() > until) {
            clearInterval(timer);
            setPending((current) => current.filter((slug) => slug !== toolkit.slug));
            return;
          }
          try {
            const result = await bridge().invoke<{ toolkits: Toolkit[] }>('composio:toolkits', {
              connectedOnly: true,
            });
            if (!result.toolkits.some((one) => one.slug === toolkit.slug)) return;

            clearInterval(timer);
            setPending((current) => current.filter((slug) => slug !== toolkit.slug));
            setToolkits((current) =>
              current.map((one) => (one.slug === toolkit.slug ? { ...one, connected: true } : one)),
            );
            onNote(`${toolkit.name} is connected.`);
            onConnected?.();
          } catch {
            // A poll that fails is a poll; the next one is four seconds away.
          }
        })();
      }, POLL_MS);
      timers.current.push(timer);
    },
    [onNote, onConnected],
  );

  const connect = useCallback(
    async (toolkit: Toolkit) => {
      setConnecting(toolkit.slug);
      onNote('');
      try {
        const result = await bridge().invoke<{ url: string; opened: boolean; reason: string }>(
          'composio:connect',
          { toolkit: toolkit.slug },
        );

        if (result.opened) {
          // The button used to stop here and claim a page had opened. It had
          // not: the renderer's `window.open` is denied by the navigation
          // guard, so "Opening" was the last thing that ever happened. Main
          // opens the browser now, and this only says so when it did.
          setPending((current) => [...current, toolkit.slug]);
          onNote(`Finish signing in to ${toolkit.name} in your browser. This page is watching.`);
          watch(toolkit);
        } else if (result.url !== '') {
          onNote(
            `${result.reason} Open this yourself to finish signing in to ${toolkit.name}: ${result.url}`,
          );
        } else {
          onNote(result.reason);
        }
      } catch (err) {
        onNote(describeError(err).message);
      } finally {
        setConnecting(null);
      }
    },
    [onNote, watch],
  );

  return (
    <div className="directory" data-testid="composio-directory">
      <div className="directory__bar">
        <input
          className="control"
          data-testid="composio-filter"
          placeholder="Search a thousand apps — gmail, slack, notion, stripe…"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
        />
        <button
          type="button"
          className="button button--quiet"
          data-testid="composio-refresh"
          onClick={() => void load()}
        >
          Refresh
        </button>
      </div>

      <div className="directory__meta">
        <span>
          {loading
            ? 'Loading the catalogue'
            : `${String(shown.length)} of ${String(toolkits.length)} apps · ${String(connected.length)} connected`}
        </span>
      </div>

      {categories.length > 0 && (
        <div className="directory__cats" data-testid="composio-categories">
          <button
            type="button"
            className={`cat${category === '' ? ' cat--on' : ''}`}
            onClick={() => {
              setCategory('');
            }}
          >
            All
          </button>
          {categories.map((one) => (
            <button
              key={one}
              type="button"
              className={`cat${category === one ? ' cat--on' : ''}`}
              onClick={() => {
                setCategory(category === one ? '' : one);
              }}
            >
              {one.replace(/-/g, ' ')}
            </button>
          ))}
        </div>
      )}

      <div className="directory__list scroll" data-testid="composio-toolkits">
        {!loading && shown.length === 0 && (
          <p className="agent-card__prompt">
            {toolkits.length === 0
              ? 'No apps loaded. Check the key above, then choose Refresh.'
              : 'No app matches that.'}
          </p>
        )}

        {/* Capped at what a person will scroll. The search is the way to the
            rest, and rendering a thousand cards to be ignored is a thousand
            logo requests nobody asked for. */}
        {shown.slice(0, 80).map((toolkit) => {
          const waiting = pending.includes(toolkit.slug);
          const guide = guideFor(toolkit);

          return (
            <article
              key={toolkit.slug}
              className={`app${toolkit.connected ? ' app--on' : ''}`}
              data-testid={`composio-app-${toolkit.slug}`}
            >
              <Logo toolkit={toolkit} />

              <div className="app__body">
                <header className="app__head">
                  <span className="app__name">{toolkit.name}</span>
                  {toolkit.toolsCount > 0 && (
                    <span className="app__count">
                      {toolkit.toolsCount} {toolkit.toolsCount === 1 ? 'action' : 'actions'}
                    </span>
                  )}
                </header>

                {toolkit.description !== '' && <p className="app__what">{toolkit.description}</p>}

                {expanded === toolkit.slug && (
                  <div className="app__guide" data-testid={`composio-guide-${toolkit.slug}`}>
                    <p className="app__step">{guide.lead}</p>
                    <ol className="app__steps">
                      {guide.steps.map((step) => (
                        <li key={step} className="app__step">
                          {step}
                        </li>
                      ))}
                    </ol>
                    <p className="app__step">
                      Anything this app does that sends, posts, buys or deletes stops for your
                      approval before it happens.
                    </p>
                    <div className="app__links">
                      <button
                        type="button"
                        className="button button--quiet"
                        data-testid={`composio-docs-${toolkit.slug}`}
                        onClick={() => {
                          void (async () => {
                            const failed = await openLink(docsFor(toolkit));
                            if (failed !== '') onNote(failed);
                          })();
                        }}
                      >
                        What {toolkit.name} can do
                      </button>
                      {toolkit.appUrl !== '' && (
                        <span className="app__step app__step--url">{toolkit.appUrl}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="app__actions">
                {toolkit.connected ? (
                  <span className="chip chip--ok">Connected</span>
                ) : waiting ? (
                  <span className="chip" data-testid={`composio-waiting-${toolkit.slug}`}>
                    Waiting for your browser
                  </span>
                ) : (
                  <button
                    type="button"
                    className="button button--quiet"
                    data-testid={`composio-connect-${toolkit.slug}`}
                    disabled={connecting === toolkit.slug}
                    onClick={() => void connect(toolkit)}
                  >
                    {connecting === toolkit.slug ? 'Opening' : 'Connect'}
                  </button>
                )}
                <button
                  type="button"
                  className="app__more"
                  aria-expanded={expanded === toolkit.slug}
                  aria-label={`How to connect ${toolkit.name}`}
                  data-testid={`composio-how-${toolkit.slug}`}
                  onClick={() => {
                    setExpanded(expanded === toolkit.slug ? null : toolkit.slug);
                  }}
                >
                  {expanded === toolkit.slug ? 'Less' : 'How'}
                </button>
              </div>
            </article>
          );
        })}

        {shown.length > 80 && (
          <p className="agent-card__prompt">{shown.length - 80} more. Search to narrow it down.</p>
        )}
      </div>
    </div>
  );
}
