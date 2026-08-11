import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GovernorLimitError, ValidationError } from '@chimera/errors';
import { MockProvider, type MockResponse } from '@chimera/providers';
import type { AdapterCallOptions, NormalisedRequest, ProviderAdapter } from '@chimera/providers';
import {
  connectInProcess,
  createToolRegistry,
  createSandbox,
  createFilesystemServer,
  type ToolRegistry,
} from '@chimera/tools';
import { Governor } from '../governor/Governor.ts';
import { deny } from '../governor/Governor.ts';
import type { ModelCallAuthorization, ToolCallAuthorization } from '../governor/types.ts';
import { STARTER_ROLES, type Role } from './roleRegistry.ts';
import { parseVerification, runAgentLoop, type Cancellation } from './agentLoop.ts';

const AUTH_REF = 'vault:connection:00000000-0000-0000-0000-000000000000' as never;
const CALL_OPTIONS: AdapterCallOptions = { authRef: AUTH_REF };

const coder = STARTER_ROLES.find((role) => role.id === 'coder');
if (!coder) throw new Error('the coder starter role is missing');

/** Counts every call that reaches the provider, so "authorized first" is checkable. */
class CountingProvider implements ProviderAdapter {
  readonly kind = 'openai-compatible' as const;
  calls = 0;
  requests: NormalisedRequest[] = [];

  // Not a parameter property: Node runs this TypeScript by stripping types,
  // and `constructor(private readonly x: T)` is the one syntax that needs real
  // emit. Caught by the tests rather than by tsc — see M0-1's note.
  private readonly inner: MockProvider;

  constructor(inner: MockProvider) {
    this.inner = inner;
  }

  async chat(request: NormalisedRequest, options: AdapterCallOptions) {
    this.calls += 1;
    this.requests.push(request);
    return this.inner.chat(request, options);
  }
  streamChat(request: NormalisedRequest, options: AdapterCallOptions) {
    return this.inner.streamChat(request, options);
  }
  listModels(options: AdapterCallOptions) {
    return this.inner.listModels(options);
  }
  testConnection(options: AdapterCallOptions) {
    return this.inner.testConnection(options);
  }
}

/** Records the order of Governor and dispatch events, which is the thing under test. */
class RecordingGovernor extends Governor {
  readonly events: string[] = [];

  override authorizeModelCall(
    request: Parameters<Governor['authorizeModelCall']>[0],
  ): ModelCallAuthorization {
    this.events.push(`authorizeModelCall:${request.purpose}`);
    return super.authorizeModelCall(request);
  }

  override authorizeToolCall(
    request: Parameters<Governor['authorizeToolCall']>[0],
  ): ToolCallAuthorization {
    this.events.push(`authorizeToolCall:${request.toolId}`);
    return super.authorizeToolCall(request);
  }
}

interface Harness {
  tools: ToolRegistry;
  sandboxRoot: string;
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-loop-'));
  const sandbox = createSandbox(base, 'run-1');
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));
  return {
    tools,
    sandboxRoot: sandbox.root,
    cleanup: async () => {
      await tools.close();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function taskFor(role: Role = coder as Role) {
  return {
    runId: 'run-1',
    nodeId: 'node-1',
    role,
    task: 'Write hello.txt containing the word hello, then confirm it is there.',
    connectionId: 'conn-1',
    model: 'mock-frontier',
  };
}

const VERIFIED: MockResponse = {
  kind: 'text',
  content: '{"verified": true, "evidence": "readFile returned \\"hello\\""}',
};
const NOT_VERIFIED: MockResponse = {
  kind: 'text',
  content: '{"verified": false, "evidence": "the file is still empty"}',
};

test('the loop runs plan, act, observe, verify, decide and exits on verified success', async () => {
  const h = await harness();
  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'Plan: write the file, then read it back.' },
          {
            kind: 'toolCall',
            toolId: 'filesystem__writeFile',
            toolName: 'filesystem__writeFile',
            params: { path: 'hello.txt', content: 'hello' },
          },
          VERIFIED,
        ],
      },
    }),
  );
  const governor = new RecordingGovernor();

  try {
    const result = await runAgentLoop(taskFor(), {
      governor,
      provider,
      tools: h.tools,
      callOptions: CALL_OPTIONS,
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.iterations, 1);
    assert.deepEqual(
      result.steps.map((step) => step.purpose),
      ['plan', 'act', 'verify'],
    );

    // The tool actually ran, and the file it wrote is really there. The loop is
    // not being graded on its own description of what it did.
    assert.equal(fs.readFileSync(path.join(h.sandboxRoot, 'hello.txt'), 'utf8'), 'hello');
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0]?.isError, false);
    assert.equal(result.verification?.verified, true);
  } finally {
    await h.cleanup();
  }
});

