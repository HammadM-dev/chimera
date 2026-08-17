import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockProvider, MOCK_MODELS, type ModelCapabilities } from '@chimera/providers';
import type { AdapterCallOptions } from '@chimera/providers';
import {
  connectInProcess,
  createToolRegistry,
  createSandbox,
  createFilesystemServer,
} from '@chimera/tools';
import { Governor } from './Governor.ts';
import { BudgetLedger, costOf } from './budget.ts';
import { LimitTracker } from './limits.ts';
import type { ModelCallRequest, ToolCallRequest } from './types.ts';
import { STARTER_ROLES } from '../runtime/roleRegistry.ts';
import { runAgentLoop } from '../runtime/agentLoop.ts';

// M3-1. The stub's internals are replaced; the interface and every call site
// are not. These tests are the first time a *real* denial reaches the exit path
// M2-7 built and tested against a fake one.

/** A metered model at $1/$5 per million — the same shape as a real matrix entry. */
const PRICED: ModelCapabilities = {
  modelId: 'priced-model',
  displayName: 'Priced test model',
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

const UNPRICED: ModelCapabilities = { ...PRICED, pricing: { kind: 'unknown' } };
const NO_TOOLS: ModelCapabilities = { ...PRICED, toolCalling: 'unsupported' };
const UNKNOWN_TOOLS: ModelCapabilities = { ...PRICED, toolCalling: 'unknown' };

function modelRequest(overrides: Partial<ModelCallRequest> = {}): ModelCallRequest {
  return {
    runId: 'run-1',
    nodeId: 'node-a',
    roleId: 'researcher',
    iteration: 0,
    depth: 0,
    purpose: 'act',
    connectionId: 'conn-1',
    model: 'priced-model',
    estimatedInputTokens: 1_000,
    estimatedOutputTokens: 1_000,
    requiredCapabilities: [],
    ...overrides,
  };
}

function toolRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    runId: 'run-1',
    nodeId: 'node-a',
    roleId: 'researcher',
    iteration: 0,
    depth: 0,
    toolId: 'filesystem.readFile',
    egressTargets: [],
    irreversible: false,
    ...overrides,
  };
}

const priced = () => PRICED;

test('a run-level token budget denies the call that would cross it, not the one after', () => {
  // 2,000 tokens per call, 5,000 allowed: two calls fit, the third does not.
  const governor = new Governor('enforcing', {
    budget: { run: { maxTokens: 5_000, maxCostUsd: null } },
    capabilitiesFor: priced,
  });

  assert.equal(governor.authorizeModelCall(modelRequest()).decision, 'allow');
  assert.equal(governor.authorizeModelCall(modelRequest()).decision, 'allow');

  const third = governor.authorizeModelCall(modelRequest());
  assert.equal(third.decision, 'deny');
  if (third.decision !== 'deny') return;
  assert.equal(third.code, 'GOVERNOR_BUDGET_EXCEEDED');
  assert.equal(third.details.scope, 'run');

  // The cap is never crossed: 4,000 committed, and the call that would have
  // reached 6,000 was refused rather than allowed and then reported.
  assert.equal(governor.spend().run.tokens, 4_000);
  assert.ok(governor.spend().run.tokens <= 5_000);
});

test('a per-node cap halts one node while the run still has ample headroom', () => {
  const governor = new Governor('enforcing', {
    budget: {
      run: { maxTokens: 1_000_000, maxCostUsd: null },
      perNode: { expensive: { maxTokens: 3_000, maxCostUsd: null } },
    },
    capabilitiesFor: priced,
  });

  assert.equal(
    governor.authorizeModelCall(modelRequest({ nodeId: 'expensive' })).decision,
    'allow',
  );
  const second = governor.authorizeModelCall(modelRequest({ nodeId: 'expensive' }));
  assert.equal(second.decision, 'deny');
  if (second.decision !== 'deny') return;
  // The report names the node, not just "some cap" — a caller reading this
  // learns which limit to raise.
  assert.equal(second.details.scope, 'node');
  assert.equal(second.details.id, 'expensive');

  // A different node is unaffected: the run cap has 998,000 tokens left.
  assert.equal(governor.authorizeModelCall(modelRequest({ nodeId: 'cheap' })).decision, 'allow');
});

test('a per-role cap is enforced independently of run and node caps', () => {
  const governor = new Governor('enforcing', {
    budget: {
      run: { maxTokens: 1_000_000, maxCostUsd: null },
      perRole: { researcher: { maxTokens: 2_000, maxCostUsd: null } },
    },
    capabilitiesFor: priced,
  });

  // The same role across two different nodes still shares one role budget.
  assert.equal(governor.authorizeModelCall(modelRequest({ nodeId: 'a' })).decision, 'allow');
  const second = governor.authorizeModelCall(modelRequest({ nodeId: 'b' }));
  assert.equal(second.decision, 'deny');
  if (second.decision !== 'deny') return;
  assert.equal(second.details.scope, 'role');
  assert.equal(second.details.id, 'researcher');

  // A different role has its own headroom.
  assert.equal(governor.authorizeModelCall(modelRequest({ roleId: 'coder' })).decision, 'allow');
});

