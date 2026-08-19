import { app, BrowserWindow } from 'electron';
import { createWindow } from './windows.ts';
import { registerIpcMainHandlers } from './ipc/mainDispatch.ts';
import { openStore, closeStore } from './store/lifecycle.ts';
import { setScreenshotRoot } from './runs/screenshots.ts';
import { closeBrowsers, setBrowserRoot } from './runs/browser.ts';
import { reloadTriggers, stopTriggers } from './triggers/service.ts';
import { registerPanicKey, unregisterPanicKey } from './control/panicKey.ts';
import { startControlBroadcast } from './control/broadcast.ts';
import os from 'node:os';
import path from 'node:path';
import { sweepSandboxes } from '@chimera/tools';

// Electron derives `userData` from the app name, and unpackaged it reads that
// from package.json — which here is the scoped npm name `@chimera/desktop`,
// giving `~/.config/@chimera/desktop`. The packaged build uses
// electron-builder's `productName`, giving `~/.config/CHIMERA`. Left alone,
// development and the shipped app read *different workspaces*: a connection
// added in one is invisible in the other, and a support answer about "delete
// your workspace to start fresh" is wrong for half the people who follow it.
// This was found when exactly that instruction sent the founder to the wrong
// directory. Set before anything reads `getPath('userData')`.
app.setName('CHIMERA');

/** How long a finished run's files stay on disk. A week: long enough that
 * somebody who wants back what a run made can still find it, short enough that
 * a machine running automations daily does not accumulate them forever. */
const SANDBOX_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

void app.whenReady().then(() => {
  // Before any window exists: the store applies pending migrations on open,
  // and a renderer that came up first could invoke a channel whose handler
  // expects a migrated database.
  openStore(app.getPath('userData'));
  setScreenshotRoot(app.getPath('userData'));
  setBrowserRoot(app.getPath('userData'));
  registerIpcMainHandlers();
  // Last week's run directories. Nothing removed them before, so they grew
  // without bound and left whatever the agents were working on in the system
  // temp directory indefinitely — see sweepSandboxes.
  sweepSandboxes(path.join(os.tmpdir(), 'chimera-runs'), SANDBOX_KEEP_MS);
  // Armed before the window exists: an automation on a schedule belongs to the
  // workspace, not to whether somebody is looking at it.
  reloadTriggers();
  // Registered whether or not native control is ever granted: a browser agent
  // filling in the wrong form is exactly as urgent as a mouse moving on its
  // own, and a panic key that covered only one of them is one people learn not
  // to trust.
  void registerPanicKey();
  startControlBroadcast();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Closing the handle checkpoints the WAL. Skipping it leaves a -wal file
// beside the database that the next launch has to recover from — survivable,
// but it turns every quit into an unclean shutdown for no reason.
app.on('will-quit', () => {
  closeStore();
  // Browsers do not close themselves when the app that launched them exits.
  // An orphaned headless Chromium is invisible in the dock and immortal in the
  // process list, and the user has no idea it is ours.
  void closeBrowsers();
  stopTriggers();
  unregisterPanicKey();
});
