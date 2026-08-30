import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GovernorLimitError, ProviderError, ValidationError } from '@chimera/errors';
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
import {
  parseVerification,
  runAgentLoop,
  type Cancellation,
  failureCounts,
  groundedInObservations,
  identifiersIn,
} from './agentLoop.ts';

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
          // The answering turn. Everything the step has said so far was said
          // before its tool ran, so it has not yet reported anything — see
          // `outputIsStale`. This is the turn where it does.
          { kind: 'text', content: 'Wrote hello.txt; it contains "hello".' },
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
    assert.equal(result.iterations, 2);
    assert.deepEqual(
      result.steps.map((step) => step.purpose),
      ['plan', 'act', 'verify', 'act'],
    );
    // And what it hands on is the report, not the plan it opened with.
    assert.match(result.output, /contains "hello"/);

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
    // the loop makes them. Four model calls reached the provider and four
    // authorizations preceded them.
    assert.deepEqual(governor.events, [
      'authorizeModelCall:plan',
      'authorizeModelCall:act',
      'authorizeToolCall:filesystem.writeFile',
      'authorizeModelCall:verify',
      // The answering turn, and the point of listing it: it is a model call
      // like any other and it goes through the Governor like any other. A new
      // call added to this loop that did not appear here would be the bypass
      // CLAUDE.md's first hard rule forbids.
      'authorizeModelCall:act',
    ]);
    assert.equal(provider.calls, 4);
    assert.equal(
      governor.events.filter((event) => event.startsWith('authorizeModelCall')).length,
      provider.calls,
      'a model call reached the provider without an authorization in front of it',
    );
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

test('a dropped connection is retried; the work is not thrown away', async () => {
  // Under a fan-out's load a reset socket is an ordinary event, and failing an
  // item over one throws away work the next attempt would have completed. An
  // auth failure is the opposite — asking again cannot fix it — which is why
  // this retries on PROVIDER_UNREACHABLE and not on everything.
  const h = await harness();
  let attempts = 0;

  const flaky: ProviderAdapter = {
    kind: 'openai-compatible',
    chat(): Promise<never> {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(
          new ProviderError('PROVIDER_UNREACHABLE', 'Could not reach OmniRoute: fetch failed', {
            provider: 'omniroute',
          }),
        );
      }
      return Promise.resolve({
        content: [{ type: 'text', text: 'Done: it worked on the second attempt.' }],
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
        model: 'mock-frontier',
      }) as never;
    },
  } as unknown as ProviderAdapter;

  try {
    const result = await runAgentLoop(taskFor(STARTER_ROLES[7] as Role), {
      governor: new Governor('permissive'),
      provider: flaky,
      tools: h.tools,
      callOptions: CALL_OPTIONS,
    });

    assert.ok(attempts >= 2, 'the transport failure was not retried');
    // What matters here is that the dropped connection did not end the step.
    // Where the loop goes afterwards is the rest of this file's business — this
    // fake never answers the verification question, so it runs out of
    // iterations rather than finishing, and that is fine.
    assert.notEqual(result.status, 'failed');
    assert.match(result.output, /second attempt/);
  } finally {
    await h.cleanup();
  }
});

test('a tool the model invented is answered, not treated as a dangerous one', async () => {
  // Found against a real model on the first live run: it called
  // "filesystem.findData", which does not exist. The reversibility rule treats
  // an unknown tool as irreversible by construction, so the Governor refused
  // it and the whole run halted "needs a human approval" — over a name the
  // model made up. The right answer is to tell it the tool is not there.
  const h = await harness();
  const provider = new MockProvider({
    script: {
      queue: [
        { kind: 'text', content: 'Plan: look it up.' },
        {
          kind: 'toolCall',
          toolId: 'filesystem__findData',
          toolName: 'filesystem__findData',
          params: { query: 'purchase orders' },
        },
        VERIFIED,
      ],
    },
  });

  try {
    const result = await runAgentLoop(taskFor(), {
      governor: new Governor('enforcing'),
      provider,
      tools: h.tools,
      callOptions: CALL_OPTIONS,
    });

    // The run carried on rather than halting.
    assert.notEqual(result.status, 'denied');
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0]?.isError, true);
    assert.match(result.observations[0]?.output ?? '', /no tool called "filesystem\.findData"/);
    // And it is told what it *can* call, so the next turn can be right.
    assert.match(result.observations[0]?.output ?? '', /filesystem\.readFile/);
  } finally {
    await h.cleanup();
  }
});

