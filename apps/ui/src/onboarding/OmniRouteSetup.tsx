import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import './omniroute.css';

// F1.5's detect → guide → import flow. CHIMERA never installs or authenticates
// OmniRoute on the user's behalf: it looks for a local instance, explains what
// to do when there isn't one, and imports the catalogue when there is.

type Phase = 'detecting' | 'not-detected' | 'detected' | 'importing' | 'ready';

interface DetectResult {
  state: 'detected' | 'not-detected';
  baseUrl: string;
  modelCount: number;
}

interface Props {
  /** Bumps the shell's refresh token so the chat panel picks the new connection up. */
  onImported: () => void;
}

export function OmniRouteSetup({ onImported }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>('detecting');
  const [modelCount, setModelCount] = useState(0);
  const [baseUrl, setBaseUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setPhase('detecting');
    setError(null);
    try {
      const result = await bridge().invoke<DetectResult>('omniroute:detect', {});
      setBaseUrl(result.baseUrl);
      setModelCount(result.modelCount);
      setPhase(result.state === 'detected' ? 'detected' : 'not-detected');
    } catch (err) {
      // A failed probe still means "not detected" as far as the user is
      // concerned. The message is kept for the detail line rather than thrown
      // as a toast, because not having OmniRoute installed is the common case
      // and is not a failure.
      setError(describeError(err).message);
      setPhase('not-detected');
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const runImport = useCallback(async () => {
    setPhase('importing');
    setError(null);
    try {
      const result = await bridge().invoke<{ connectionId: string; modelCount: number }>(
        'omniroute:import',
        {},
      );
      setModelCount(result.modelCount);
      setPhase(result.connectionId === '' ? 'not-detected' : 'ready');
      // Without this the connection exists in SQLite and is invisible in the
      // picker until the app is restarted, which reads as "imported 211 models
      // and nothing happens".
      if (result.connectionId !== '') onImported();
    } catch (err) {
      setError(describeError(err).message);
      setPhase('detected');
    }
  }, [onImported]);

  return (
    <div className="omniroute" data-testid="omniroute-setup" data-phase={phase}>
      {phase === 'detecting' && <p className="omniroute__text">Looking for a local instance.</p>}

      {phase === 'not-detected' && (
        <div className="omniroute__body" data-testid="omniroute-guidance">
          <p className="omniroute__text">
            No instance is answering on {baseUrl === '' ? 'the default port' : baseUrl}. Install it
            and sign in with your own provider accounts, then check again.
          </p>
          <button
            type="button"
            className="button"
            data-testid="omniroute-recheck"
            onClick={() => void check()}
          >
            Check again
          </button>
        </div>
      )}

      {phase === 'detected' && (
        <div className="omniroute__body">
          <p className="omniroute__text" data-testid="omniroute-found">
            Found <span className="omniroute__count">{String(modelCount)}</span> models at {baseUrl}
            .
          </p>
          <button
            type="button"
            className="button button--primary"
            data-testid="omniroute-import"
            onClick={() => void runImport()}
          >
            Import models
          </button>
        </div>
      )}

      {phase === 'importing' && <p className="omniroute__text">Importing models.</p>}

      {phase === 'ready' && (
        <p className="omniroute__text" data-testid="omniroute-ready">
          <span className="chip chip--ok">Connected</span> with{' '}
          <span className="omniroute__count">{String(modelCount)}</span> models.
        </p>
      )}

      {error !== null && (
        <p className="omniroute__detail" data-testid="omniroute-detail">
          {error}
        </p>
      )}
    </div>
  );
}