test('every model call and every tool call is authorized before it is dispatched', async () => {
  const h = await harness();
  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'Plan.' },
          {
            kind: 'toolCall',
            toolId: 'filesystem__writeFile',
            toolName: 'filesystem__writeFile',
            params: { path: 'a.txt', content: 'a' },
          },
          VERIFIED,
        ],
      },
    }),
  );
  const governor = new RecordingGovernor();

  try {
    await runAgentLoop(taskFor(), {
      governor,
      provider,
      tools: h.tools,
      callOptions: CALL_OPTIONS,
    });

    // One authorization per model call, and one per tool call, in the order
    // the loop makes them. Three model calls reached the provider and three
    // authorizations preceded them.
    assert.deepEqual(governor.events, [
      'authorizeModelCall:plan',
      'authorizeModelCall:act',
      'authorizeToolCall:filesystem.writeFile',
      'authorizeModelCall:verify',
    ]);
    assert.equal(provider.calls, 3);
  } finally {
    await h.cleanup();
  }
});

test('a Governor that denies a model call ends the run cleanly with a typed error', async () => {
  const h = await harness();

  // The denial the M3 budget check will produce. The stub never returns it yet;
  // the exit path has to exist and be correct before it does.
  class DenyingGovernor extends Governor {
    override authorizeModelCall(): ModelCallAuthorization {
      return deny('GOVERNOR_BUDGET_EXCEEDED', 'Run budget of $2.00 is exhausted.', {
        limitUsd: 2,
      });
    }
  }

  const provider = new CountingProvider(new MockProvider({ script: { queue: [VERIFIED] } }));

  try {
    const result = await runAgentLoop(taskFor(), {
      governor: new DenyingGovernor(),
      provider,
      tools: h.tools,
      callOptions: CALL_OPTIONS,
    });

    assert.equal(result.status, 'denied');
    assert.equal(result.denial?.code, 'GOVERNOR_BUDGET_EXCEEDED');
    assert.ok(result.error instanceof GovernorLimitError);
    assert.equal(result.error.code, 'GOVERNOR_BUDGET_EXCEEDED');
    assert.equal(result.error.details.limitUsd, 2);
    // Denied means denied: nothing reached the provider at all.
    assert.equal(provider.calls, 0);
  } finally {
    await h.cleanup();
  }
});

test('a denied tool call ends the run without invoking the tool', async () => {
  const h = await harness();

  class ToolDenyingGovernor extends Governor {
    override authorizeToolCall(): ToolCallAuthorization {
      return deny('GOVERNOR_APPROVAL_REQUIRED', 'This tool needs an approval node upstream.', {});
    }
  }

  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'Plan.' },
          {
            kind: 'toolCall',
            toolId: 'filesystem__writeFile',
            toolName: 'filesystem__writeFile',
            params: { path: 'never.txt', content: 'x' },
          },
        ],
      },
    }),
  );

  try {
    const result = await runAgentLoop(taskFor(), {
      governor: new ToolDenyingGovernor(),
      provider,
      tools: h.tools,
      callOptions: CALL_OPTIONS,
    });

    assert.equal(result.status, 'denied');
    assert.equal(result.denial?.code, 'GOVERNOR_APPROVAL_REQUIRED');
    assert.equal(fs.existsSync(path.join(h.sandboxRoot, 'never.txt')), false);
  } finally {
    await h.cleanup();
  }
});

