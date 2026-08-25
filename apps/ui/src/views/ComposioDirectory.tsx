import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';

// Every app Composio reaches, as something you can browse.
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

function Logo({ toolkit }: { toolkit: Toolkit }): JSX.Element {
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

/** What signing in will actually ask of somebody, in words rather than a code. */
function howToConnect(toolkit: Toolkit): string {
  if (toolkit.isNoAuth) return 'No sign-in needed — it is ready to use.';

  const scheme = toolkit.authSchemes[0] ?? '';
  if (scheme.startsWith('OAUTH')) {
    return `Opens ${toolkit.name}’s own sign-in page in your browser. You approve the access there; CHIMERA never sees the password.`;
  }
  if (scheme === 'API_KEY' || scheme === 'BEARER_TOKEN') {
    return `Asks for an API key from your ${toolkit.name} account. Composio holds it; it never reaches this machine.`;
  }
  if (scheme === 'BASIC') {
    return `Asks for a ${toolkit.name} username and password on Composio’s own page.`;
  }
  return `Opens Composio’s connection page for ${toolkit.name} and asks for whatever it needs.`;
}

export function ComposioDirectory({
  refreshToken,
  onNote,
}: {
  refreshToken: number;
  onNote: (note: string) => void;
}): JSX.Element {
  const [toolkits, setToolkits] = useState<Toolkit[]>([]);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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

  const connect = useCallback(
    async (toolkit: Toolkit) => {
      setConnecting(toolkit.slug);
      onNote('');
      try {
        const result = await bridge().invoke<{ url: string; reason: string }>('composio:connect', {
          toolkit: toolkit.slug,
        });
        if (result.url !== '') {
          window.open(result.url, '_blank');
          onNote(
            `Finish signing in to ${toolkit.name} on the page that opened, then choose Refresh.`,
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
    [onNote],
  );

  return (
    <div className="directory" data-testid="composio-directory">
      <div className="directory__bar">
        <input
          ref={searchRef}
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
        {shown.slice(0, 80).map((toolkit) => (
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
                  <p className="app__step">{howToConnect(toolkit)}</p>
                  <p className="app__step">
                    Once connected, an <strong>App operator</strong> step can use its{' '}
                    {toolkit.toolsCount > 0 ? `${String(toolkit.toolsCount)} actions` : 'actions'}.
                    Anything that sends, posts or deletes stops for your approval first.
                  </p>
                  {toolkit.appUrl !== '' && (
                    <p className="app__step app__step--url">{toolkit.appUrl}</p>
                  )}
                </div>
              )}
            </div>

            <div className="app__actions">
              {toolkit.connected ? (
                <span className="chip chip--ok">Connected</span>
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
                onClick={() => {
                  setExpanded(expanded === toolkit.slug ? null : toolkit.slug);
                }}
              >
                {expanded === toolkit.slug ? 'Less' : 'How'}
              </button>
            </div>
          </article>
        ))}

        {shown.length > 80 && (
          <p className="agent-card__prompt">{shown.length - 80} more. Search to narrow it down.</p>
        )}
      </div>
    </div>
  );
}
