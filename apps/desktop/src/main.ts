import { app, BrowserWindow } from 'electron';
import { createWindow } from './windows.ts';
import { registerIpcMainHandlers } from './ipc/mainDispatch.ts';
import { openStore, closeStore } from './store/lifecycle.ts';

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

void app.whenReady().then(() => {
  // Before any window exists: the store applies pending migrations on open,
  // and a renderer that came up first could invoke a channel whose handler
  // expects a migrated database.
  openStore(app.getPath('userData'));
  registerIpcMainHandlers();
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
});