// A step that finished during planning.
//
// Measured live, with gpt-oss:120b on a hosted gateway: the data extractor put
// the complete, correct record set in its planning turn, had nothing to add in
// its acting turn, and the model returned empty content with no tool calls.
// Recorded as an assistant turn, that emptiness became the last thing in the
// history — so the verifier, asked whether the answer above was any good, was
// looking at nothing, answered false, and sent the step rummaging through an
// empty workspace until it exhausted its iterations.

test('an acting turn that adds nothing is not recorded as the answer', async () => {
  const h = await harness();
  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: '{"records":[{"title":"a","points":1}]}' },
          // Nothing to say, nothing to call: the model has already finished.
          { kind: 'text', content: '' },
          VERIFIED,
        ],
      },
    }),
  );

  try {
    const result = await runAgentLoop(taskFor(), {
      governor: new RecordingGovernor(),
      provider,
      tools: h.tools,
      callOptions: CALL_OPTIONS,
    });

    assert.equal(result.status, 'succeeded');
    // The planning turn's answer survived rather than being buried.
    assert.match(result.output, /"records"/);

    // And the verifier was not shown an empty assistant turn to judge.
    const verifyRequest = provider.requests.at(-1);
    const assistantTurns = (verifyRequest?.messages ?? []).filter(
      (message) => message.role === 'assistant',
    );
    assert.ok(assistantTurns.length > 0, 'the verifier should see the answer');
    assert.equal(
      assistantTurns.some((message) => message.content === ''),
      false,
      'an empty assistant turn reached the verifier',
    );
  } finally {
    await h.cleanup();
  }
});

test('a step with no tools is not asked to prove itself with tools', async () => {
  const h = await harness();
  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'The summary.' },
          { kind: 'text', content: 'The summary, finished.' },
          VERIFIED,
        ],
      },
    }),
  );

  try {
    await runAgentLoop(taskFor(), {
      governor: new RecordingGovernor(),
      provider,
      tools: h.tools,
      callOptions: CALL_OPTIONS,
    });

    const instruction = (provider.requests.at(-1)?.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n');

    // The instruction that made this impossible to satisfy, and its successor.
    assert.equal(instruction.includes('Cite what the tools returned'), false);
    assert.match(instruction, /never because it did not come from a tool/);
  } finally {
    await h.cleanup();
  }
});

test('a step with work after it is told to grade itself, not the automation', async () => {
  const h = await harness();
  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'Step one, then step two.' },
          { kind: 'text', content: 'The plan, written out.' },
          VERIFIED,
        ],
      },
    }),
  );

  try {
    await runAgentLoop(
      {
        ...taskFor(),
        placement: {
          automation: 'Rate check',
          goal: 'What is the base rate?',
          position: 1,
          total: 3,
          upstream: [],
          downstream: ['Researcher', 'Summariser'],
        },
      },
      {
        governor: new RecordingGovernor(),
        provider,
        tools: h.tools,
        callOptions: CALL_OPTIONS,
      },
    );

    const instruction = (provider.requests.at(-1)?.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n');

    assert.match(instruction, /checking this step only, not the automation/);
    assert.match(instruction, /Researcher, Summariser/);
  } finally {
    await h.cleanup();
  }
});

test('the last step is not told that somebody else will finish the job', async () => {
  const h = await harness();
  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'The answer.' },
          { kind: 'text', content: 'The finished answer.' },
          VERIFIED,
        ],
      },
    }),
  );

  try {
    await runAgentLoop(
      {
        ...taskFor(),
        placement: {
          automation: 'Rate check',
          goal: 'What is the base rate?',
          position: 3,
          total: 3,
          upstream: ['Researcher'],
          downstream: [],
        },
      },
      {
        governor: new RecordingGovernor(),
        provider,
        tools: h.tools,
        callOptions: CALL_OPTIONS,
      },
    );

    const instruction = (provider.requests.at(-1)?.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n');

    assert.equal(instruction.includes('checking this step only'), false);
  } finally {
    await h.cleanup();
  }
});

