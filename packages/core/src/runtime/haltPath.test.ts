import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockProvider, type ModelCapabilities } from '@chimera/providers';
import type { AdapterCallOptions } from '@chimera/providers';
import {
  connectInProcess,
  createToolRegistry,
  createSandbox,
  createFilesystemServer,
  type ToolRegistry,
} from '@chimera/tools';
import { Governor } from '../governor/Governor.ts';
import { STARTER_ROLES, type Role } from './roleRegistry.ts';
import { runAgentLoop, type HaltCause, type LoopResult } from './agentLoop.ts';
import { outcomeOf } from './runOutcome.ts';

// M3-6: manual cancel, budget cap, stall and rate-limit exhaustion all end the
// run through one code path. `onHalt` is fired by that path and by nothing
// else, so a second halt route would either miss it or fire it twice — which is
// a property a test can hold, unlike "we were careful".

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
  pricing: {
    kind: 'metered',
    inputPerMillion: 1,
    outputPerMillion: 5,
    currency: 'USD',
    verifiedAt: '2026-06-24',
  },
};

const found = STARTER_ROLES.find((role) => role.id === 'coder');
if (!found) throw new Error('coder role missing');
const coder: Role = found;

const REPEATED = 'Still checking the configuration file for the setting, as before.';

async function withTools<T>(body: (tools: ToolRegistry) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-halt-'));
  const sandbox = createSandbox(path.join(dir, 'sandboxes'), 'run-1');
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));
  try {
    return await body(tools);
  } finally {
    await tools.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface HaltObservation {
  causes: HaltCause[];
  result: LoopResult;
}

async function runUntilHalt(
  governor: Governor,
  tools: ToolRegistry,
  options: { cancelAfterFirstCall?: boolean } = {},
): Promise<HaltObservation> {
  const causes: HaltCause[] = [];
  const cancellation = { cancelled: false };

  const inner = new MockProvider({ script: { default: { kind: 'text', content: REPEATED } } });
  const provider = {
    ...inner,
    chat: async (...args: Parameters<MockProvider['chat']>) => {
      const response = await inner.chat(...args);
      if (options.cancelAfterFirstCall === true) cancellation.cancelled = true;
      return response;
    },
  } as unknown as MockProvider;

  const result = await runAgentLoop(
    {
      runId: 'run-1',
      nodeId: 'node-1',
      role: coder,
      task: 'Do the thing.',
      connectionId: 'primary',
      model: 'mock-frontier',
    },
    {
      governor,
      provider,
      tools,
      callOptions: AUTH,
      cancellation,
      onHalt: (cause) => causes.push(cause),
    },
  );

  return { causes, result };
}

test('all four halt causes go through the one halt path, exactly once each', async () => {
  await withTools(async (tools) => {
    const scenarios: [string, Governor, HaltCause, { cancelAfterFirstCall?: boolean }][] = [
      [
        'manual cancel',
        new Governor('enforcing', { capabilitiesFor: () => CAPS, stall: null }),
        'cancelled',
        { cancelAfterFirstCall: true },
      ],
      [
        'budget cap',
        new Governor('enforcing', {
          capabilitiesFor: () => CAPS,
          budget: { run: { maxTokens: 100, maxCostUsd: null } },
          stall: null,
        }),
        'budget',
        {},
      ],
      [
        'stall',
        new Governor('enforcing', {
          capabilitiesFor: () => CAPS,
          stall: { windowSize: 2, similarityThreshold: 0.9 },
        }),
        'stall',
        {},
      ],
      [
        'rate-limit exhaustion',
        new Governor('enforcing', {
          capabilitiesFor: () => CAPS,
          stall: null,
          rate: { perConnection: { primary: { capacity: 1, refillPerSecond: 0.001 } } },
        }),
        'rateLimit',
        {},
      ],
    ];

    for (const [name, governor, expected, options] of scenarios) {
      const { causes, result } = await runUntilHalt(governor, tools, options);

      // Fired once — not zero (a second path that forgets) and not twice (a
      // second path that also fires it).
      assert.equal(causes.length, 1, `${name}: halted ${String(causes.length)} times`);
      assert.equal(causes[0], expected, name);
      // And the result the caller receives carries the same cause, so nothing
      // downstream has to re-derive it from a status code.
      assert.equal(result.haltCause, expected, name);
    }
  });
});

test('the four causes are distinguishable in the run outcome a user reads', () => {
  const base = {
    output: '',
    iterations: 1,
    steps: [],
    observations: [],
    verification: null,
    structuredOutput: null,
  };

  const summaries = [
    outcomeOf({ ...base, status: 'cancelled', haltCause: 'cancelled' }),
    outcomeOf({
      ...base,
      status: 'denied',
      haltCause: 'budget',
      denial: {
        decision: 'deny',
        code: 'GOVERNOR_BUDGET_EXCEEDED',
        message: 'cap reached',
        details: {},
      },
    }),
    outcomeOf({
      ...base,
      status: 'denied',
      haltCause: 'stall',
      denial: { decision: 'deny', code: 'GOVERNOR_STALLED', message: 'no progress', details: {} },
    }),
    outcomeOf({
      ...base,
      status: 'denied',
      haltCause: 'rateLimit',
      denial: {
        decision: 'deny',
        code: 'GOVERNOR_RATE_LIMITED',
        message: 'no headroom',
        details: {},
      },
    }),
  ].map((outcome) => outcome.summary ?? '');

  // Four causes, four distinct explanations. A user told only "failed" cannot
  // tell which lever to pull.
  assert.equal(new Set(summaries).size, 4, `summaries were not distinct: ${summaries.join(' | ')}`);
  assert.match(summaries[0] ?? '', /Cancelled/);
  assert.match(summaries[1] ?? '', /spend cap/);
  assert.match(summaries[2] ?? '', /repeating itself/);
  assert.match(summaries[3] ?? '', /step or time limit|rate/i);
});
