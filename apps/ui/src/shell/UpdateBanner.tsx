import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge } from '../chat/useChimera.ts';
import './update.css';

// "There is a new version" — and a button that actually installs it.
//
// The whole point of this strip is that its last step is real. A banner that
// announces a release and sends somebody to a download page is a notification
// dressed as a feature; this downloads the build and restarts into it.
//
// It appears when there is something to say and disappears when there is not.
// No "you are up to date" strip: that is a sentence nobody needs and a row of
// pixels taken from the work.

interface UpdateState {
  stage: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error';
  version: string;
  current: string;
  percent: number;
  reason: string;
  supported: boolean;
}

const QUIET: UpdateState = {
  stage: 'idle',
  version: '',
  current: '',
  percent: 0,
  reason: '',
  supported: false,
};

export function UpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>(QUIET);
  /** Dismissed for this session. The next check brings it back. */
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setState(await bridge().invoke<UpdateState>('update:get', {}));
      } catch {
        // No answer means nothing to say. An update banner is the last thing
        // that should put an error on screen.
      }
    })();
  }, []);

  useEffect(
    () =>
      bridge().on<UpdateState>('update:changed', (next) => {
        setState(next);
        // A new offer un-dismisses: hiding 2.1.4 should not hide 2.2.0.
        if (next.stage === 'available') setHidden(false);
      }),
    [],
  );

  const download = useCallback(() => {
    void bridge()
      .invoke('update:download', {})
      .catch(() => undefined);
  }, []);

  const install = useCallback(() => {
    void bridge()
      .invoke('update:install', {})
      .catch(() => undefined);
  }, []);

  // Nothing to say in these states, and saying nothing is the right amount.
  if (hidden) return null;
  if (state.stage === 'idle' || state.stage === 'checking' || state.stage === 'current') return null;
  if (state.stage === 'error' && state.reason === '') return null;

  return (
    <div className={`update update--${state.stage}`} data-testid="update-banner" role="status">
      <span className="update__dot" aria-hidden="true" />

      <span className="update__text">
        {state.stage === 'available' && (
          <>
            <strong>Version {state.version} is out.</strong> You are on {state.current}.
          </>
        )}
        {state.stage === 'downloading' && <>Downloading {state.version}… {state.percent}%</>}
        {state.stage === 'ready' && (
          <>
            <strong>Version {state.version} is ready.</strong> Restart to finish.
          </>
        )}
        {state.stage === 'error' && <>Could not check for updates: {state.reason}</>}
      </span>

      {state.stage === 'downloading' && (
        <span className="update__track" aria-hidden="true">
          <span className="update__fill" style={{ width: `${String(state.percent)}%` }} />
        </span>
      )}

      <span className="update__actions">
        {state.stage === 'available' && (
          <button
            type="button"
            className="button button--primary"
            data-testid="update-download"
            onClick={download}
          >
            Download
          </button>
        )}
        {state.stage === 'ready' && (
          <button
            type="button"
            className="button button--primary"
            data-testid="update-install"
            onClick={install}
          >
            Restart and update
          </button>
        )}
        <button
          type="button"
          className="update__later"
          data-testid="update-dismiss"
          onClick={() => {
            setHidden(true);
          }}
        >
          Later
        </button>
      </span>
    </div>
  );
}