// A schema is a check; a model's opinion of whether the work is done is not.
//
// The planner produced a complete, valid plan on its first turn and its
// verifier answered "the steps were only listed and no actual data was
// retrieved" — grading it on whether the plan had been carried out, which is
// the next agent's job. It exhausted every run, having been right every time.

test('a step whose answer meets its schema is verified without asking a model', async () => {
  const h = await harness();
  const planner = STARTER_ROLES.find((role) => role.id === 'planner');
  assert.ok(planner, 'the planner starter role is missing');

  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          {
            kind: 'text',
            content: '{"steps":[{"action":"Read the page","check":"The rate is on it"}]}',
          },
          // Nothing to add, and no verify turn is scripted — reaching one would
          // run off the end of the queue.
          { kind: 'text', content: '' },
        ],
      },
    }),
  );

  try {
    const result = await runAgentLoop(
      { ...taskFor(), role: planner },
      {
        governor: new RecordingGovernor(),
        provider,
        tools: h.tools,
        callOptions: CALL_OPTIONS,
      },
    );

    assert.equal(result.status, 'succeeded');
    assert.equal(result.verification?.verified, true);
    // plan and act only. No verify call was made, and none was paid for.
    assert.deepEqual(
      result.steps.map((step) => step.purpose),
      ['plan', 'act'],
    );
  } finally {
    await h.cleanup();
  }
});

test('a step whose answer does not meet its schema is still put to a model', async () => {
  const h = await harness();
  const planner = STARTER_ROLES.find((role) => role.id === 'planner');
  assert.ok(planner, 'the planner starter role is missing');

  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'I will read the page and look for the rate.' },
          { kind: 'text', content: 'Still thinking about it.' },
          VERIFIED,
          // The repair turn the contract asks for once the model says verified.
          { kind: 'text', content: '{"steps":[{"action":"Read it","check":"It is there"}]}' },
        ],
      },
    }),
  );

  try {
    const result = await runAgentLoop(
      { ...taskFor(), role: planner },
      {
        governor: new RecordingGovernor(),
        provider,
        tools: h.tools,
        callOptions: CALL_OPTIONS,
      },
    );

    assert.equal(result.status, 'succeeded');
    assert.ok(
      result.steps.some((step) => step.purpose === 'verify'),
      'prose that does not meet the schema should still be verified',
    );
  } finally {
    await h.cleanup();
  }
});

test('a step never succeeds with nothing to show for it', async () => {
  const h = await harness();
  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          // Every turn calls a tool and says nothing, so there is no answer —
          // and then the verifier agrees the work is done. Left alone, the step
          // returns success and an empty string, and the person is handed a
          // blank reply from a run that reported it had finished. Fatal for the
          // assistant, which looks things up and then has to speak.
          {
            kind: 'toolCall',
            toolId: 'filesystem__listDirectory',
            toolName: 'filesystem__listDirectory',
            params: { path: '.' },
          },
          {
            kind: 'toolCall',
            toolId: 'filesystem__listDirectory',
            toolName: 'filesystem__listDirectory',
            params: { path: '.' },
          },
          VERIFIED,
          // The turn it is given to speak.
          { kind: 'text', content: 'The folder is empty.' },
          VERIFIED,
        ],
      },
    }),
  );

  try {
    const result = await runAgentLoop(taskFor(), {
      governor: new RecordingGovernor(),
      provider,
      tools: h.tools,
      callOptions: CALL_OPTIONS,
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.output, 'The folder is empty.');
  } finally {
    await h.cleanup();
  }
});

test('a step that already said something is not made to say it twice', async () => {
  const h = await harness();
  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'Plan: look in the folder.' },
          { kind: 'text', content: 'The folder is empty.' },
          VERIFIED,
        ],
      },
    }),
  );

  try {
    const result = await runAgentLoop(taskFor(), {
      governor: new RecordingGovernor(),
      provider,
      tools: h.tools,
      callOptions: CALL_OPTIONS,
    });

    assert.equal(result.output, 'The folder is empty.');
    // Three calls, not four: the extra turn is only for a step that has said
    // nothing at all, so the ordinary case pays nothing for it.
    assert.equal(provider.calls, 3);
  } finally {
    await h.cleanup();
  }
});