test('cancellation halts at a step boundary, never mid-tool-call', async () => {
  const h = await harness();
  const cancellation: { cancelled: boolean } = { cancelled: false };

  // Cancelled the moment the first tool has run. The loop must finish that
  // tool — a half-executed side effect is worse than one extra completed step
  // — and then stop before the next model call.
  const watchedTools: ToolRegistry = {
    ...h.tools,
    invoke: async (toolId, params, context) => {
      const result = await h.tools.invoke(toolId, params, context);
      cancellation.cancelled = true;
      return result;
    },
  };

  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'Plan.' },
          {
            kind: 'toolCall',
            toolId: 'filesystem__writeFile',
            toolName: 'filesystem__writeFile',
            params: { path: 'partial.txt', content: 'written' },
          },
          VERIFIED,
        ],
      },
    }),
  );

  try {
    const result = await runAgentLoop(taskFor(), {
      governor: new Governor(),
      provider,
      tools: watchedTools,
      callOptions: CALL_OPTIONS,
      cancellation: cancellation as Cancellation,
    });

    assert.equal(result.status, 'cancelled');
    // The tool that was already running completed and its effect is on disk.
    assert.equal(fs.readFileSync(path.join(h.sandboxRoot, 'partial.txt'), 'utf8'), 'written');
    // And the verify call never happened.
    assert.equal(provider.calls, 2);
    assert.equal(
      result.steps.some((step) => step.purpose === 'verify'),
      false,
    );
  } finally {
    await h.cleanup();
  }
});

test('cancellation before the first call halts immediately', async () => {
  const h = await harness();
  const provider = new CountingProvider(new MockProvider({ script: { queue: [VERIFIED] } }));

  try {
    const result = await runAgentLoop(taskFor(), {
      governor: new Governor(),
      provider,
      tools: h.tools,
      callOptions: CALL_OPTIONS,
      cancellation: { cancelled: true },
    });
    assert.equal(result.status, 'cancelled');
    assert.equal(provider.calls, 0);
  } finally {
    await h.cleanup();
  }
});

test('a loop that never verifies stops at the role iteration cap', async () => {
  const h = await harness();
  const limited: Role = { ...(coder as Role), maxIterations: 3 };

  const provider = new CountingProvider(new MockProvider({ script: { default: NOT_VERIFIED } }));

  try {
    const result = await runAgentLoop(
      { ...taskFor(limited), role: limited },
      { governor: new Governor(), provider, tools: h.tools, callOptions: CALL_OPTIONS },
    );

    // CLAUDE.md: "No unbounded loops." The cap is the role's, and hitting it is
    // an honest "not done" rather than an error.
    assert.equal(result.status, 'exhausted');
    assert.equal(result.iterations, 3);
    assert.equal(result.verification?.verified, false);
    // plan, then act+verify three times.
    assert.equal(provider.calls, 7);
  } finally {
    await h.cleanup();
  }
});

test('a tool the role may not call becomes an observation, not a crash', async () => {
  const h = await harness();
  const researcher = STARTER_ROLES.find((role) => role.id === 'researcher');
  assert.ok(researcher);

  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'Plan.' },
          {
            kind: 'toolCall',
            toolId: 'filesystem__writeFile',
            toolName: 'filesystem__writeFile',
            params: { path: 'nope.txt', content: 'x' },
          },
          VERIFIED,
        ],
      },
    }),
  );

  try {
    const result = await runAgentLoop(
      { ...taskFor(researcher), role: researcher },
      { governor: new Governor(), provider, tools: h.tools, callOptions: CALL_OPTIONS },
    );

    // The researcher may read but not write. The refusal is handed back to the
    // agent as an error observation so it can react, and the run continues.
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0]?.isError, true);
    assert.match(result.observations[0]?.output ?? '', /not allowed to call/);
    assert.equal(fs.existsSync(path.join(h.sandboxRoot, 'nope.txt')), false);
  } finally {
    await h.cleanup();
  }
});