test('a cost cap is enforced from the capability matrix, in money', () => {
  // 1M in + 1M out at $1/$5 = $6.00 per call. A $10 cap allows one.
  const governor = new Governor('enforcing', {
    budget: { run: { maxTokens: null, maxCostUsd: 10 } },
    capabilitiesFor: priced,
  });

  const request = modelRequest({
    estimatedInputTokens: 1_000_000,
    estimatedOutputTokens: 1_000_000,
  });
  assert.equal(governor.authorizeModelCall(request).decision, 'allow');
  assert.equal(governor.spend().run.costUsd, 6);

  const second = governor.authorizeModelCall(request);
  assert.equal(second.decision, 'deny');
  if (second.decision !== 'deny') return;
  assert.equal(second.details.measure, 'cost');
  assert.match(second.message, /\$10\.0000/);
});

test('an unpriced model cannot be held to a cost cap, and the authorization says so', () => {
  const governor = new Governor('enforcing', {
    budget: { run: { maxTokens: 10_000, maxCostUsd: 0.000_01 } },
    capabilitiesFor: () => UNPRICED,
  });

  const result = governor.authorizeModelCall(modelRequest());
  // Treating an unpriced model as free would let an unmetered run straight past
  // a cost cap. It is skipped and disclosed instead.
  assert.equal(result.decision, 'allow');
  if (result.decision !== 'allow') return;
  assert.ok(result.notes.some((note) => note.includes('no verified price')));

  // The token cap still bites, which is why a workspace that cares about money
  // should set one. 2,000 spent, then 8,000 more reaches exactly 10,000.
  assert.equal(
    governor.authorizeModelCall(
      modelRequest({ estimatedInputTokens: 7_000, estimatedOutputTokens: 1_000 }),
    ).decision,
    'allow',
  );
  assert.equal(governor.spend().run.tokens, 10_000);
  assert.equal(governor.authorizeModelCall(modelRequest()).decision, 'deny');
});

test('max recursion depth is enforced', () => {
  const governor = new Governor('enforcing', {
    limits: { maxDepth: 2, maxSteps: null, maxWallClockMs: null },
    capabilitiesFor: priced,
  });

  assert.equal(governor.authorizeModelCall(modelRequest({ depth: 2 })).decision, 'allow');
  const tooDeep = governor.authorizeModelCall(modelRequest({ depth: 3 }));
  assert.equal(tooDeep.decision, 'deny');
  if (tooDeep.decision !== 'deny') return;
  assert.equal(tooDeep.code, 'GOVERNOR_DEPTH_EXCEEDED');

  // Tool calls carry a depth too, and are refused on the same rule.
  assert.equal(governor.authorizeToolCall(toolRequest({ depth: 3 })).decision, 'deny');
});

test('max wall-clock is enforced, on an injected clock', () => {
  // Deliberately its own test rather than folded into the depth one: a run
  // stopped for running too long and a run stopped for nesting too deep are
  // different failures, and a conflated test can pass with one of them broken.
  let now = 1_000;
  const governor = new Governor('enforcing', {
    limits: { maxDepth: null, maxSteps: null, maxWallClockMs: 30_000 },
    capabilitiesFor: priced,
    now: () => now,
  });

  assert.equal(governor.authorizeModelCall(modelRequest()).decision, 'allow');

  now += 29_000;
  assert.equal(governor.authorizeModelCall(modelRequest()).decision, 'allow');

  now += 2_000; // 31s elapsed
  const late = governor.authorizeModelCall(modelRequest());
  assert.equal(late.decision, 'deny');
  if (late.decision !== 'deny') return;
  assert.equal(late.code, 'GOVERNOR_STEP_LIMIT_EXCEEDED');
  assert.match(late.message, /31s/);
});

test('max total steps is enforced across model and tool calls together', () => {
  const governor = new Governor('enforcing', {
    limits: { maxDepth: null, maxSteps: 3, maxWallClockMs: null },
    capabilitiesFor: priced,
  });

  assert.equal(governor.authorizeModelCall(modelRequest()).decision, 'allow');
  assert.equal(governor.authorizeToolCall(toolRequest()).decision, 'allow');
  assert.equal(governor.authorizeModelCall(modelRequest()).decision, 'allow');
  // A tool call is a step like any other: three is three.
  assert.equal(governor.authorizeToolCall(toolRequest()).decision, 'deny');
  assert.equal(governor.steps, 3);
});

