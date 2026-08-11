import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockProvider, MOCK_MODELS } from '@chimera/providers';
import type { AdapterCallOptions } from '@chimera/providers';
import {
  connectInProcess,
  createToolRegistry,
  createSandbox,
  createFilesystemServer,
} from '@chimera/tools';
import { Governor } from './Governor.ts';
import { StallDetector, similarity, toolSignature } from './stallDetector.ts';
import type { ModelCallRequest } from './types.ts';
import { STARTER_ROLES } from '../runtime/roleRegistry.ts';
import { runAgentLoop } from '../runtime/agentLoop.ts';

const AUTH = { authRef: 'vault:connection:0'.padEnd(48, '0') as never } as AdapterCallOptions;

function modelRequest(overrides: Partial<ModelCallRequest> = {}): ModelCallRequest {
  return {
    runId: 'run-1',
    nodeId: 'node-a',
    roleId: 'coder',
    iteration: 0,
    depth: 0,
    purpose: 'act',
    connectionId: 'conn-1',
    model: 'mock-frontier',
    estimatedInputTokens: 10,
    estimatedOutputTokens: 10,
    requiredCapabilities: [],
    ...overrides,
  };
}

const REPEATED = 'I will check the configuration file for the setting and then report back.';

test('similarity sees a reworded restatement as the same thing said twice', () => {
  assert.equal(similarity(REPEATED, REPEATED), 1);
  // Reordered, lightly repunctuated: the same information.
  assert.ok(
    similarity(REPEATED, 'I will check the configuration file for the setting, then report back!') >
      0.9,
  );
  // Genuinely different work.
  assert.ok(similarity(REPEATED, 'Found the bug in the retry loop; opening a patch now.') < 0.3);
});

test('three near-identical iterations with no new tool calls are a stall', () => {
  const detector = new StallDetector({ windowSize: 3, similarityThreshold: 0.9 });

  detector.record({ nodeId: 'n', iteration: 1, text: REPEATED, toolSignatures: [] });
  assert.equal(detector.verdict('n').stalled, false, 'one iteration is not a stall');

  detector.record({ nodeId: 'n', iteration: 2, text: `${REPEATED} `, toolSignatures: [] });
  assert.equal(detector.verdict('n').stalled, false, 'two iterations is not yet the window');

  detector.record({
    nodeId: 'n',
    iteration: 3,
    text: 'I will check the configuration file for the setting and then report back.',
    toolSignatures: [],
  });
  const verdict = detector.verdict('n');
  assert.equal(verdict.stalled, true);
  assert.ok(verdict.lastSimilarity >= 0.9);
});

test('an agent doing genuinely new work is never flagged, however long it runs', () => {
  // The negative control. A detector that halts a working agent is worse than
  // one that never fires: the first destroys good runs, the second only fails
  // to save bad ones.
  const detector = new StallDetector({ windowSize: 3, similarityThreshold: 0.9 });

  for (let iteration = 1; iteration <= 25; iteration += 1) {
    detector.record({
      nodeId: 'n',
      iteration,
      text: `Reading file number ${String(iteration)} and extracting its totals.`,
      toolSignatures: [toolSignature('filesystem.readFile', { path: `file-${String(iteration)}` })],
    });
    assert.equal(detector.verdict('n').stalled, false, `flagged at iteration ${String(iteration)}`);
  }
});

test('identical prose with a new tool call each time is not a stall', () => {
  // A methodical agent that narrates the same way while working through a list
  // is doing new work. Judging on output text alone would halt it.
  const detector = new StallDetector({ windowSize: 3, similarityThreshold: 0.9 });

  for (let iteration = 1; iteration <= 6; iteration += 1) {
    detector.record({
      nodeId: 'n',
      iteration,
      text: 'Checking the next item.',
      toolSignatures: [toolSignature('filesystem.readFile', { path: `item-${String(iteration)}` })],
    });
  }
  assert.equal(detector.verdict('n').stalled, false);
});

