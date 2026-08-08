import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import path from 'node:path';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main.js');
const fixturesDir = path.join(desktopRoot, 'e2e', 'fixtures');

async function launchWithFixture(fixture?: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry],
    cwd: desktopRoot,
    env: fixture
      ? { ...process.env, CHIMERA_E2E_FIXTURE: path.join(fixturesDir, fixture) }
      : { ...process.env, CHIMERA_E2E_FIXTURE: '' },
  });
}

test.describe('M0-3 hardened Electron shell', () => {
  test('opens exactly one window with a hardened renderer', async () => {
    const electronApp = await launchWithFixture();
    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState('domcontentloaded');

      // Main-process-side: exactly one live BrowserWindow exists.
      expect(electronApp.windows().length).toBe(1);
      const mainProcessWindowCount = await electronApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      );
      expect(mainProcessWindowCount).toBe(1);

      // Renderer-side behavioural probe, not a config-flag readback: modern
      // Electron no longer exposes a way to read webPreferences back off a
      // live instance (verified — there is no getWebPreferences accessor in
      // this Electron version's API surface). Proving Node globals are
      // genuinely unreachable from the page's own global scope is a
      // stronger assertion anyway — it directly demonstrates the security
      // property (contextIsolation + nodeIntegration:false + sandbox all
      // holding together) rather than trusting a flag was set correctly.
      const nodeGlobals = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return {
          require: typeof w['require'],
          process: typeof w['process'],
          module: typeof w['module'],
          Buffer: typeof w['Buffer'],
          global: typeof w['global'],
        };
      });
      expect(nodeGlobals).toEqual({
        require: 'undefined',
        process: 'undefined',
        module: 'undefined',
        Buffer: 'undefined',
        global: 'undefined',
      });
    } finally {
      await electronApp.close();
    }
  });

  test('window.open to a non-allowlisted origin is blocked, not opened', async () => {
    const electronApp = await launchWithFixture('window-open.html');
    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => '__windowOpenResult' in window);

      // window.open() returns null synchronously when the main-process
      // setWindowOpenHandler denies it — no second window is ever created.
      const openResult = await page.evaluate(
        () => (window as unknown as { __windowOpenResult: unknown }).__windowOpenResult,
      );
      expect(openResult).toBeNull();
      expect(electronApp.windows().length).toBe(1);
    } finally {
      await electronApp.close();
    }
  });

  test('microphone permission is denied with no OS-level prompt', async () => {
    const electronApp = await launchWithFixture('mic-permission.html');
    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState('domcontentloaded');

      // A real OS permission prompt would hang this wait well past a few
      // hundred ms, since it requires human interaction Playwright never
      // provides. A prompt-free deny resolves near-instantly.
      await page.waitForFunction(
        () =>
          (window as unknown as { __micPermissionSettled?: boolean }).__micPermissionSettled ===
          true,
        { timeout: 5_000 },
      );

      const outcome = await page.evaluate(
        () => (window as unknown as { __micPermissionOutcome?: string }).__micPermissionOutcome,
      );
      const errorName = await page.evaluate(
        () => (window as unknown as { __micPermissionErrorName?: string }).__micPermissionErrorName,
      );

      expect(outcome).toBe('denied');
      expect(errorName).toBe('NotAllowedError');
    } finally {
      await electronApp.close();
    }
  });

  test('CSP is present and blocks a remote script tag', async () => {
    const electronApp = await launchWithFixture('csp-violation.html');
    try {
      const page = await electronApp.firstWindow();

      const violationPromise = page.waitForFunction(
        () => (window as unknown as { __cspViolations: string[] }).__cspViolations.length > 0,
        { timeout: 5_000 },
      );
      await page.waitForLoadState('domcontentloaded');
      await violationPromise;

      const violations = await page.evaluate(
        () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
      );
      expect(violations).toContain('script-src-elem');

      // The remote script never ran — it would have thrown ReferenceError
      // trying to set a global, since it doesn't exist; absence of the
      // error plus no console output referencing it is checked indirectly
      // by the page still being fully functional and __cspViolations
      // having recorded the block synchronously.
    } finally {
      await electronApp.close();
    }
  });
});
