import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDatabase, runsRepository, nodeStatesRepository } from '@chimera/store';
import { MockProvider, type ModelCapabilities } from '@chimera/providers';
import type { AdapterCallOptions } from '@chimera/providers';
import {
  connectInProcess,
  createToolRegistry,
  createSandbox,
  createFilesystemServer,
} from '@chimera/tools';
import { Governor } from './Governor.ts';
import { createSpendMeter, type SpendSnapshot } from './spendMeter.ts';
import { STARTER_ROLES } from '../runtime/roleRegistry.ts';
import { runAgentLoop } from '../runtime/agentLoop.ts';
import { finalizeRun, outcomeOf } from '../runtime/runOutcome.ts';
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

/** $1 in, $5 out per million — same shape as a verified matrix entry. */
const PRICED: ModelCapabilities = {
  modelId: 'mock-frontier',
  displayName: 'Mock frontier',
  contextWindowTokens: 200_000,
  maxOutputTokens: 64_000,
  toolCalling: 'supported',
  vision: 'supported',
  streaming: 'supported',
  structuredOutput: 'supported',
  pricing: {
    kind: 'metered',
    inputPerMillion: 1,
    outputPerMillion: 5,
    currency: 'USD',
    verifiedAt: '2026-06-24',
  },
};

function open(runId: string): { db: Database.Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-meter-'));
  const db = openDatabase({ dbPath: path.join(dir, 'w.sqlite'), migrationsDir });
  runsRepository.create(db, { id: runId });
  return { db, dir };
}

const coder = STARTER_ROLES.find((role) => role.id === 'coder');
if (!coder) throw new Error('coder role missing');