test('a capability the model is known to lack is refused', () => {
  const unsupported = new Governor('enforcing', { capabilitiesFor: () => NO_TOOLS });
  const denied = unsupported.authorizeModelCall(
    modelRequest({ requiredCapabilities: ['toolCalling'] }),
  );
  assert.equal(denied.decision, 'deny');
  if (denied.decision !== 'deny') return;
  assert.equal(denied.code, 'GOVERNOR_CAPABILITY_MISMATCH');
});

test('an unverified capability proceeds, and the authorization says it is unverified', () => {
  // M3-1 failed closed on `unknown`. Against a live catalogue that is every
  // model — this build has verified four — so failing closed meant nothing a
  // user picked could ever run. `unsupported` still denies; `unknown` proceeds
  // and is disclosed, because the provider's own answer beats our guess and
  // silence would leave the user wondering why the agent never used a tool.
  const unknown = new Governor('enforcing', { capabilitiesFor: () => UNKNOWN_TOOLS });
  const result = unknown.authorizeModelCall(
    modelRequest({ requiredCapabilities: ['toolCalling'] }),
  );

  assert.equal(result.decision, 'allow');
  if (result.decision !== 'allow') return;
  assert.ok(
    result.notes.some((note) => note.includes('nobody has verified')),
    `the unverified capability was not disclosed: ${JSON.stringify(result.notes)}`,
  );

  // A capability the node does not need is not checked at all, so it is not
  // disclosed either — a note about every unknown fact would be noise.
  const quiet = unknown.authorizeModelCall(modelRequest());
  assert.equal(quiet.decision, 'allow');
  if (quiet.decision !== 'allow') return;
  assert.equal(
    quiet.notes.some((note) => note.includes('nobody has verified')),
    false,
  );
});

test('the ledger reports the most specific breach when several caps are tight', () => {
  const ledger = new BudgetLedger({
    run: { maxTokens: 100, maxCostUsd: null },
    perNode: { n: { maxTokens: 100, maxCostUsd: null } },
  });
  const breach = ledger.wouldBreach({ nodeId: 'n', roleId: 'r' }, { tokens: 101, costUsd: null });
  // Run is checked first and is genuinely breached, so that is what is
  // reported — the outermost cap that is already impossible to satisfy.
  assert.equal(breach?.scope, 'run');
});

test('costOf never reports an unpriced model as free', () => {
  assert.equal(costOf(PRICED, 1_000_000, 0), 1);
  assert.equal(costOf(UNPRICED, 1_000_000, 0), null);
  assert.equal(costOf({ ...PRICED, pricing: { kind: 'local' } }, 1_000_000, 0), 0);
});

test('the limit tracker counts a step only once it has been authorised', () => {
  const tracker = new LimitTracker({ maxDepth: null, maxSteps: 2, maxWallClockMs: null });
  assert.equal(tracker.wouldBreach(0), null);
  tracker.countStep();
  assert.equal(tracker.wouldBreach(0), null);
  tracker.countStep();
  // A limit of two means two calls happen, not three.
  assert.equal(tracker.wouldBreach(0)?.kind, 'steps');
  assert.equal(tracker.stepCount, 2);
});

test('a real budget denial reaches the agent loop exit path M2-7 built', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-m3-'));
  const sandbox = createSandbox(path.join(dir, 'sandboxes'), 'run-1');
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));

  const coder = STARTER_ROLES.find((role) => role.id === 'coder');
  assert.ok(coder);

  try {
    // A budget far below what the task needs: enough for the plan call, not
    // enough to keep going.
    const governor = new Governor('enforcing', {
      budget: { run: { maxTokens: 2_000, maxCostUsd: null } },
      // The mock's synthetic models are not in the real matrix by M1-6's
      // decision, so the lookup is pointed at them explicitly rather than the
      // matrix being polluted with models no user can select.
      capabilitiesFor: (model) => MOCK_MODELS[model] ?? PRICED,
    });

    const result = await runAgentLoop(
      {
        runId: 'run-1',
        nodeId: 'node-1',
        role: coder,
        task: 'Write a file.',
        connectionId: 'conn-1',
        model: 'mock-frontier',
      },
      {
        governor,
        provider: new MockProvider({ script: { default: { kind: 'text', content: 'working' } } }),
        tools,
        callOptions: {
          authRef: 'vault:connection:0'.padEnd(48, '0') as never,
        } as AdapterCallOptions,
      },
    );

    // The exit path was written in M2-7 against a fake denial. This is the
    // first real one, and it lands in exactly the same place.
    assert.equal(result.status, 'denied');
    assert.equal(result.denial?.code, 'GOVERNOR_BUDGET_EXCEEDED');
    assert.equal(result.error?.code, 'GOVERNOR_BUDGET_EXCEEDED');

    // And the cap held: total committed spend never exceeded it.
    assert.ok(
      governor.spend().run.tokens <= 2_000,
      `spent ${String(governor.spend().run.tokens)} against a cap of 2000`,
    );
  } finally {
    await tools.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
