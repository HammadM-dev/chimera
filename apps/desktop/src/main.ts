import { app, BrowserWindow } from 'electron';
import { createWindow } from './windows.ts';
import { registerIpcMainHandlers } from './ipc/mainDispatch.ts';
import { openStore, closeStore } from './store/lifecycle.ts';

void app.whenReady().then(() => {
  // Before any window exists: the store applies pending migrations on open,
  // and a renderer that came up first could invoke a channel whose handler
  // expects a migrated database.
  openStore();
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
