import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderAuthError, ProviderRateLimitError } from '@chimera/errors';
import { MockProvider, type ModelCapabilities } from '@chimera/providers';
import type {
  AdapterCallOptions,
  NormalisedRequest,
  NormalisedResponse,
  ProviderAdapter,
  StreamEvent,
} from '@chimera/providers';
import { openDatabase, runsRepository } from '@chimera/store';
import {
  connectInProcess,
  createToolRegistry,
  createSandbox,
  createFilesystemServer,
} from '@chimera/tools';
import { Governor } from './Governor.ts';
import { RateLimiter, backoffDelayMs } from './rateLimiter.ts';
import type { ModelCallRequest } from './types.ts';
import { STARTER_ROLES } from '../runtime/roleRegistry.ts';
import { runAgentLoop } from '../runtime/agentLoop.ts';
import { createCheckpointStore } from '../runtime/checkpoint.ts';

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'store',
  'src',
  'migrations',
);
const AUTH = { authRef: 'vault:connection:0'.padEnd(48, '0') as never } as AdapterCallOptions;

const CAPS: ModelCapabilities = {
  modelId: 'mock-frontier',
  displayName: 'Mock frontier',
  contextWindowTokens: 200_000,
  maxOutputTokens: 64_000,
  toolCalling: 'supported',
  vision: 'supported',
  streaming: 'supported',
  structuredOutput: 'supported',
  pricing: { kind: 'local' },
};

function modelRequest(overrides: Partial<ModelCallRequest> = {}): ModelCallRequest {
  return {
    runId: 'run-1',
    nodeId: 'node-1',
    roleId: 'coder',
    iteration: 0,
    depth: 0,
    purpose: 'act',
    connectionId: 'primary',
    model: 'mock-frontier',
    estimatedInputTokens: 10,
    estimatedOutputTokens: 10,
    requiredCapabilities: [],
    ...overrides,
  };
}

const coder = STARTER_ROLES.find((role) => role.id === 'coder');
if (!coder) throw new Error('coder role missing');

/** Fails the first `failures` calls with the given error, then answers normally. */
class FlakyProvider implements ProviderAdapter {
  readonly kind = 'openai-compatible' as const;
  calls = 0;
  private readonly inner = new MockProvider({
    script: { default: { kind: 'text', content: '{"verified": true, "evidence": "done"}' } },
  });
  private readonly failures: number;
  private readonly error: () => Error;

  constructor(failures: number, error: () => Error) {
    this.failures = failures;
    this.error = error;
  }

  chat(request: NormalisedRequest, options: AdapterCallOptions): Promise<NormalisedResponse> {
    this.calls += 1;
    if (this.calls <= this.failures) return Promise.reject(this.error());
    return this.inner.chat(request, options);
  }
  streamChat(request: NormalisedRequest, options: AdapterCallOptions): AsyncIterable<StreamEvent> {
    return this.inner.streamChat(request, options);
  }
  listModels(options: AdapterCallOptions) {
    return this.inner.listModels(options);
  }
  testConnection(options: AdapterCallOptions) {
    return this.inner.testConnection(options);
  }
}

