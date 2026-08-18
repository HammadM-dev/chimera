import { BrowserWindow } from 'electron';
import { getChannel } from '../ipc/registry.ts';
import { EVENT_CHANNEL } from '../ipc/channelNames.ts';
import { onControlSessionChanged, type ControlSession } from './session.ts';
import { onPanicFired } from './panicKey.ts';

// The control indicator's other half: telling every window what is happening.
//
// Broadcast to every window rather than to a subscriber list, because this is
// not a view of one run — it is the state of the machine, and there is exactly
// one of it. A window that missed it would be a window showing "nothing is
// running" while an agent drives the mouse.

function send(payload: { session: ControlSession; cancelledRuns?: number }): void {
  const channel = getChannel('control:event');
  if (!channel) return;

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(EVENT_CHANNEL, {
      v: channel.v,
      channel: 'control:event',
      payload,
    });
  }
}

/** Called once at startup. */
export function startControlBroadcast(): void {
  onControlSessionChanged((session) => {
    send({ session });
  });

  // The panic key fires from outside the window entirely, so the window only
  // learns what happened this way.
  onPanicFired((result) => {
    send({
      session: { granted: false, reason: '', grantedAt: '', dryRun: true },
      cancelledRuns: result.cancelledRuns,
    });
  });
}
