import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebContents } from 'electron';
import {
  clearSubscriptions,
  emitRunEvent,
  subscribe,
  subscriberCount,
  unsubscribe,
} from './subscriptions.ts';

// The push side of M3-4. Exercised without Electron: this module imports the
// `WebContents` type only, never the runtime, which is what lets the delivery
// rules be tested at all rather than only observed in an E2E.

interface Sent {
  channel: string;
  payload: unknown;
}

function fakeWebContents(): WebContents & { sent: Sent[]; destroy: () => void } {
  const sent: Sent[] = [];
  let destroyed = false;
  const handlers = new Map<string, (() => void)[]>();

  const contents = {
    sent,
    send: (channel: string, payload: unknown) => {
      if (destroyed) throw new Error('send on a destroyed WebContents');
      sent.push({ channel, payload });
    },
    isDestroyed: () => destroyed,
    once: (event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    destroy: () => {
      destroyed = true;
      for (const handler of handlers.get('destroyed') ?? []) handler();
    },
  };

  return contents as unknown as WebContents & { sent: Sent[]; destroy: () => void };
}

test('an event reaches every subscriber of that run and nobody else', () => {
  clearSubscriptions();
  const watchingA = fakeWebContents();
  const alsoWatchingA = fakeWebContents();
  const watchingB = fakeWebContents();

  subscribe('run-a', watchingA);
  subscribe('run-a', alsoWatchingA);
  subscribe('run-b', watchingB);

  emitRunEvent('run-a', 'spend', { tokens: 1_200, costUsd: 0.02 });

  assert.equal(watchingA.sent.length, 1);
  assert.equal(alsoWatchingA.sent.length, 1);
  // A second window watching a different run must not receive this one's
  // events — the whole reason subscriptions are per run and per WebContents.
  assert.equal(watchingB.sent.length, 0);

  const envelope = watchingA.sent[0]?.payload as {
    channel: string;
    payload: { runId: string; type: string; data: { tokens: number } };
  };
  assert.equal(envelope.channel, 'run:event');
  assert.equal(envelope.payload.runId, 'run-a');
  assert.equal(envelope.payload.type, 'spend');
  assert.equal(envelope.payload.data.tokens, 1_200);
});

test('a destroyed window stops receiving, and does not break the emit for others', () => {
  clearSubscriptions();
  const closed = fakeWebContents();
  const open = fakeWebContents();
  subscribe('run-a', closed);
  subscribe('run-a', open);

  closed.destroy();

  // A run outlives its window. Without the cleanup, every later emit would
  // throw on the dead reference and the surviving window would miss events.
  assert.doesNotThrow(() => {
    emitRunEvent('run-a', 'spend', { tokens: 1 });
  });
  assert.equal(open.sent.length, 1);
  assert.equal(subscriberCount('run-a'), 1);
});

test('emitting to a run nobody is watching is silent, not an error', () => {
  clearSubscriptions();
  // A run continues whether or not a window is open: the events are a view of
  // it, not a part of it.
  assert.doesNotThrow(() => {
    emitRunEvent('nobody-home', 'spend', { tokens: 1 });
  });
});

test('unsubscribing removes exactly one watcher', () => {
  clearSubscriptions();
  const first = fakeWebContents();
  const second = fakeWebContents();
  subscribe('run-a', first);
  subscribe('run-a', second);
  assert.equal(subscriberCount('run-a'), 2);

  unsubscribe('run-a', first);
  assert.equal(subscriberCount('run-a'), 1);

  emitRunEvent('run-a', 'spend', {});
  assert.equal(first.sent.length, 0);
  assert.equal(second.sent.length, 1);
});
