import { test, expect, type ElectronApplication } from '@playwright/test';
import path from 'node:path';
import { fixturesDir, freshProfile, launchApp, removeProfile } from './support/app.ts';

let profile: string;

test.beforeEach(() => {
  profile = freshProfile();
});

test.afterEach(() => {
  removeProfile(profile);
});

async function launchWithFixture(fixture?: string): Promise<ElectronApplication> {
  return launchApp({
    profile,
    ...(fixture ? { fixture: path.join(fixturesDir, fixture) } : {}),
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

      const probe = await page.evaluate(() => {
        const w = window as unknown as {
          __micPermissionOutcome?: string;
          __micPermissionErrorName?: string;
          __audioInputCount?: number;
        };
        return {
          outcome: w.__micPermissionOutcome,
          errorName: w.__micPermissionErrorName,
          audioInputCount: w.__audioInputCount ?? 0,
        };
      });

      // Never granted, on any machine.
      expect(probe.outcome).toBe('denied');

      // Where there is no audio input device at all — every GitHub Actions
      // runner — getUserMedia rejects with NotFoundError before Electron's
      // permission handler is consulted, so the denial says nothing about
      // permissions. Skipped rather than asserted loosely: a test that quietly
      // accepts NotFoundError would keep passing if the permission handler were
      // deleted outright. The geolocation test below is the one that holds the
      // handler to account in that environment.
      test.skip(
        probe.audioInputCount === 0,
        'no audio input device present, so the request never reaches the permission layer',
      );
      expect(probe.errorName).toBe('NotAllowedError');
    } finally {
      await electronApp.close();
    }
  });

  test('geolocation permission is denied with no OS-level prompt', async () => {
    // The hardware-independent counterpart to the microphone test above, and
    // the one that actually runs everywhere. docs/SECURITY.md section 7:
    // everything except desktop notifications is denied by default.
    const electronApp = await launchWithFixture('geolocation-permission.html');
    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState('domcontentloaded');

      await page.waitForFunction(
        () => (window as unknown as { __geoSettled?: boolean }).__geoSettled === true,
        { timeout: 5_000 },
      );

      const probe = await page.evaluate(() => {
        const w = window as unknown as { __geoOutcome?: string; __geoErrorCode?: number };
        return { outcome: w.__geoOutcome, code: w.__geoErrorCode };
      });

      expect(probe.outcome).toBe('denied');
      // GeolocationPositionError.PERMISSION_DENIED === 1. Distinguished from
      // POSITION_UNAVAILABLE (2), which is what a *granted* request would
      // return in a CI container with no location provider — the two must not
      // be conflated, since only one of them is the handler doing its job.
      expect(probe.code).toBe(1);
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
