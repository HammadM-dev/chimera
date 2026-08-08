import { BrowserWindow, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCsp } from './security/cspPolicy.ts';
import { applyPermissionHandler } from './security/permissionHandler.ts';
import { applyNavigationGuard } from './security/navigationGuard.ts';

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
    void win.loadFile(path.join(moduleDir, 'placeholder.html'));
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  return win;
}
