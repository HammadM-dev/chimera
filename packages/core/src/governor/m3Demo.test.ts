import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runsRepository, tracesRepository } from '@chimera/store';
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
import { describePreview, estimate } from './costPreview.ts';
import { STARTER_ROLES } from '../runtime/roleRegistry.ts';
import { runAgentLoop } from '../runtime/agentLoop.ts';
import { createCheckpointStore } from '../runtime/checkpoint.ts';
import { createTraceSink } from '../runtime/trace.ts';
import { finalizeRun } from '../runtime/runOutcome.ts';

// M3-7: the milestone's exit criterion, verbatim from the master plan — "set a
// $1 cap, watch a run stop at $1."
//
// Everything here is the real thing except the HTTP endpoint: a real role, a
// real sandbox, the real Governor in enforcing mode, the real meter writing to
// SQLite, and the real trace.

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

/** $1 per million in, $5 per million out — Haiku's shape. */
const PRICED: ModelCapabilities = {
  modelId: 'mock-frontier',
  displayName: 'Mock frontier',
  contextWindowTokens: 1_000_000,
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

const coder = STARTER_ROLES.find((role) => role.id === 'coder');
if (!coder) throw new Error('coder role missing');

test('a $1 cap stops the run at $1, and the preview said it would', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-m3-demo-'));
  const db = openDatabase({ dbPath: path.join(dir, 'workspace.sqlite'), migrationsDir });
  runsRepository.create(db, { id: 'demo-run' });

  const sandbox = createSandbox(path.join(dir, 'sandboxes'), 'demo-run');
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));

  const CAP_USD = 1;
  const snapshots: SpendSnapshot[] = [];

  try {
    // ---- before the run: what will this cost? ----------------------------
    // The node is bound to a model at $1/$5 and expects 2M input tokens per
    // iteration across eight iterations. Uncapped that is well over a dollar.
    const preview = estimate(
      {
        nodes: [
          {
            id: 'node-1',
            model: 'mock-frontier',
            maxIterations: 8,
            expectedInputTokensPerIteration: 2_000_000,
            expectedOutputTokensPerIteration: 0,
          },
        ],
      },
      { capabilitiesFor: () => PRICED },
    );

    // Criterion 3: the preview foreshadowed the halt. Not a wildly wrong number
    // disconnected from what happened — meaningfully above the cap, which is
    // what makes the halt predictable rather than a surprise.
    assert.ok(
      (preview.totalCostUsd ?? 0) > CAP_USD * 2,
      `preview was $${String(preview.totalCostUsd)}, which does not foreshadow a $1 halt`,
    );
    assert.match(describePreview(preview), /\$\d+\.\d\d est/);

    // ---- the run ---------------------------------------------------------
    const governor = new Governor('enforcing', {
      // The single-node workflow's declared budget. F4.1: the Governor reads
      // this, it does not invent it.
      budget: { run: { maxTokens: null, maxCostUsd: CAP_USD } },
      capabilitiesFor: () => PRICED,
      stall: null,
    });
    const meter = createSpendMeter({
      db,
      runId: 'demo-run',
      governor,
      onUpdate: (snapshot) => snapshots.push(snapshot),
    });

    const result = await runAgentLoop(
      {
        runId: 'demo-run',
        nodeId: 'node-1',
        role: coder,
        task: 'Summarise every file in the workspace.',
        connectionId: 'conn-1',
        model: 'mock-frontier',
      },
      {
        governor,
        // Each response is 480K characters, which the mock counts as 120K
        // output tokens — about $0.60 a call at $5 per million. The second call
        // takes the run past $1.20, so the third is refused and the meter has a
        // climb to show rather than a single jump.
        provider: new MockProvider({
          script: { default: { kind: 'text', content: 'x'.repeat(480_000) } },
        }),
        tools,
        callOptions: AUTH,
        meter,
        checkpoints: createCheckpointStore(db),
        trace: createTraceSink(db, 'demo-run'),
      },
    );

    // ---- the halt --------------------------------------------------------
    assert.equal(result.status, 'denied');
    assert.equal(result.haltCause, 'budget');
    assert.equal(result.denial?.code, 'GOVERNOR_BUDGET_EXCEEDED');

    const outcome = finalizeRun(db, 'demo-run', result);
    assert.equal(outcome.status, 'halted');
    assert.match(outcome.summary ?? '', /spend cap/);
    assert.equal(runsRepository.get(db, 'demo-run')?.status, 'halted');

    // ---- the meter showed the climb --------------------------------------
    assert.ok(snapshots.length >= 2, 'the meter reported fewer than two updates');
    for (let index = 1; index < snapshots.length; index += 1) {
      assert.ok(
        (snapshots[index]?.costUsd ?? 0) > (snapshots[index - 1]?.costUsd ?? 0),
        'spend did not climb between updates',
      );
    }

    const spent = runsRepository.spendOf(db, 'demo-run').costUsd;
    assert.equal(spent, snapshots.at(-1)?.costUsd);
    assert.ok(spent > 0, 'nothing was recorded as spent');

    // The acceptance bound M3-4 states: the Governor cannot un-spend a call
    // already dispatched, so the guarantee is that no *further* call was
    // authorised past the cap — spend lands within one call's overshoot.
    const perCallCost = spent / snapshots.length;
    assert.ok(
      spent <= CAP_USD + perCallCost,
      `spent $${spent.toFixed(4)} against a $1 cap with a per-call cost of $${perCallCost.toFixed(4)}`,
    );

    // ---- and it is all in the trace --------------------------------------
    const events = tracesRepository.listForRun(db, 'demo-run');
    const denial = events
      .filter((event) => event.eventType === 'decision')
      .map((event) => JSON.parse(event.payloadJson) as { decision: string; code?: string })
      .find((payload) => payload.decision === 'denied');
    assert.ok(denial, 'the denial is not in the audit trace');
    assert.equal(denial.code, 'GOVERNOR_BUDGET_EXCEEDED');

    // Every model call that did happen is accounted for, with its usage.
    const responses = events.filter((event) => event.eventType === 'response');
    assert.equal(responses.length, snapshots.length);
    assert.ok(responses.every((event) => (event.tokensIn ?? 0) > 0));
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
