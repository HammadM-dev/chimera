import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Splash } from './splash/Splash.tsx';
import { AppShell } from './shell/AppShell.tsx';
import { Onboarding } from './onboarding/Onboarding.tsx';

/** Whether to play the splash is decided in the main process, which owns the
 * `hasSeenSplash` flag (apps/desktop/src/settings/localSettings.ts), and is
 * handed over as a query parameter on the renderer's own file:// URL.
 *
 * Deliberately not an IPC channel. docs/DESIGN.md section 5.2 requires the
 * flag stay device-local and out of any surface a future F10 workspace-sync
 * feature could pick up; the cheapest way to guarantee that is for it to have
 * no presence on `window.chimera.*` at all. A query parameter also means the
 * renderer knows the answer before its first paint, with no round trip that
 * could land after the splash would already have started. */
function shouldPlaySplash(): boolean {
  return new URLSearchParams(window.location.search).get('splash') === '1';
}

/** The window is created with `show: false` and revealed on `ready-to-show`
 * (apps/desktop/src/windows.ts), so the document starts out hidden. Chromium
 * throttles rendering for a hidden page: mounting the splash before the window
 * is visible means the staged animations tick while nobody can see them and
 * then catch up in a single frame the moment the window appears — observed as
 * letters 3 through 7 landing together instead of 100ms apart. Waiting for
 * visibility is also just the correct behaviour for a brand moment: it should
 * begin when there is someone to see it. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');

  useEffect(() => {
    if (visible) return;
    const onChange = (): void => {
      if (document.visibilityState === 'visible') setVisible(true);
    };
    document.addEventListener('visibilitychange', onChange);
    return () => {
      document.removeEventListener('visibilitychange', onChange);
    };
  }, [visible]);

  return visible;
}

/** Whether this launch runs first-time setup.
 *
 * Decided in main from the workspace itself — no connections means not set up
 * — and handed over on the URL for the same reasons the splash decision is.
 * See apps/desktop/src/windows.ts. */
function needsOnboarding(): boolean {
  return new URLSearchParams(window.location.search).get('onboarding') === '1';
}

export function App(): JSX.Element {
  const [splashDone, setSplashDone] = useState(!shouldPlaySplash());
  const [setupDone, setSetupDone] = useState(!needsOnboarding());
  const visible = useDocumentVisible();

  return (
    <>
      <AppShell
        onRunSetup={() => {
          setSetupDone(false);
        }}
      />
      {/* Setup waits for the splash: two things animating in at once is one
          too many, and the guide's entrance is the first thing it says. */}
      {splashDone && !setupDone && (
        <Onboarding
          onDone={() => {
            setSetupDone(true);
          }}
        />
      )}
      {!splashDone && visible && (
        <Splash
          onDone={() => {
            setSplashDone(true);
          }}
        />
      )}
    </>
  );
}
