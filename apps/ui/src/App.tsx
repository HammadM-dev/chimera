import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Splash } from './splash/Splash.tsx';
import { AppShell } from './shell/AppShell.tsx';
import { Onboarding } from './onboarding/Onboarding.tsx';
import { RunMonitor } from './run/RunMonitor.tsx';

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
/**
 * Which window this renderer is.
 *
 * A run opens a second, smaller window that watches it. Same bundle, same
 * preload, told apart by the query on its own file:// URL — the pattern the
 * splash decision already uses, and one that needs no IPC surface to answer a
 * question settled before the first paint.
 */
function runWindow(): { runId: string; name: string } | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get('view') !== 'run') return null;
  return { runId: params.get('runId') ?? '', name: params.get('name') ?? '' };
}

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
  // Decided before anything else: a run monitor is a different window with a
  // different job, and it has no splash, no onboarding and no shell.
  const [monitor] = useState(runWindow);
  const [splashDone, setSplashDone] = useState(!shouldPlaySplash());
  const [setupDone, setSetupDone] = useState(!needsOnboarding());
  const visible = useDocumentVisible();

  // The URL's answer is from window creation. A reload keeps that URL, so a
  // workspace that has since connected a provider would be shown first-run
  // setup again — over the top of an app it has no business covering. Checked
  // against the live workspace on mount, which is the same question asked at
  // the moment it matters.
  useEffect(() => {
    if (setupDone) return;
    void (async () => {
      try {
        const chimera = (
          window as unknown as { chimera?: { invoke: (c: string, p: unknown) => Promise<unknown> } }
        ).chimera;
        if (!chimera) return;
        const result = (await chimera.invoke('connection:list', {})) as {
          connections: unknown[];
        };
        if (result.connections.length > 0) setSetupDone(true);
      } catch {
        // Unanswerable means leave the guide up: a workspace whose connections
        // cannot be read is not one to declare set up.
      }
    })();
  }, [setupDone]);

  if (monitor !== null) return <RunMonitor runId={monitor.runId} name={monitor.name} />;

  return (
    <>
      {/* The tour waits for setup, and AppShell owns it because the tour moves
          between sections and that is AppShell's to do. */}
      <AppShell setupDone={splashDone && setupDone} />
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
