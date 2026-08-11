import type { WebContents } from 'electron';
import { getChannel } from '../ipc/registry.ts';
import { EVENT_CHANNEL } from '../ipc/channelNames.ts';

// Who is watching which run. The renderer calls `run:subscribe` and then
// receives `run:event` pushes — spend updates today (M3-4), node status and
// trace appends when the engine lands (M4-6).
//
// Subscriptions are per WebContents rather than global: a second window
// watching a different run must not receive the first window's events, and a
// closed window must stop receiving anything at all.

const subscribers = new Map<string, Set<WebContents>>();

export function subscribe(runId: string, webContents: WebContents): { subscribed: boolean } {
  const existing = subscribers.get(runId) ?? new Set<WebContents>();
  existing.add(webContents);
  subscribers.set(runId, existing);

  // A destroyed WebContents throws on send, and nothing removes it otherwise —
  // a run that outlives the window would accumulate dead references and throw
  // on every emit.
  webContents.once('destroyed', () => {
    unsubscribe(runId, webContents);
  });

  return { subscribed: true };
}

export function unsubscribe(runId: string, webContents: WebContents): void {
  const existing = subscribers.get(runId);
  if (!existing) return;
  existing.delete(webContents);
  if (existing.size === 0) subscribers.delete(runId);
}

export function subscriberCount(runId: string): number {
  return subscribers.get(runId)?.size ?? 0;
}

/**
 * Pushes one run event to everyone watching that run.
 *
 * Silent when nobody is subscribed. A run continues whether or not a window is
 * open — the events are a view of it, not a part of it.
 */
export function emitRunEvent(runId: string, type: string, data: unknown): void {
  const watching = subscribers.get(runId);
  if (!watching || watching.size === 0) return;

  const channel = getChannel('run:event');
  if (!channel) return;

  for (const webContents of [...watching]) {
    if (webContents.isDestroyed()) {
      unsubscribe(runId, webContents);
      continue;
    }
    webContents.send(EVENT_CHANNEL, {
      v: channel.v,
      channel: 'run:event',
      payload: { runId, type, data },
    });
  }
}

/** Test seam and shutdown path. */
export function clearSubscriptions(): void {
  subscribers.clear();
}