test('the model is only offered the tools its role may call', async () => {
  const h = await harness();
  const researcher = STARTER_ROLES.find((role) => role.id === 'researcher');
  assert.ok(researcher);

  const provider = new CountingProvider(new MockProvider({ script: { default: NOT_VERIFIED } }));

  try {
    await runAgentLoop(
      { ...taskFor(researcher), role: { ...researcher, maxIterations: 1 } },
      { governor: new Governor(), provider, tools: h.tools, callOptions: CALL_OPTIONS },
    );

    const actRequest = provider.requests[1];
    const offered = (actRequest?.tools ?? []).map((tool) => tool.name);
    // Wire names carry no dot: both Anthropic and OpenAI constrain tool names
    // to [a-zA-Z0-9_-], and CHIMERA's ids contain one.
    assert.deepEqual(offered, ['filesystem__readFile', 'filesystem__listDirectory']);
    for (const name of offered) assert.doesNotMatch(name, /\./);
  } finally {
    await h.cleanup();
  }
});

test('verification is read from the verifier, and anything unreadable is not a pass', () => {
  assert.deepEqual(parseVerification('{"verified": true, "evidence": "saw it"}'), {
    verified: true,
    evidence: 'saw it',
  });
  // A verifier that replies with confident prose has not verified anything.
  // Guessing here would let a loop finish because it produced a plausible
  // sentence, which is exactly what a first-class verify step exists to stop.
  assert.equal(parseVerification('Yes, the task is definitely complete.').verified, false);
  assert.equal(parseVerification('{"verified": "yes"}').verified, false);
  assert.equal(parseVerification('{broken json').verified, false);
  assert.equal(parseVerification('').verified, false);
});

test('a role with a JSON output contract gets one repair turn, then a validated value', async () => {
  const h = await harness();
  const planner = STARTER_ROLES.find((role) => role.id === 'planner');
  assert.ok(planner);

  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'Plan.' },
          // The act answer is JSON of the wrong shape: an empty steps array.
          { kind: 'text', content: '{"steps": []}' },
          VERIFIED,
          // The repair turn, carrying the violation, produces a valid plan.
          {
            kind: 'text',
            content: '{"steps": [{"action": "read the file", "check": "it is non-empty"}]}',
          },
        ],
      },
    }),
  );

  try {
    const result = await runAgentLoop(
      { ...taskFor(planner), role: planner },
      { governor: new Governor(), provider, tools: h.tools, callOptions: CALL_OPTIONS },
    );

    assert.equal(result.status, 'succeeded');
    // plan, act, verify, and exactly one repair — not two, not a loop.
    assert.equal(provider.calls, 4);
    assert.deepEqual(
      result.steps.map((step) => step.purpose),
      ['plan', 'act', 'verify', 'decide'],
    );
    assert.deepEqual(result.structuredOutput, {
      steps: [{ action: 'read the file', check: 'it is non-empty' }],
    });
  } finally {
    await h.cleanup();
  }
});

test('a contract the model cannot satisfy fails the run with a ValidationError', async () => {
  const h = await harness();
  const planner = STARTER_ROLES.find((role) => role.id === 'planner');
  assert.ok(planner);

  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'Plan.' },
          { kind: 'text', content: '{"steps": []}' },
          VERIFIED,
        ],
        // Every repair turn also fails.
        default: { kind: 'text', content: '{"steps": []}' },
      },
    }),
  );

  try {
    // Thrown, not returned: unlike a budget denial this is a genuine failure,
    // and handing the caller an answer of the wrong shape would be worse.
    await assert.rejects(
      () =>
        runAgentLoop(
          { ...taskFor(planner), role: planner },
          { governor: new Governor(), provider, tools: h.tools, callOptions: CALL_OPTIONS },
        ),
      (err: unknown) =>
        err instanceof ValidationError && err.code === 'OUTPUT_CONTRACT_UNSATISFIED',
    );
  } finally {
    await h.cleanup();
  }
});
