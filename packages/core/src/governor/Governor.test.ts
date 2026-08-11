import test from 'node:test';
import assert from 'node:assert/strict';
import { Governor, createGovernor } from './Governor.ts';
import type { ModelCallRequest, ToolCallRequest } from './types.ts';

function modelRequest(overrides: Partial<ModelCallRequest> = {}): ModelCallRequest {
  return {
    runId: 'run-1',
    nodeId: 'node-1',
    roleId: 'researcher',
    iteration: 0,
    depth: 0,
    purpose: 'plan',
    connectionId: 'conn-1',
    model: 'claude-opus-5',
    estimatedInputTokens: 1_000,
    estimatedOutputTokens: 500,
    requiredCapabilities: [],
    ...overrides,
  };
}

function toolRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    runId: 'run-1',
    nodeId: 'node-1',
    roleId: 'researcher',
    iteration: 0,
    depth: 0,
    toolId: 'filesystem.readFile',
    egressTargets: [],
    irreversible: false,
    ...overrides,
  };
}

// The stub's contract is "always authorize". These cases are the ones M3 will
// deny, listed here so the day M3-1 lands, this file is the diff that shows
// exactly which inputs changed answer.
const extremeModelRequests: ModelCallRequest[] = [
  modelRequest(),
  modelRequest({ estimatedInputTokens: 100_000_000, estimatedOutputTokens: 100_000_000 }),
  modelRequest({ depth: 5_000, iteration: 100_000 }),
  modelRequest({ requiredCapabilities: ['toolCalling', 'vision', 'structuredOutput'] }),
  modelRequest({ model: 'a-model-that-does-not-exist' }),
  modelRequest({ estimatedInputTokens: -1, estimatedOutputTokens: -1 }),
];

const extremeToolRequests: ToolCallRequest[] = [
  toolRequest(),
  toolRequest({ toolId: 'shell.exec', irreversible: true }),
  toolRequest({ toolId: 'http.request', egressTargets: ['evil.example.com'] }),
  toolRequest({ depth: 5_000, iteration: 100_000 }),
];

test('the permissive stub authorizes every model call, whatever the request says', () => {
  const governor = createGovernor();
  for (const request of extremeModelRequests) {
    const result = governor.authorizeModelCall(request);
    assert.equal(result.decision, 'allow', `denied: ${JSON.stringify(request)}`);
  }
});

test('the permissive stub authorizes every tool call, whatever the request says', () => {
  const governor = createGovernor();
  for (const request of extremeToolRequests) {
    const result = governor.authorizeToolCall(request);
    assert.equal(result.decision, 'allow', `denied: ${JSON.stringify(request)}`);
  }
});

test('an authorization carries the request the caller must dispatch, not a bare yes', () => {
  // M3 may return a *modified* request — downgrading to a cheaper model under
  // `budget.onExceed: degrade_to_cheaper_model`. Callers dispatch
  // `result.request`, so a caller written against the stub keeps working when
  // the Governor starts rewriting requests. If this shape were a boolean,
  // every call site would have to change in M3.
  const governor = createGovernor();
  const request = modelRequest();
  const result = governor.authorizeModelCall(request);

  assert.equal(result.decision, 'allow');
  if (result.decision !== 'allow') return;
  assert.deepEqual(result.request, request);
});

test('an authorization says it was not really checked', () => {
  // A trace reader looking at an approved call has to be able to tell "checked
  // and permitted" from "not checked". Without this, a permissive build's
  // audit trail is indistinguishable from an enforcing one's.
  const governor = createGovernor();
  const result = governor.authorizeModelCall(modelRequest());

  assert.equal(result.decision, 'allow');
  if (result.decision !== 'allow') return;
  assert.ok(
    result.notes.some((note) => note.includes('permissive')),
    `notes did not disclose the permissive stub: ${JSON.stringify(result.notes)}`,
  );
  assert.equal(governor.mode, 'permissive');
});

test('enforcing mode is a different object, not a different answer from the same checks', () => {
  // M2-1 shipped this file with `enforcing` throwing GOVERNOR_NOT_IMPLEMENTED,
  // because a mode that silently passed everything through would have been the
  // worst possible failure of this interface. M3-1 implements it: an enforcing
  // Governor with no policy has nothing to enforce and authorises, and one with
  // a policy denies. The permissive stub's behaviour above is unchanged, which
  // is the promise M2-1 made.
  const unconstrained = new Governor('enforcing');
  assert.equal(unconstrained.authorizeModelCall(modelRequest()).decision, 'allow');

  const constrained = new Governor('enforcing', {
    budget: { run: { maxTokens: 10, maxCostUsd: null } },
  });
  assert.equal(constrained.authorizeModelCall(modelRequest()).decision, 'deny');
});
