import { test, expect } from '@playwright/test';
import path from 'node:path';
import { desktopRoot, freshProfile, launchApp, removeProfile } from './support/app.ts';

// The window a run gets to itself.
//
// This covers the half that needs no provider: the second window opens, the
// renderer recognises which window it is, and the monitor draws. That a run
// opens it is covered by the live suite, which needs a working OS keychain and
// a real model.

test.describe.configure({ timeout: 120_000 });

test('a second window renders the run monitor rather than the shell', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    await app.firstWindow();

    // Waiting starts before the window exists: `loadFile` resolves inside the
    // evaluate, so by the time it returns the window has already opened and
    // the event has already gone.
    const opened = app.waitForEvent('window');

    // Opened the way the run does: same bundle, told apart by its own URL.
    await app.evaluate(
      async ({ BrowserWindow }, { entry, preload }) => {
        const win = new BrowserWindow({
          width: 520,
          height: 720,
          show: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload,
          },
        });
        await win.loadFile(entry, {
          query: { view: 'run', runId: 'run-under-test', name: 'Supplier review', splash: '0' },
        });
      },
      {
        entry: path.join(desktopRoot, 'dist', 'renderer', 'index.html'),
        preload: path.join(desktopRoot, 'dist', 'preload.cjs'),
      },
    );

    const monitor = await opened;
    await monitor.waitForLoadState('domcontentloaded');

    // It is the monitor, not the shell: no sidebar, no canvas.
    await expect(monitor.getByTestId('run-monitor')).toBeVisible({ timeout: 20_000 });
    await expect(monitor.locator('.sidebar')).toHaveCount(0);

    // It names the run and says where it has got to.
    await expect(monitor.getByTestId('run-monitor')).toContainText('Supplier review');
    await expect(monitor.getByTestId('monitor-meta')).toContainText('Running');
    await expect(monitor.getByTestId('monitor-steps')).toContainText('Starting');

    if (process.env['CHIMERA_SHOTS'] === '1') {
      await monitor.screenshot({ path: 'test-results/shots/run-monitor.png' });
    }
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
