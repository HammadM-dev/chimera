import { app, BrowserWindow } from 'electron';
import { createWindow } from './windows.ts';
import { registerIpcMainHandlers } from './ipc/mainDispatch.ts';

void app.whenReady().then(() => {
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