test('spend accumulates live, one update per cost-incurring call', () => {
  const { db, dir } = open('run-1');
  const updates: SpendSnapshot[] = [];

  try {
    const governor = new Governor('enforcing', { capabilitiesFor: () => PRICED });
    const meter = createSpendMeter({
      db,
      runId: 'run-1',
      governor,
      onUpdate: (snapshot) => updates.push(snapshot),
    });

    for (let call = 1; call <= 3; call += 1) {
      governor.authorizeModelCall({
        runId: 'run-1',
        nodeId: 'node-1',
        roleId: 'coder',
        iteration: call,
        depth: 0,
        purpose: 'act',
        connectionId: 'conn-1',
        model: 'mock-frontier',
        estimatedInputTokens: 1_000,
        estimatedOutputTokens: 1_000,
        requiredCapabilities: [],
      });
      meter.record({
        nodeId: 'node-1',
        roleId: 'coder',
        model: 'mock-frontier',
        usage: { inputTokens: 1_000_000, outputTokens: 200_000 },
        estimatedInputTokens: 1_000,
        estimatedOutputTokens: 1_000,
      });
    }

    // One push per call, and each carries the total as of that call rather
    // than a delta the consumer would have to accumulate itself.
    assert.equal(updates.length, 3);
    assert.deepEqual(
      updates.map((snapshot) => snapshot.tokens),
      [1_200_000, 2_400_000, 3_600_000],
    );
    // $1 for 1M in, $1 for 200K out at $5/M = $2 per call.
    assert.ok(Math.abs(updates[2]!.costUsd - 6) < 1e-9);

    // Persisted, not just emitted: both the run row and the node row carry it.
    assert.equal(runsRepository.spendOf(db, 'run-1').tokens, 3_600_000);
    assert.equal(nodeStatesRepository.get(db, 'run-1', 'node-1')?.tokensUsed, 3_600_000);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the meter reconciles the estimate, so the Governor decides against the real total', () => {
  const { db, dir } = open('run-2');
  try {
    const governor = new Governor('enforcing', {
      budget: { run: { maxTokens: null, maxCostUsd: 5 } },
      capabilitiesFor: () => PRICED,
    });
    const meter = createSpendMeter({ db, runId: 'run-2', governor });

    const request = {
      runId: 'run-2',
      nodeId: 'node-1',
      roleId: 'coder',
      iteration: 1,
      depth: 0,
      purpose: 'act' as const,
      connectionId: 'conn-1',
      model: 'mock-frontier',
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 1_000,
      requiredCapabilities: [],
    };

    // Estimated at a fraction of a cent, actually cost $4. Without
    // reconciliation the Governor would think it had $5 left and authorise
    // three more calls it cannot afford.
    assert.equal(governor.authorizeModelCall(request).decision, 'allow');
    meter.record({
      nodeId: 'node-1',
      roleId: 'coder',
      model: 'mock-frontier',
      usage: { inputTokens: 4_000_000, outputTokens: 0 },
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 1_000,
    });

    assert.ok(Math.abs(governor.spend().run.costUsd - 4) < 1e-6);

    // A second call of the same size would reach $8 against a $5 cap.
    const second = governor.authorizeModelCall({
      ...request,
      estimatedInputTokens: 4_000_000,
      estimatedOutputTokens: 0,
    });
    assert.equal(second.decision, 'deny');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run halts at its cost cap and never authorises a second call past it', async () => {
  const { db, dir } = open('run-3');
  const sandbox = createSandbox(path.join(dir, 'sandboxes'), 'run-3');
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));

  try {
    // A $1 cap, and a model whose每 call costs far more than that once its real
    // usage is reconciled.
    const governor = new Governor('enforcing', {
      budget: { run: { maxTokens: null, maxCostUsd: 1 } },
      capabilitiesFor: () => PRICED,
      stall: null,
    });
    const meter = createSpendMeter({ db, runId: 'run-3', governor });

    const result = await runAgentLoop(
      {
        runId: 'run-3',
        nodeId: 'node-1',
        role: coder,
        task: 'Do something expensive.',
        connectionId: 'conn-1',
        model: 'mock-frontier',
      },
      {
        governor,
        // Every response reports 2M input tokens: $2 a call against a $1 cap.
        provider: new MockProvider({
          script: { default: { kind: 'text', content: 'x'.repeat(8_000_000) } },
        }),
        tools,
        callOptions: AUTH,
        meter,
        checkpoints: createCheckpointStore(db),
      },
    );

    assert.equal(result.status, 'denied');
    assert.equal(result.denial?.code, 'GOVERNOR_BUDGET_EXCEEDED');

    // The acceptance bound: no *second* call was authorised past the cap. The
    // Governor cannot un-spend a call already dispatched, so the guarantee is
    // about authorisation, not about truncating a call mid-flight.
    const spent = runsRepository.spendOf(db, 'run-3').costUsd;
    assert.ok(spent > 0, 'nothing was recorded as spent');
    assert.equal(
      result.steps.length,
      1,
      `expected the run to stop after its first call, saw ${String(result.steps.length)}`,
    );

    // And the run row says why, in words a person can act on.
    const outcome = finalizeRun(db, 'run-3', result);
    assert.equal(outcome.status, 'halted');
    assert.equal(outcome.code, 'GOVERNOR_BUDGET_EXCEEDED');
    assert.match(outcome.summary ?? '', /spend cap/);

    const run = runsRepository.get(db, 'run-3');
    assert.equal(run?.status, 'halted');
    assert.match(run?.errorSummary ?? '', /spend cap/);
    assert.ok(run?.endedAt);
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a cap halt, a stall halt and a completion are three distinguishable outcomes', () => {
  const base = {
    output: '',
    iterations: 2,
    steps: [],
    observations: [],
    verification: null,
    structuredOutput: null,
  };

  const capped = outcomeOf({
    ...base,
    status: 'denied',
    denial: {
      decision: 'deny',
      code: 'GOVERNOR_BUDGET_EXCEEDED',
      message: 'The run token budget of 100 is spent.',
      details: {},
    },
  });
  const stalled = outcomeOf({
    ...base,
    status: 'denied',
    denial: {
      decision: 'deny',
      code: 'GOVERNOR_STALLED',
      message: 'Node "n" has produced no new information.',
      details: {},
    },
  });
  const done = outcomeOf({ ...base, status: 'succeeded' });
  const ranOut = outcomeOf({ ...base, status: 'exhausted' });

  // All three halts are `halted`, but the code and the summary say which — a
  // user reading "failed" with no reason is left guessing which lever to pull.
  assert.equal(capped.code, 'GOVERNOR_BUDGET_EXCEEDED');
  assert.match(capped.summary ?? '', /spend cap/);
  assert.equal(stalled.code, 'GOVERNOR_STALLED');
  assert.match(stalled.summary ?? '', /repeating itself/);
  assert.notEqual(capped.summary, stalled.summary);

  assert.equal(done.status, 'succeeded');
  assert.equal(done.summary, null);

  // Out of iterations is not a failure: the work done may still be worth
  // something, and "not finished" is the honest label.
  assert.equal(ranOut.status, 'incomplete');
  assert.match(ranOut.summary ?? '', /iteration limit/);
});
