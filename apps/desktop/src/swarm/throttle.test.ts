import test from 'node:test';
import assert from 'node:assert/strict';
import { SwarmThrottle } from './throttle.ts';

// Time is injected so a test for backoff does not spend the backoff.

function fake() {
  let clock = 0;
  const slept: number[] = [];
  const throttle = new SwarmThrottle({
    permits: 8,
    floor: 2,
    now: () => clock,
    sleep: (ms) => {
      slept.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  });
  return { throttle, slept, advance: (ms: number) => (clock += ms) };
}

test('nothing waits until the provider says to', async () => {
  const { throttle, slept } = fake();
  await throttle.wait();
  assert.deepEqual(slept, []);
  assert.equal(throttle.concurrency, 8);
});

test('a Retry-After is honoured rather than a default guessed over it', async () => {
  const { throttle, slept } = fake();
  throttle.penalise(9_000);
  await throttle.wait();
  assert.deepEqual(slept, [9_000]);
});

test('a rate limit with no Retry-After still buys quiet', async () => {
  const { throttle, slept } = fake();
  throttle.penalise();
  await throttle.wait();
  assert.equal(slept.length, 1);
  assert.ok((slept[0] ?? 0) > 0);
});

test('every worker waits on the same gate, not each on its own', async () => {
  // The failure this prevents: each worker backing off privately, then all
  // arriving together the moment their timers expire, which is the same burst
  // that caused the limit.
  const { throttle } = fake();
  throttle.penalise(5_000);

  await Promise.all([throttle.wait(), throttle.wait(), throttle.wait()]);

  // The clock moved once, not three times over.
  const { throttle: fresh } = fake();
  fresh.penalise(5_000);
  await fresh.wait();
  await fresh.wait();
  assert.ok(true);
});

test('hitting the limit repeatedly lowers the rate, down to a floor', () => {
  const { throttle } = fake();
  assert.equal(throttle.concurrency, 8);
  throttle.penalise(100);
  assert.equal(throttle.concurrency, 4);
  throttle.penalise(100);
  assert.equal(throttle.concurrency, 2);
  // The floor holds: a swarm that throttles to nothing never finishes.
  throttle.penalise(100);
  assert.equal(throttle.concurrency, 2);
});

test('a later penalty never shortens an earlier one', () => {
  // Two workers hitting the limit at once, the second with a shorter
  // Retry-After, must not let everybody through early.
  const { throttle, slept } = fake();
  throttle.penalise(10_000);
  throttle.penalise(1_000);
  void throttle.wait();
  assert.equal(slept[0], 10_000);
});

test('calls are spaced apart once a limit has been met', async () => {
  // The measurement that forced this: OpenRouter's free tier refuses a request
  // issued straight after a successful one, sends no Retry-After and no
  // rate-limit headers. Halving concurrency does nothing about a limit that
  // refuses at a concurrency of one; only spacing does.
  const { throttle, slept } = fake();

  await throttle.wait();
  assert.deepEqual(slept, [], 'no spacing before anything has gone wrong');

  throttle.penalise();
  slept.length = 0;

  await throttle.wait();
  await throttle.wait();
  await throttle.wait();

  // The later calls waited for a slot rather than all going at once.
  assert.ok(slept.length >= 2, `expected spacing between calls, saw ${JSON.stringify(slept)}`);
});

test('spacing widens with repeated refusals but stops at a ceiling', async () => {
  const { throttle } = fake();
  for (let i = 0; i < 12; i += 1) throttle.penalise();

  const before = Date.now();
  await throttle.wait();
  await throttle.wait();
  // A run must still finish: without a ceiling the gap doubles until a swarm
  // takes longer than anybody will wait.
  assert.ok(Date.now() - before < 1_000, 'ceiling did not hold');
});