test('backoff grows exponentially and is jittered, not a fixed ladder', () => {
  const policy = { baseBackoffMs: 500, maxBackoffMs: 30_000 };

  // With the random draw pinned to its maximum, the ceiling doubles each
  // attempt and then flattens at the cap.
  const ceilings = [0, 1, 2, 3, 4, 5, 6, 7].map((attempt) =>
    backoffDelayMs(attempt, policy, () => 1),
  );
  assert.deepEqual(ceilings, [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);

  // Full jitter: a uniform draw from [0, ceiling). Several workers limited at
  // the same instant must not all wait the same interval and hit the provider
  // together again — which is exactly what a fixed ladder does.
  const draws = [0.1, 0.9, 0.5, 0.25];
  let index = 0;
  const jittered = draws.map(() => backoffDelayMs(3, policy, () => draws[index++] ?? 0));
  assert.deepEqual(jittered, [400, 3_600, 2_000, 1_000]);
  assert.equal(new Set(jittered).size, draws.length, 'delays were identical across attempts');
});

test('a drained bucket refills on the clock', () => {
  let now = 0;
  const limiter = new RateLimiter(
    { perConnection: { primary: { capacity: 2, refillPerSecond: 1 } } },
    () => now,
  );

  assert.equal(limiter.consume('primary').retryAfterMs, undefined);
  assert.equal(limiter.consume('primary').retryAfterMs, undefined);
  // Empty.
  assert.equal(limiter.consume('primary').retryAfterMs, 1_000);

  now += 1_000;
  assert.equal(limiter.consume('primary').retryAfterMs, undefined);
});

test('a drained primary spills over to the next connection in the chain', () => {
  let now = 0;
  const limiter = new RateLimiter(
    {
      perConnection: {
        primary: { capacity: 1, refillPerSecond: 0.1 },
        secondary: { capacity: 5, refillPerSecond: 1 },
      },
      spillover: { primary: ['secondary'] },
    },
    () => now,
  );

  assert.deepEqual(limiter.consume('primary'), { connectionId: 'primary', spilledOver: false });

  const spilled = limiter.consume('primary');
  assert.equal(spilled.connectionId, 'secondary');
  assert.equal(spilled.spilledOver, true);
  assert.equal(spilled.retryAfterMs, undefined);
});

test('the Governor rewrites the request to the spillover connection', () => {
  const governor = new Governor('enforcing', {
    capabilitiesFor: () => CAPS,
    rate: {
      perConnection: {
        primary: { capacity: 1, refillPerSecond: 0.01 },
        secondary: { capacity: 5, refillPerSecond: 1 },
      },
      spillover: { primary: ['secondary'] },
    },
  });

  assert.equal(governor.authorizeModelCall(modelRequest()).decision, 'allow');

  const second = governor.authorizeModelCall(modelRequest());
  assert.equal(second.decision, 'allow');
  if (second.decision !== 'allow') return;
  // This is why an authorization carries the request back rather than a bare
  // yes: the caller must dispatch to the connection the Governor chose.
  assert.equal(second.request.connectionId, 'secondary');
  assert.ok(second.notes.some((note) => note.includes('spilled over')));
});

test('with no spillover left, the Governor denies rather than queueing forever', () => {
  const governor = new Governor('enforcing', {
    capabilitiesFor: () => CAPS,
    rate: { perConnection: { primary: { capacity: 1, refillPerSecond: 0.5 } } },
  });

  assert.equal(governor.authorizeModelCall(modelRequest()).decision, 'allow');
  const denied = governor.authorizeModelCall(modelRequest());
  assert.equal(denied.decision, 'deny');
  if (denied.decision !== 'deny') return;
  assert.equal(denied.code, 'GOVERNOR_RATE_LIMITED');
  assert.match(denied.message, /recovers in 2s/);
});

test("a provider's own 429 empties our bucket, whatever our accounting thought", () => {
  let now = 0;
  const limiter = new RateLimiter(
    { perConnection: { primary: { capacity: 10, refillPerSecond: 1 } } },
    () => now,
  );

  assert.equal(limiter.hasHeadroom('primary'), true);
  // The provider's answer is more authoritative than our model of its limits.
  // Continuing to send because our own accounting says there is headroom is how
  // a soft limit becomes a hard block.
  limiter.penalise('primary', 5_000);
  assert.equal(limiter.hasHeadroom('primary'), false);

  now += 4_000;
  assert.equal(limiter.hasHeadroom('primary'), false);
  now += 2_000;
  assert.equal(limiter.hasHeadroom('primary'), true);
});

test('a rate-limited call is retried with backoff and then succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-rate-'));
  const sandbox = createSandbox(path.join(dir, 'sandboxes'), 'run-1');
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));

  const delays: number[] = [];

  try {
    const governor = new Governor('enforcing', {
      capabilitiesFor: () => CAPS,
      // Tiny backoff so the test does not sleep for real time; the schedule's
      // shape is asserted in the unit test above.
      rate: { maxRetries: 3, baseBackoffMs: 1, maxBackoffMs: 4 },
      random: () => 1,
      stall: null,
    });
    const original = governor.backoffFor.bind(governor);
    governor.backoffFor = (attempt: number) => {
      const delay = original(attempt);
      delays.push(delay);
      return delay;
    };

    const provider = new FlakyProvider(
      2,
      () => new ProviderRateLimitError('slow down', { retryAfterMs: 1 }),
    );

    const result = await runAgentLoop(
      {
        runId: 'run-1',
        nodeId: 'node-1',
        role: { ...coder, maxIterations: 1 },
        task: 'Do the thing.',
        connectionId: 'primary',
        model: 'mock-frontier',
      },
      { governor, provider, tools, callOptions: AUTH },
    );

    // Two failures, two retries, then the call went through.
    assert.equal(provider.calls > 2, true);
    assert.deepEqual(delays, [1, 2]);
    assert.notEqual(result.status, 'denied');
  } finally {
    await tools.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sustained rate limiting surfaces the error instead of retrying forever', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-rate-2-'));
  const sandbox = createSandbox(path.join(dir, 'sandboxes'), 'run-2');
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));

  try {
    const governor = new Governor('enforcing', {
      capabilitiesFor: () => CAPS,
      rate: { maxRetries: 2, baseBackoffMs: 1, maxBackoffMs: 2 },
      random: () => 0,
      stall: null,
    });
    const provider = new FlakyProvider(
      Number.MAX_SAFE_INTEGER,
      () => new ProviderRateLimitError('still limited', {}),
    );

    await assert.rejects(
      () =>
        runAgentLoop(
          {
            runId: 'run-2',
            nodeId: 'node-1',
            role: coder,
            task: 'Do the thing.',
            connectionId: 'primary',
            model: 'mock-frontier',
          },
          { governor, provider, tools, callOptions: AUTH },
        ),
      (err: unknown) => err instanceof ProviderRateLimitError,
    );

    // Bounded, per CLAUDE.md's "no unbounded loops": the first attempt plus
    // exactly maxRetries more.
    assert.equal(provider.calls, 3);
  } finally {
    await tools.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a key revoked mid-run surfaces immediately, checkpoints, and stays resumable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-auth-'));
  const db = openDatabase({ dbPath: path.join(dir, 'w.sqlite'), migrationsDir });
  runsRepository.create(db, { id: 'run-3' });
  const sandbox = createSandbox(path.join(dir, 'sandboxes'), 'run-3');
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));
  const checkpoints = createCheckpointStore(db);

  try {
    const governor = new Governor('enforcing', {
      capabilitiesFor: () => CAPS,
      rate: { maxRetries: 5, baseBackoffMs: 1, maxBackoffMs: 2 },
      stall: null,
    });

    // Answers the plan call, then the key is revoked.
    let calls = 0;
    const inner = new MockProvider({
      script: { default: { kind: 'text', content: 'Plan: do the thing.' } },
    });
    const provider: ProviderAdapter = {
      kind: 'openai-compatible',
      chat: (request, options) => {
        calls += 1;
        if (calls === 1) return inner.chat(request, options);
        return Promise.reject(new ProviderAuthError('credential rejected'));
      },
      streamChat: (request, options) => inner.streamChat(request, options),
      listModels: (options) => inner.listModels(options),
      testConnection: (options) => inner.testConnection(options),
    };

    await assert.rejects(
      () =>
        runAgentLoop(
          {
            runId: 'run-3',
            nodeId: 'node-1',
            role: coder,
            task: 'Do the thing.',
            connectionId: 'primary',
            model: 'mock-frontier',
          },
          { governor, provider, tools, callOptions: AUTH, checkpoints },
        ),
      (err: unknown) => err instanceof ProviderAuthError,
    );

    // Not retried: a revoked key does not become valid because we asked again,
    // and burning the retry budget to discover that wastes time and money.
    assert.equal(calls, 2);

    // The last-good state is journaled, so the run resumes once a valid key is
    // restored rather than starting from the beginning.
    const journal = checkpoints.load('run-3', 'node-1');
    assert.ok(journal);
    assert.equal(journal.steps.length, 1);
    assert.equal(journal.steps[0]?.purpose, 'plan');

    // Three iterations, not one: the failed attempt already consumed iteration
    // 1 and the journal remembers that, which is the point — a resumed run
    // continues its iteration count rather than getting a fresh allowance.
    const resumed = await runAgentLoop(
      {
        runId: 'run-3',
        nodeId: 'node-1',
        role: { ...coder, maxIterations: 3 },
        task: 'Do the thing.',
        connectionId: 'primary',
        model: 'mock-frontier',
      },
      {
        governor: new Governor('enforcing', { capabilitiesFor: () => CAPS, stall: null }),
        provider: new MockProvider({
          script: { default: { kind: 'text', content: '{"verified": true, "evidence": "ok"}' } },
        }),
        tools,
        callOptions: AUTH,
        checkpoints,
      },
    );

    assert.equal(resumed.status, 'succeeded');
    // It did not replan: the plan step came from the journal.
    assert.equal(resumed.steps.filter((step) => step.purpose === 'plan').length, 1);
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
