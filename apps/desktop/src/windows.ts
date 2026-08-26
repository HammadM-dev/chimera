import { BrowserWindow, session } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyCsp } from './security/cspPolicy.ts';
import { applyPermissionHandler } from './security/permissionHandler.ts';
import { applyNavigationGuard } from './security/navigationGuard.ts';
import { hideMenuBar } from './menu.ts';
import { connectionCount } from './providers/service.ts';
import { consumeSplashDecision, readLocalSettings } from './settings/localSettings.ts';

// Resolved against this module's own location, not app.getAppPath() —
// getAppPath() returns the launched script's directory (dist/) rather than
// the package root when Electron is started with an explicit script path
// (as Playwright's Electron driver does for E2E), which broke placeholder
// resolution. import.meta.url is unambiguous regardless of launch style.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** One monitor per run, so pressing Run twice does not stack windows. */
const runWindows = new Map<string, BrowserWindow>();

/**
 * A small window that watches one run.
 *
 * A run is the thing this product does, and until now watching one meant
 * staring at the canvas you were still editing, with the answer arriving in a
 * panel over the top of it. A run deserves its own surface: you can put it on
 * a second screen, keep working on the automation underneath, and still see
 * what the agents are doing while they do it.
 *
 * Same preload, same CSP, same navigation guard as the main window — a second
 * window is a second renderer, and a hardened renderer that is only hardened
 * once is not hardened.
 */
export function openRunWindow(runId: string, name: string): BrowserWindow | null {
  // The E2E fixture windows load a bare HTML file with no renderer bundle;
  // there is nothing for a monitor to attach to.
  if (process.env['CHIMERA_E2E_FIXTURE']) return null;

  const existing = runWindows.get(runId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  const win = new BrowserWindow({
    width: 520,
    height: 720,
    show: false,
    title: name === '' ? 'Run' : name,
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
  hideMenuBar(win);
  void win.loadFile(path.join(moduleDir, 'renderer', 'index.html'), {
    query: { view: 'run', runId, name, splash: '0', onboarding: '0', tour: '0' },
  });

  win.once('ready-to-show', () => {
    win.show();
  });
  win.on('closed', () => {
    runWindows.delete(runId);
  });

  runWindows.set(runId, win);
  return win;
}

/**
 * Where the app icon is, in a built app and in a checkout.
 *
 * `build/` is electron-builder's `buildResources` directory, which is not
 * copied into `dist/` — so a packaged app finds it beside the bundle and a
 * development run finds it two levels up. Falling back rather than failing:
 * a window with the default Electron icon is a cosmetic problem, and refusing
 * to open one over it would not be.
 */
function appIconPath(): string {
  const candidates = [
    path.join(moduleDir, 'icon.png'),
    path.join(moduleDir, '..', 'build', 'icon.png'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? '';
}

export function createWindow(): BrowserWindow {
  applyCsp(session.defaultSession);
  applyPermissionHandler(session.defaultSession);

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    // The mark, for the taskbar and the window itself.
    //
    // Only Linux and Windows read this: macOS takes the icon from the bundle
    // that electron-builder assembles, so setting it here would be ignored
    // there and misleading here. `icon.png` is the packaged build's source
    // icon too — one file, so the window and the launcher cannot disagree.
    ...(process.platform === 'darwin' ? {} : { icon: appIconPath() }),
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
  hideMenuBar(win);

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

    // Whether to offer the tour, decided here for the same reason the splash
    // decision is here: the renderer has to know before its first paint.
    //
    // It was read over IPC, and that was a mistake with a symptom. The answer
    // arrived a round trip after the shell had rendered, so the tour appeared
    // *over* an app somebody had already started using — and in the suite, over
    // a click a test had already made, which turned up as a different test
    // failing in each full run depending on which one met the slow round trip.
    // A query parameter cannot lose that race.
    const offerTour = !readLocalSettings().hasSeenTour;

    void win.loadFile(path.join(moduleDir, 'renderer', 'index.html'), {
      query: {
        splash: playSplash ? '1' : '0',
        onboarding: needsSetup ? '1' : '0',
        tour: offerTour ? '1' : '0',
      },
    });
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  return win;
}
