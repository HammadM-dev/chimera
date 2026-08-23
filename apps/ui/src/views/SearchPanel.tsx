import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import { HowTo, Step, Steps } from './HowTo.tsx';

// Which search service the agents use.
//
// Search works with nothing set here, by scraping public engines, and that is
// the right default: nobody should have to sign up for anything before their
// research agent can look something up. It is also the part of this app most
// at the mercy of somebody else's bot policy — measured from a datacentre
// address, one engine answered "best selling electric car UK 2026" with three
// dictionary definitions of the word "best", and every open instance of another
// returned 429. From a home connection it is usually fine. This panel is for
// when "usually" is not good enough.

type Provider = 'none' | 'brave' | 'tavily' | 'serper';

interface SearchState {
  provider: Provider;
  region: string;
  hasKey: boolean;
}

const NAMES: Record<Provider, string> = {
  none: 'Built in — no key needed',
  brave: 'Brave Search API',
  tavily: 'Tavily',
  serper: 'Serper',
};

const SIGNUP: Record<Exclude<Provider, 'none'>, string> = {
  brave: 'brave.com/search/api',
  tavily: 'tavily.com',
  serper: 'serper.dev',
};

export function SearchPanel({ refreshToken }: { refreshToken: number }): JSX.Element {
  const [state, setState] = useState<SearchState | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        setState(await bridge().invoke<SearchState>('search:get', {}));
      } catch (err) {
        setNote(describeError(err).message);
      }
    })();
  }, [refreshToken]);

  const save = useCallback(async (next: SearchState, key?: string) => {
    setState(next);
    try {
      const result = await bridge().invoke<SearchState>('search:set', {
        provider: next.provider,
        region: next.region,
        ...(key === undefined || key === '' ? {} : { apiKey: key }),
      });
      setState(result);
      // Cleared on the way out, not kept in a field where the next person to
      // sit down can read it.
      setApiKey('');
      setNote('Saved.');
    } catch (err) {
      setNote(describeError(err).message);
    }
  }, []);

  if (state === null) return <p className="agent-card__prompt">Loading.</p>;

  return (
    <div data-testid="search-settings">
      <p className="agent-card__prompt">
        How agents look things up when they have not been given a link. The built-in one needs no
        account and is what most workspaces use. Name a service here if research has to work every
        time.
      </p>

      <div className="field">
        <label className="field__label" htmlFor="search-provider">
          Search service
        </label>
        <select
          id="search-provider"
          className="control"
          data-testid="search-provider"
          value={state.provider}
          onChange={(event) => {
            void save({ ...state, provider: event.target.value as Provider });
          }}
        >
          {(Object.keys(NAMES) as Provider[]).map((provider) => (
            <option key={provider} value={provider}>
              {NAMES[provider]}
            </option>
          ))}
        </select>
      </div>

      {state.provider !== 'none' && (
        <>
          <div className="field">
            <label className="field__label" htmlFor="search-key">
              API key
            </label>
            <input
              id="search-key"
              className="control"
              type="password"
              data-testid="search-key"
              placeholder={state.hasKey ? 'A key is stored. Type a new one to replace it.' : ''}
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
              }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="search-region">
              Region
            </label>
            <input
              id="search-region"
              className="control"
              data-testid="search-region"
              placeholder="uk"
              value={state.region}
              onChange={(event) => {
                setState({ ...state, region: event.target.value });
              }}
            />
          </div>

          <button
            type="button"
            className="button"
            data-testid="search-save"
            onClick={() => {
              void save(state, apiKey);
            }}
          >
            Save search settings
          </button>

          <HowTo label="Not sure how?">
            <Steps>
              <Step>
                Open {SIGNUP[state.provider]} and sign up. Each of these has a free allowance that
                covers ordinary use.
              </Step>
              <Step>Copy the API key it gives you.</Step>
              <Step>Paste it above and save. It goes into your operating system’s keychain.</Step>
            </Steps>
            <p className="agent-card__prompt">
              Leave this on the built-in setting if you would rather not sign up for anything —
              research still works, it is just less consistent.
            </p>
          </HowTo>
        </>
      )}

      {state.provider === 'none' && state.hasKey && (
        <p className="agent-card__prompt">Switching away removed the stored key.</p>
      )}

      {note !== '' && (
        <p className="agent-card__prompt" data-testid="search-note">
          {note}
        </p>
      )}
    </div>
  );
}
