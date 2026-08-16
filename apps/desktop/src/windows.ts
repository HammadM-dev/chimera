import { BrowserWindow, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCsp } from './security/cspPolicy.ts';
import { applyPermissionHandler } from './security/permissionHandler.ts';
import { applyNavigationGuard } from './security/navigationGuard.ts';
import { connectionCount } from './providers/service.ts';
import { consumeSplashDecision } from './settings/localSettings.ts';

// Resolved against this module's own location, not app.getAppPath() —
// getAppPath() returns the launched script's directory (dist/) rather than
// the package root when Electron is started with an explicit script path
// (as Playwright's Electron driver does for E2E), which broke placeholder
// resolution. import.meta.url is unambiguous regardless of launch style.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function createWindow(): BrowserWindow {
  applyCsp(session.defaultSession);
  applyPermissionHandler(session.defaultSession);

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      preload: path.join(moduleDir, 'preload.cjs'),
    },
  });

  applyNavigationGuard(win);

  // E2E tests pass a full absolute path to a fixture file; production code
  // carries no knowledge of where e2e/fixtures lives (it isn't shipped).
  const fixture = process.env['CHIMERA_E2E_FIXTURE'];
  if (fixture) {
    void win.loadFile(fixture);
  } else {
    // The splash decision is made here, in main, and handed to the renderer
    // on its own URL rather than over IPC — see the comment on
    // consumeSplashDecision() and docs/DESIGN.md section 5.2. Deciding it
    // before the page loads also means the renderer knows the answer before
    // its first paint, so there is no frame in which the splash could flash
    // for a user who has already seen it.
    // Every launch, by the founder's decision — twice stated, and it overrides
    // M0-8's "second launch skips it". The splash is the product's one brand
    // moment and it is 2.3s that any key or click cuts short; a user who has
    // seen it once and is in a hurry loses nothing, and the alternative was a
    // screen that became unwatchable the moment the app was working.
    // `hasSeenSplash` is still recorded — it says whether this is a genuinely
    // first launch, which the setup guide's own gate does not answer.
    consumeSplashDecision();

    // Suppressed only for the E2E suite, and only for the tests that are not
    // about the splash. Thirty-odd launches paying 2.3s each to prove things
    // that have nothing to do with it is four minutes of CI per run and, worse,
    // pushed one already-tight test past its timeout. `splash.spec.ts` leaves
    // this unset, so the behaviour under test is the real one.
    const playSplash = process.env['CHIMERA_E2E_NO_SPLASH'] !== '1';

    // Whether to run first-launch setup is answered by the workspace itself:
    // CHIMERA cannot do anything without a provider, so "no connections" *is*
    // "not set up yet". Deliberately not a stored `hasСompletedOnboarding`
    // flag — a flag can drift out of step with reality (cleared database,
    // deleted connection, restored profile) and leave a user stranded in an
    // app with nothing connected and no way back to the guide. Deriving it
    // cannot drift. It also needs no new IPC surface, the same reasoning
    // docs/DESIGN.md §5.2 applies to the splash flag.
    const needsSetup = connectionCount() === 0;

    void win.loadFile(path.join(moduleDir, 'renderer', 'index.html'), {
      query: { splash: playSplash ? '1' : '0', onboarding: needsSetup ? '1' : '0' },
    });
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  return win;
}