test('a step does not answer with what it said before its tools ran', async () => {
  // Reported from a real run, and it is data loss rather than a wording
  // problem. An App operator fetched somebody's GitHub email with Composio and
  // the next step was handed "I'll fetch your GitHub emails now" — the sentence
  // the model said in the same turn as the call, before any result existed.
  // The emails themselves went nowhere. The next agent, correctly, refused to
  // summarise what it had never been shown.
  //
  // The loop took the last non-empty assistant text as the step's answer, and
  // only noticed when that text was *empty*. A model that says anything at all
  // alongside its call defeats that check, which is every real model.
  const h = await harness();
  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'Plan: read the file.' },
          {
            kind: 'toolCall',
            toolId: 'filesystem__writeFile',
            toolName: 'filesystem__writeFile',
            params: { path: 'hello.txt', content: 'hello' },
            say: 'I will write the file now.',
          },
          VERIFIED,
          // The turn it is now given, with the result in hand.
          { kind: 'text', content: 'Written: hello.txt now contains "hello".' },
        ],
      },
    }),
  );

  try {
    const result = await runAgentLoop(taskFor(), {
      governor: new Governor('permissive'),
      provider,
      tools: h.tools,
      callOptions: CALL_OPTIONS,
    });

    assert.equal(result.status, 'succeeded');
    assert.notEqual(
      result.output.trim(),
      'I will write the file now.',
      'the step answered with its intention rather than its result',
    );
    assert.match(result.output, /contains "hello"/);
  } finally {
    await h.cleanup();
  }
});

test('a step that runs out of turns still says what it found', async () => {
  // The other half of the same fault. A step that exhausts its iterations
  // returned its last utterance and threw away every observation — so a
  // researcher that had read ten pages handed the next step a sentence about
  // what it was going to read next.
  //
  // One extra call, outside the budget and clearly bounded, buys the write-up
  // of work that has already been paid for.
  const h = await harness();
  const role: Role = { ...coder, maxIterations: 1 };
  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'Plan: write the file.' },
          {
            kind: 'toolCall',
            toolId: 'filesystem__writeFile',
            toolName: 'filesystem__writeFile',
            params: { path: 'hello.txt', content: 'hello' },
            say: 'Next I will write the file.',
          },
          NOT_VERIFIED,
          // The last word, after the budget is gone.
          { kind: 'text', content: 'I got as far as writing hello.txt. It holds "hello".' },
        ],
      },
    }),
  );

  try {
    const result = await runAgentLoop(
      { ...taskFor(role), role },
      {
        governor: new Governor('permissive'),
        provider,
        tools: h.tools,
        callOptions: CALL_OPTIONS,
      },
    );

    assert.equal(result.status, 'exhausted');
    assert.match(result.output, /I got as far as/);
    assert.doesNotMatch(result.output, /Next I will write the file/);
  } finally {
    await h.cleanup();
  }
});

test('a plan is an intention too, even when the acting turn says nothing', async () => {
  // The shape a real model actually produced, and the one that survived the
  // first fix. The narration went in the *planning* turn — "I'll fetch the
  // order record now." — and the acting turn was a bare tool call with no text
  // at all. Nothing after that ever overwrote the plan, so the step reported
  // success with a sentence about the future as its findings.
  //
  // Scripted here exactly as it came back from OpenRouter, because the version
  // of this test that put the narration on the acting turn passed against the
  // bug.
  const h = await harness();
  const provider = new CountingProvider(
    new MockProvider({
      script: {
        queue: [
          { kind: 'text', content: 'I will write the file now.' },
          {
            kind: 'toolCall',
            toolId: 'filesystem__writeFile',
            toolName: 'filesystem__writeFile',
            params: { path: 'hello.txt', content: 'hello' },
          },
          VERIFIED,
          { kind: 'text', content: 'Done: hello.txt contains "hello".' },
        ],
      },
    }),
  );

  try {
    const result = await runAgentLoop(taskFor(), {
      governor: new Governor('permissive'),
      provider,
      tools: h.tools,
      callOptions: CALL_OPTIONS,
    });

    assert.equal(result.status, 'succeeded');
    assert.doesNotMatch(
      result.output,
      /I will write the file now/,
      'the step handed on its plan instead of its result',
    );
    assert.match(result.output, /contains "hello"/);
  } finally {
    await h.cleanup();
  }
});

