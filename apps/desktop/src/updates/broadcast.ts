import { BrowserWindow } from 'electron';
import { getChannel } from '../ipc/registry.ts';
import { EVENT_CHANNEL } from '../ipc/channelNames.ts';
import { onUpdateChanged, type UpdateState } from './service.ts';

// Telling every window where the update got to.
//
// Broadcast rather than answered on request, for the same reason the control
// indicator is: a download runs for a minute or two and the progress is the
// point. Polling it would be a request every second to learn a number the main
// process already knows.
//
// Every window, not the focused one. A run monitor open beside the main window
// should not be the one place that says a restart is pending.

function send(state: UpdateState): void {
  const channel = getChannel('update:changed');
  if (!channel) return;

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(EVENT_CHANNEL, {
      v: channel.v,
      channel: 'update:changed',
      payload: state,
    });
  }
}

/** Called once at startup. */
export function startUpdateBroadcast(): void {
  onUpdateChanged(send);
}
