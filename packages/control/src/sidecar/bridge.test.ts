import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarError } from '@chimera/errors';
import { createSidecarBridge } from './bridge.ts';
import type { SidecarEvent } from './protocol.ts';

// M8-1. The TypeScript half, against a stand-in process that speaks the same
// protocol — which is what the Rust binary will be replacing, line for line.

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fakeSidecar.mjs');

/**
 * A bridge onto the stand-in helper.
 *
 * The timeout is generous by default and short only where a test is waiting
 * for it to fire. It was 2s for every test, which is a race against `node`
 * starting the stand-in at all: run on its own the file passed every time, and
 * run by `node --test` alongside the other files in this package — each of
 * them spawning processes of their own — a different test failed on almost
 * every run. A timeout a test does not care about should never be tight
 * enough to be a clock.
 */
function bridgeFor(
  mode: string,
  onEvent?: (event: SidecarEvent) => void,
  timeoutMs = 15_000,
): ReturnType<typeof createSidecarBridge> {
  return createSidecarBridge({
    path: process.execPath,
    args: [fake, mode],
    timeoutMs,
    ...(onEvent ? { onEvent } : {}),
  });
}

test('a command goes out and its answer comes back', async () => {
  const events: SidecarEvent[] = [];
  const bridge = bridgeFor('normal', (event) => events.push(event));

  try {
    bridge.start();
    const result = (await bridge.send('injectInput', { kind: 'type', text: 'hello' })) as {
      command: string;
      echoed: unknown;
    };

    assert.equal(result.command, 'injectInput');
    assert.deepEqual(result.echoed, { kind: 'type', text: 'hello' });
    // And what it said on the way up, unasked.
    assert.equal(events[0]?.event, 'ready');
  } finally {
    await bridge.stop();
  }
});

test('two commands in flight get their own answers', async () => {
  const bridge = bridgeFor('normal');
  try {
    bridge.start();
    const [first, second] = (await Promise.all([
      bridge.send('capture', { displayId: 1 }),
      bridge.send('capture', { displayId: 2 }),
    ])) as { echoed: { displayId: number } }[];

    // Matched by id, not by order: a helper that answered the second first
    // would otherwise hand each caller the other's screenshot.
    assert.equal(first?.echoed.displayId, 1);
    assert.equal(second?.echoed.displayId, 2);
  } finally {
    await bridge.stop();
  }
});

test('a refusal from the helper arrives as a typed error, not a result', async () => {
  const bridge = bridgeFor('refuse');
  try {
    bridge.start();
    await assert.rejects(
      () => bridge.send('capture'),
      (err: unknown) => err instanceof SidecarError && err.code === 'SIDECAR_DENIED',
    );
  } finally {
    await bridge.stop();
  }
});

test('a helper that dies mid-command fails the command rather than hanging', async () => {
  const bridge = bridgeFor('crash');
  try {
    bridge.start();
    await assert.rejects(
      () => bridge.send('capture'),
      (err: unknown) => err instanceof SidecarError && err.code === 'SIDECAR_GONE',
    );
    assert.equal(bridge.running, false);
  } finally {
    await bridge.stop();
  }
});

test('a helper that never answers times out', async () => {
  // The one test that wants a short one: it is waiting for the timeout.
  const bridge = bridgeFor('silent', undefined, 500);
  try {
    bridge.start();
    await assert.rejects(
      () => bridge.send('capture'),
      (err: unknown) => err instanceof SidecarError && err.code === 'SIDECAR_TIMEOUT',
    );
  } finally {
    await bridge.stop();
  }
});

test('noise on stdout costs a line, not the session', async () => {
  const bridge = bridgeFor('noisy');
  try {
    bridge.start();
    const result = (await bridge.send('capture')) as { command: string };
    assert.equal(result.command, 'capture');
  } finally {
    await bridge.stop();
  }
});

test('sending before starting says so rather than silently doing nothing', async () => {
  const bridge = bridgeFor('normal');
  await assert.rejects(
    () => bridge.send('ping'),
    (err: unknown) => err instanceof SidecarError && err.code === 'SIDECAR_NOT_RUNNING',
  );
});