test('failures are counted per tool, and successes are not', () => {
  const counted = failureCounts([
    { callId: '1', toolId: 'search.web', output: 'nope', isError: true },
    { callId: '2', toolId: 'search.web', output: 'nope again', isError: true },
    { callId: '3', toolId: 'search.web', output: 'fine', isError: false },
    { callId: '4', toolId: 'http.request', output: '403', isError: true },
    { callId: '5', toolId: 'filesystem.readFile', output: 'contents', isError: false },
  ]);

  assert.deepEqual(
    [...counted].sort((a, b) => a.toolId.localeCompare(b.toolId)),
    [
      { toolId: 'http.request', failures: 1 },
      { toolId: 'search.web', failures: 2 },
    ],
  );
});

test('an answer that cites none of what the tools returned is not grounded', () => {
  // The live failure, exactly: asked to report the fields of a fetched record,
  // the model invented an eleven-field order for a customer who does not
  // exist, said the values were "copied exactly as they appeared in the
  // response", and checked its own arithmetic to confirm the total.
  const fetched = JSON.stringify({
    partNumber: 'TURBINE-9F4X-QUARTZ',
    status: 'shipped',
    quantity: 47,
    destination: 'Rotterdam',
  });
  const invented =
    'Here are all the fields from the order record, with values copied exactly as they ' +
    'appeared in the response. The order id is ORD-2024-78432 for customer Sarah Chen at ' +
    '742 Evergreen Terrace, Springfield. The three line items total 270.98, which matches ' +
    'the stated total_amount. The record is complete and well-formed.';

  assert.equal(
    groundedInObservations(invented, [
      { callId: '1', toolId: 'http.request', output: fetched, isError: false },
    ]),
    false,
  );
});

test('an answer that quotes what came back is grounded', () => {
  const fetched = 'partNumber: TURBINE-9F4X-QUARTZ, destination: Rotterdam';
  const honest =
    'The order record contains a part number of TURBINE-9F4X-QUARTZ, shipping to Rotterdam. ' +
    'I have copied both exactly as they were returned by the fetch, and there were no other ' +
    'fields present in the response body that I have omitted from this summary.';

  assert.equal(
    groundedInObservations(honest, [
      { callId: '1', toolId: 'http.request', output: fetched, isError: false },
    ]),
    true,
  );
});

test('grounding stays quiet when there is nothing distinctive to cite', () => {
  // Summarising prose is not reporting a record. Nothing here is an identifier,
  // so there is no claim to check and the check must not invent one.
  const prose = 'The weather has been unusually mild for the season across the region.';
  const summary =
    'The article reports that conditions have been milder than is typical for this time of ' +
    'year, across the whole region it covers, and offers no explanation for why that might ' +
    'be so beyond the general trend it mentions in passing.';

  assert.equal(
    groundedInObservations(summary, [
      { callId: '1', toolId: 'http.request', output: prose, isError: false },
    ]),
    true,
  );
});

test('grounding stays quiet on a short answer and when every tool failed', () => {
  const fetched = 'partNumber: TURBINE-9F4X-QUARTZ';
  assert.equal(
    groundedInObservations('Could not read it.', [
      { callId: '1', toolId: 'http.request', output: fetched, isError: false },
    ]),
    true,
  );
  assert.equal(
    groundedInObservations('x'.repeat(400), [
      { callId: '1', toolId: 'http.request', output: fetched, isError: true },
    ]),
    true,
  );
});

test('identifiers are the kind a record carries, not ordinary words', () => {
  const found = identifiersIn('order ORD-2024-78432 shipped to Rotterdam with tracking 1Z999AA10');
  assert.ok(found.includes('ord-2024-78432'));
  assert.ok(found.includes('1z999aa10'));
  // Plain words are not identifiers, however long.
  assert.equal(found.includes('rotterdam'), false);
  assert.equal(found.includes('shipped'), false);
});