test('repeating the identical tool call forever is a stall', () => {
  // The other half: novelty alone would miss this, because the prose could vary
  // while the agent does the same futile thing.
  const detector = new StallDetector({ windowSize: 3, similarityThreshold: 0.9 });
  const same = toolSignature('http.request', { url: 'https://example.com/status' });

  for (let iteration = 1; iteration <= 4; iteration += 1) {
    detector.record({
      nodeId: 'n',
      iteration,
      text: 'Polling the status endpoint again.',
      toolSignatures: [same],
    });
  }
  assert.equal(detector.verdict('n').stalled, true);
});

test('one node stalling does not implicate another', () => {
  const detector = new StallDetector({ windowSize: 3, similarityThreshold: 0.9 });
  for (let iteration = 1; iteration <= 4; iteration += 1) {
    detector.record({ nodeId: 'stuck', iteration, text: REPEATED, toolSignatures: [] });
    detector.record({
      nodeId: 'busy',
      iteration,
      text: `Distinct work, item ${String(iteration)}, nothing in common with the last turn.`,
      toolSignatures: [toolSignature('filesystem.readFile', { path: String(iteration) })],
    });
  }
  assert.equal(detector.verdict('stuck').stalled, true);
  assert.equal(detector.verdict('busy').stalled, false);
});

test('the Governor denies a stalled node with a stall-specific code, not a budget one', () => {
  const governor = new Governor('enforcing', {
    stall: { windowSize: 3, similarityThreshold: 0.9 },
    capabilitiesFor: (model) => MOCK_MODELS[model] ?? MOCK_MODELS['mock-frontier']!,
  });

  for (let iteration = 1; iteration <= 3; iteration += 1) {
    assert.equal(governor.authorizeModelCall(modelRequest({ iteration })).decision, 'allow');
    governor.recordOutcome({ nodeId: 'node-a', iteration, text: REPEATED, toolSignatures: [] });
  }

  const denied = governor.authorizeModelCall(modelRequest({ iteration: 4 }));
  assert.equal(denied.decision, 'deny');
  if (denied.decision !== 'deny') return;
  // "You have spent enough" and "this is not going to finish" are different
  // things to tell a user, and only one of them is fixed by raising a limit.
  assert.equal(denied.code, 'GOVERNOR_STALLED');
  assert.match(denied.message, /no new information/);
  assert.equal(denied.details.nodeId, 'node-a');
});

test('stall detection can be switched off entirely', () => {
  const governor = new Governor('enforcing', {
    stall: null,
    capabilitiesFor: (model) => MOCK_MODELS[model] ?? MOCK_MODELS['mock-frontier']!,
  });
  for (let iteration = 1; iteration <= 10; iteration += 1) {
    governor.recordOutcome({ nodeId: 'node-a', iteration, text: REPEATED, toolSignatures: [] });
    assert.equal(governor.authorizeModelCall(modelRequest({ iteration })).decision, 'allow');
  }
});

test('a real stalled run halts through the agent loop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-stall-'));
  const sandbox = createSandbox(path.join(dir, 'sandboxes'), 'run-1');
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));

  const coder = STARTER_ROLES.find((role) => role.id === 'coder');
  assert.ok(coder);

  try {
    const governor = new Governor('enforcing', {
      stall: { windowSize: 3, similarityThreshold: 0.9 },
      capabilitiesFor: (model) => MOCK_MODELS[model] ?? MOCK_MODELS['mock-frontier']!,
    });

    // A model that says the same thing every turn and never calls a tool. The
    // role allows 25 iterations; the stall detector should stop it long before.
    const result = await runAgentLoop(
      {
        runId: 'run-1',
        nodeId: 'node-1',
        role: coder,
        task: 'Fix the failing test.',
        connectionId: 'conn-1',
        model: 'mock-frontier',
      },
      {
        governor,
        provider: new MockProvider({
          script: { default: { kind: 'text', content: REPEATED } },
        }),
        tools,
        callOptions: AUTH,
      },
    );

    assert.equal(result.status, 'denied');
    assert.equal(result.denial?.code, 'GOVERNOR_STALLED');
    assert.equal(result.error?.code, 'GOVERNOR_STALLED');
    // Stopped early rather than burning through the role's iteration cap.
    assert.ok(result.iterations < 6, `ran ${String(result.iterations)} iterations before halting`);
  } finally {
    await tools.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
