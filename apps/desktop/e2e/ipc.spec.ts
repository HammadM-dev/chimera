import { test, expect } from '@playwright/test';
import { freshProfile, launchApp, removeProfile } from './support/app.ts';

let profile: string;

test.beforeEach(() => {
  profile = freshProfile();
});

test.afterEach(() => {
  removeProfile(profile);
});

interface ChimeraBridge {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
  parseError: (
    err: unknown,
  ) => { code: string; message: string; details: Record<string, unknown> } | null;
}

test.describe('M0-4 preload bridge and IPC registry', () => {
  test('calling an unregistered channel rejects with a typed error, not a silent no-op', async () => {
    const electronApp = await launchApp({ profile });
    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState('domcontentloaded');

      const result = await page.evaluate(async () => {
        const chimera = (window as unknown as { chimera: ChimeraBridge }).chimera;
        try {
          await chimera.invoke('not:a:real:channel', {});
          return { threw: false };
        } catch (err) {
          const parsed = chimera.parseError(err);
          return { threw: true, parsed };
        }
      });

      expect(result.threw).toBe(true);
      expect(result.parsed?.code).toBe('IPC_UNREGISTERED_CHANNEL');
      expect(result.parsed?.message).toContain('not:a:real:channel');
    } finally {
      await electronApp.close();
    }
  });

  test('a registered channel round-trips through preload and main, unimplemented handler surfaces as a typed error', async () => {
    const electronApp = await launchApp({ profile });
    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState('domcontentloaded');

      const result = await page.evaluate(async () => {
        const chimera = (window as unknown as { chimera: ChimeraBridge }).chimera;
        try {
          // `licence:activate` is still a stub — `workflow:list` was, and is
          // now real, which is what this assertion is for: an unimplemented
          // channel must fail as one rather than looking unregistered.
          await chimera.invoke('licence:activate', { token: 'x' });
          return { threw: false };
        } catch (err) {
          const parsed = chimera.parseError(err);
          return { threw: true, parsed };
        }
      });

      // workflow:list is registered (unlike the previous test) but its
      // handler is a not-implemented stub until M4 — the request makes it
      // all the way through preload -> main -> schema validation -> handler
      // before failing, which is different from being rejected locally for
      // not existing at all.
      expect(result.threw).toBe(true);
      expect(result.parsed?.code).toBe('IPC_HANDLER_ERROR');
      expect(result.parsed?.message).toContain('not implemented');
    } finally {
      await electronApp.close();
    }
  });

  test('an invalid payload for a registered channel is rejected by schema validation', async () => {
    const electronApp = await launchApp({ profile });
    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState('domcontentloaded');

      const result = await page.evaluate(async () => {
        const chimera = (window as unknown as { chimera: ChimeraBridge }).chimera;
        try {
          // run:start requires workflowVersionId: string — send a number instead.
          // A payload that fails the schema: `brief` is required and absent.
          await chimera.invoke('run:start', { workflowVersionId: 12345 });
          return { threw: false };
        } catch (err) {
          const parsed = chimera.parseError(err);
          return { threw: true, parsed };
        }
      });

      expect(result.threw).toBe(true);
      expect(result.parsed?.code).toBe('IPC_INVALID_PAYLOAD');
    } finally {
      await electronApp.close();
    }
  });

  test('a genuinely non-IPC renderer error still parses to null, not a false-positive match', async () => {
    const electronApp = await launchApp({ profile });
    try {
      const page = await electronApp.firstWindow();
      await page.waitForLoadState('domcontentloaded');

      const result = await page.evaluate(() => {
        const chimera = (window as unknown as { chimera: ChimeraBridge }).chimera;
        const ordinaryError = new Error('a plain renderer-side error, unrelated to IPC');
        return chimera.parseError(ordinaryError);
      });

      expect(result).toBeNull();
    } finally {
      await electronApp.close();
    }
  });
});
