import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderAuthError, ProviderError, ProviderRateLimitError } from '@chimera/errors';
import type { AuthRef } from '@chimera/store';
import { AnthropicAdapter } from './anthropic.ts';
import { OpenAiAdapter } from './openai.ts';
import { GoogleAdapter } from './google.ts';
import { errorForStatus, providerMessage } from './http.ts';
import type { AdapterDependencies } from './http.ts';
import type { ProviderAdapter } from '../adapter.ts';
import type { NormalisedRequest, StreamEvent } from '../normalised.ts';

// No network, ever (CLAUDE.md: "never hit a real API in CI"). Every test drives
// a fixture response through an injected fetch, so these run identically on a
// laptop, on a CI runner with no keychain, and offline.

const AUTH = 'vault:connection:11111111-2222-3333-4444-555555555555' as AuthRef;
const OPTIONS = { authRef: AUTH };
const SECRET = 'sk-test-secret-value-must-never-leak';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that returns one JSON body and records what it was called with. */
function jsonFetch(payload: unknown, captured: Captured[] = []): AdapterDependencies {
  return {
    resolveSecret: () => SECRET,
    transport: {
      fetch: ((url: string, init: RequestInit) => {
        captured.push({
          url,
          headers: init.headers as Record<string, string>,
          body: JSON.parse(init.body as string) as Record<string, unknown>,
        });
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as unknown as typeof globalThis.fetch,
    },
  };
}

function errorFetch(status: number, body = '{"error":"nope"}', headers = {}): AdapterDependencies {
  return {
    resolveSecret: () => SECRET,
    transport: {
      fetch: (() =>
        Promise.resolve(
          new Response(body, { status, headers }),
        )) as unknown as typeof globalThis.fetch,
    },
  };
}

/** A fetch that streams the given SSE text, split at arbitrary byte offsets. */
function sseFetch(sse: string, chunkSize = 7): AdapterDependencies {
  return {
    resolveSecret: () => SECRET,
    transport: {
      fetch: (() => {
        const bytes = new TextEncoder().encode(sse);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Deliberately split mid-line: a parser that assumed one chunk is
            // one event would pass a naive fixture and drop data on a real
            // network under load.
            for (let at = 0; at < bytes.length; at += chunkSize) {
              controller.enqueue(bytes.slice(at, at + chunkSize));
            }
            controller.close();
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }) as unknown as typeof globalThis.fetch,
    },
  };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const CONVERSATION: NormalisedRequest = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'call the tool' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { q: 'x' } }],
    },
    { role: 'tool', toolCallId: 'call_1', content: 'the answer' },
  ],
  tools: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object' } }],
  maxOutputTokens: 100,
};

test('all three adapters satisfy ProviderAdapter', () => {
  const adapters: ProviderAdapter[] = [
    new AnthropicAdapter(),
    new OpenAiAdapter(),
    new GoogleAdapter(),
  ];
  assert.equal(adapters.length, 3);
  assert.deepEqual(
    adapters.map((a) => a.kind),
    ['anthropic', 'openai', 'google'],
  );
});

// ---------------------------------------------------------------- Anthropic

test('Anthropic: system turns are hoisted, tool results become user tool_result blocks', async () => {
  const captured: Captured[] = [];
  const adapter = new AnthropicAdapter(
    jsonFetch(
      {
        id: 'msg_1',
        model: 'test-model',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 3 },
      },
      captured,
    ),
  );

  await adapter.chat(CONVERSATION, OPTIONS);
  const body = captured[0]?.body;

  // Anthropic has no system role — it must be a top-level string.
  assert.equal(body?.['system'], 'You are terse.');
  const messages = body?.['messages'] as Array<{ role: string; content: unknown[] }>;
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user'],
  );
  // The tool result rides in a *user* turn, which is where Anthropic wants it.
  assert.equal((messages[2]?.content[0] as { type: string }).type, 'tool_result');
  // Assistant tool calls become tool_use blocks.
  assert.equal((messages[1]?.content[0] as { type: string }).type, 'tool_use');
  // Tool schema field is input_schema, not parameters.
  assert.ok((body?.['tools'] as Array<Record<string, unknown>>)[0]?.['input_schema']);
  assert.equal(captured[0]?.headers['anthropic-version'], '2023-06-01');
  assert.equal(captured[0]?.headers['x-api-key'], SECRET);
});

test('Anthropic: a tool_use response normalises to toolCalls with parsed arguments', async () => {
  const adapter = new AnthropicAdapter(
    jsonFetch({
      id: 'msg_2',
      model: 'test-model',
      content: [
        { type: 'text', text: 'thinking' },
        { type: 'tool_use', id: 'tu_1', name: 'send', input: { to: 'a@b.c' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2 },
    }),
  );

  const response = await adapter.chat(CONVERSATION, OPTIONS);
  assert.equal(response.finishReason, 'toolCalls');
  assert.deepEqual(response.toolCalls, [{ id: 'tu_1', name: 'send', arguments: { to: 'a@b.c' } }]);
  assert.equal(response.content[0]?.type, 'text');
  assert.deepEqual(response.usage, { inputTokens: 5, outputTokens: 7, cachedInputTokens: 2 });
});

test('Anthropic: max_tokens stop_reason maps to length, refusal maps to contentFilter', async () => {
  for (const [stopReason, expected] of [
    ['max_tokens', 'length'],
    ['refusal', 'contentFilter'],
    ['end_turn', 'stop'],
  ] as const) {
    const adapter = new AnthropicAdapter(
      jsonFetch({
        id: 'm',
        model: 'test-model',
        content: [],
        stop_reason: stopReason,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const response = await adapter.chat(CONVERSATION, OPTIONS);
    assert.equal(response.finishReason, expected, `${stopReason} should map to ${expected}`);
  }
});

test('Anthropic: streaming assembles text deltas and usage from both ends of the stream', async () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_s","model":"test-model","content":[],"stop_reason":null,"usage":{"input_tokens":9,"output_tokens":0}}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
    '',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
    '',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  const events = await collect(
    new AnthropicAdapter(sseFetch(sse)).streamChat(CONVERSATION, OPTIONS),
  );

  assert.equal(events[0]?.type, 'start');
  assert.equal(events.at(-1)?.type, 'finish');
  const text = events
    .filter((e): e is Extract<StreamEvent, { type: 'textDelta' }> => e.type === 'textDelta')
    .map((e) => e.text)
    .join('');
  assert.equal(text, 'Hello');

  const finish = events.at(-1);
  assert.ok(finish?.type === 'finish');
  // Input tokens arrive on message_start, output tokens on message_delta —
  // a finish event that took only one of them would under-report every run.
  assert.deepEqual(finish.usage, { inputTokens: 9, outputTokens: 4 });
});

test('Anthropic: streamed tool calls emit a start delta and accumulated argument fragments', async () => {
  const sse = [
    'data: {"type":"message_start","message":{"id":"m","model":"test-model","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    '',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_9","name":"send","input":{}}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"to\\":"}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a\\"}"}}',
    '',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}',
    '',
  ].join('\n');

  const events = await collect(
    new AnthropicAdapter(sseFetch(sse)).streamChat(CONVERSATION, OPTIONS),
  );
  const deltas = events.filter(
    (e): e is Extract<StreamEvent, { type: 'toolCallDelta' }> => e.type === 'toolCallDelta',
  );
  assert.equal(deltas[0]?.name, 'send');
  assert.equal(deltas.map((d) => d.argumentsDelta ?? '').join(''), '{"to":"a"}');
  const finish = events.at(-1);
  assert.ok(finish?.type === 'finish');
  assert.equal(finish.finishReason, 'toolCalls');
});

// ------------------------------------------------------------------- OpenAI

test('OpenAI: messages map straight through and tool calls serialise arguments as a string', async () => {
  const captured: Captured[] = [];
  const adapter = new OpenAiAdapter(
    jsonFetch(
      {
        id: 'chatcmpl-1',
        model: 'test-model',
        choices: [{ index: 0, message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      },
      captured,
    ),
  );

  await adapter.chat(CONVERSATION, OPTIONS);
  const body = captured[0]?.body;
  const messages = body?.['messages'] as Array<Record<string, unknown>>;

  assert.deepEqual(
    messages.map((m) => m['role']),
    ['system', 'user', 'assistant', 'tool'],
  );
  // Arguments cross OpenAI's wire as a JSON string, not an object.
  const toolCalls = messages[2]?.['tool_calls'] as Array<{ function: { arguments: string } }>;
  assert.equal(typeof toolCalls[0]?.function.arguments, 'string');
  assert.deepEqual(JSON.parse(toolCalls[0]?.function.arguments ?? ''), { q: 'x' });
  assert.equal(messages[3]?.['tool_call_id'], 'call_1');

  // max_completion_tokens, not the deprecated max_tokens.
  assert.equal(body?.['max_completion_tokens'], 100);
  assert.equal(body?.['max_tokens'], undefined);
  assert.equal(captured[0]?.headers['authorization'], `Bearer ${SECRET}`);
});

test('OpenAI: malformed tool arguments degrade to raw text rather than losing the response', async () => {
  const adapter = new OpenAiAdapter(
    jsonFetch({
      id: 'c',
      model: 'test-model',
      choices: [
        {
          index: 0,
          message: {
            content: null,
            tool_calls: [
              { id: 't1', type: 'function', function: { name: 'send', arguments: '{not json' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  );

  const response = await adapter.chat(CONVERSATION, OPTIONS);
  // The whole response is still usable and the raw blob is preserved for the
  // caller to log — throwing here would discard a response the model paid for.
  assert.equal(response.toolCalls[0]?.name, 'send');
  assert.deepEqual(response.toolCalls[0]?.arguments, { _raw: '{not json' });
});

test('OpenAI: streaming accumulates deltas and reads usage from the final chunk', async () => {
  const sse = [
    'data: {"id":"c1","model":"test-model","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
    '',
    'data: {"id":"c1","model":"test-model","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
    '',
    'data: {"id":"c1","model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":2}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const events = await collect(new OpenAiAdapter(sseFetch(sse)).streamChat(CONVERSATION, OPTIONS));
  assert.equal(events[0]?.type, 'start');
  const finish = events.at(-1);
  assert.ok(finish?.type === 'finish');
  assert.equal(finish.finishReason, 'stop');
  assert.deepEqual(finish.usage, { inputTokens: 6, outputTokens: 2 });
  assert.equal(
    events
      .filter((e): e is Extract<StreamEvent, { type: 'textDelta' }> => e.type === 'textDelta')
      .map((e) => e.text)
      .join(''),
    'Hello',
  );
});

test('OpenAI: a streamed request asks for usage, which is otherwise omitted entirely', async () => {
  const captured: Captured[] = [];
  const deps = sseFetch('data: [DONE]\n\n');
  const spied: typeof deps = {
    resolveSecret: deps.resolveSecret,
    transport: {
      fetch: ((url: string, init: RequestInit) => {
        captured.push({
          url,
          headers: init.headers as Record<string, string>,
          body: JSON.parse(init.body as string) as Record<string, unknown>,
        });
        return deps.transport.fetch(url, init);
      }) as unknown as typeof globalThis.fetch,
    },
  };

  await assert.rejects(
    async () => collect(new OpenAiAdapter(spied).streamChat(CONVERSATION, OPTIONS)),
    ProviderError,
  );
  assert.deepEqual(captured[0]?.body['stream_options'], { include_usage: true });
});

// ------------------------------------------------------------------- Google

test('Google: the model is in the path, the key is a query parameter, and roles become user/model', async () => {
  const captured: Captured[] = [];
  const adapter = new GoogleAdapter(
    jsonFetch(
      {
        candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
        responseId: 'r1',
        modelVersion: 'gemini-2.5-flash',
      },
      captured,
    ),
  );

  await adapter.chat(CONVERSATION, OPTIONS);
  assert.match(captured[0]?.url ?? '', /\/models\/test-model:generateContent\?key=/);
  const body = captured[0]?.body;

  // Gemini has no system role — it is a separate top-level object.
  assert.ok(body?.['systemInstruction']);
  const contents = body?.['contents'] as Array<{ role: string; parts: unknown[] }>;
  // Only user and model exist, and same-role turns merge — the API rejects a
  // contents array that repeats a role.
  assert.ok(contents.every((c) => c.role === 'user' || c.role === 'model'));
  for (const [index, entry] of contents.entries()) {
    if (index > 0) assert.notEqual(entry.role, contents[index - 1]?.role);
  }
  assert.ok((body?.['tools'] as Array<Record<string, unknown>>)[0]?.['functionDeclarations']);
});

test('Google: a functionCall part normalises to a tool call with a synthesised id', async () => {
  const adapter = new GoogleAdapter(
    jsonFetch({
      candidates: [
        {
          content: { parts: [{ functionCall: { name: 'send', args: { to: 'a' } } }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
    }),
  );

  const response = await adapter.chat(CONVERSATION, OPTIONS);
  assert.equal(response.finishReason, 'toolCalls');
  assert.equal(response.toolCalls[0]?.name, 'send');
  assert.deepEqual(response.toolCalls[0]?.arguments, { to: 'a' });
  // Gemini assigns no call id, so one is synthesised — but it must be present,
  // because tool results are correlated by it everywhere above this layer.
  assert.ok((response.toolCalls[0]?.id ?? '').length > 0);
});

test('Google: SAFETY finish reason maps to contentFilter', async () => {
  const adapter = new GoogleAdapter(
    jsonFetch({
      candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 },
    }),
  );
  const response = await adapter.chat(CONVERSATION, OPTIONS);
  assert.equal(response.finishReason, 'contentFilter');
});

test('Google: streaming yields text deltas and a finish with usage', async () => {
  const sse = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}],"responseId":"r","modelVersion":"gemini-2.5-flash"}',
    '',
    'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}',
    '',
  ].join('\n');

  const events = await collect(new GoogleAdapter(sseFetch(sse)).streamChat(CONVERSATION, OPTIONS));
  assert.equal(events[0]?.type, 'start');
  assert.equal(
    events
      .filter((e): e is Extract<StreamEvent, { type: 'textDelta' }> => e.type === 'textDelta')
      .map((e) => e.text)
      .join(''),
    'Hello',
  );
  const finish = events.at(-1);
  assert.ok(finish?.type === 'finish');
  assert.deepEqual(finish.usage, { inputTokens: 5, outputTokens: 2 });
});

// -------------------------------------------------- error mapping, all three

const ADAPTERS: ReadonlyArray<[string, (deps: AdapterDependencies) => ProviderAdapter]> = [
  ['Anthropic', (deps) => new AnthropicAdapter(deps)],
  ['OpenAI', (deps) => new OpenAiAdapter(deps)],
  ['Google', (deps) => new GoogleAdapter(deps)],
];

test('every adapter maps 401 to ProviderAuthError', async () => {
  for (const [name, build] of ADAPTERS) {
    await assert.rejects(
      () => build(errorFetch(401)).chat(CONVERSATION, OPTIONS),
      ProviderAuthError,
      `${name} should raise ProviderAuthError on 401`,
    );
  }
});

test('every adapter maps 429 to ProviderRateLimitError and carries Retry-After', async () => {
  for (const [name, build] of ADAPTERS) {
    try {
      await build(errorFetch(429, 'slow down', { 'retry-after': '30' })).chat(
        CONVERSATION,
        OPTIONS,
      );
      assert.fail(`${name} should have rejected`);
    } catch (err) {
      assert.ok(err instanceof ProviderRateLimitError, `${name}: wrong error class`);
      assert.equal(err.details['retryAfterMs'], 30_000, `${name}: Retry-After not converted`);
    }
  }
});

test('every adapter maps 500 to a typed ProviderError, never a raw throw', async () => {
  for (const [name, build] of ADAPTERS) {
    try {
      await build(errorFetch(500, 'boom')).chat(CONVERSATION, OPTIONS);
      assert.fail(`${name} should have rejected`);
    } catch (err) {
      assert.ok(err instanceof ProviderError, `${name}: wrong error class`);
      assert.equal(err.code, 'PROVIDER_SERVER_ERROR');
    }
  }
});

test('every adapter turns a malformed body into PROVIDER_INVALID_RESPONSE', async () => {
  for (const [name, build] of ADAPTERS) {
    const deps: AdapterDependencies = {
      resolveSecret: () => SECRET,
      transport: {
        fetch: (() =>
          Promise.resolve(
            new Response('not json at all', { status: 200 }),
          )) as unknown as typeof globalThis.fetch,
      },
    };
    try {
      await build(deps).chat(CONVERSATION, OPTIONS);
      assert.fail(`${name} should have rejected`);
    } catch (err) {
      assert.ok(err instanceof ProviderError, `${name}: wrong error class`);
      assert.equal(err.code, 'PROVIDER_INVALID_RESPONSE');
    }
  }
});

test('every adapter turns an unreachable host into PROVIDER_UNREACHABLE, not a raw TypeError', async () => {
  for (const [name, build] of ADAPTERS) {
    const deps: AdapterDependencies = {
      resolveSecret: () => SECRET,
      transport: {
        fetch: (() =>
          Promise.reject(new TypeError('fetch failed'))) as unknown as typeof globalThis.fetch,
      },
    };
    try {
      await build(deps).chat(CONVERSATION, OPTIONS);
      assert.fail(`${name} should have rejected`);
    } catch (err) {
      assert.ok(err instanceof ProviderError, `${name}: a raw TypeError escaped`);
      assert.equal(err.code, 'PROVIDER_UNREACHABLE');
    }
  }
});

test('no error from any adapter contains the credential', async () => {
  for (const [name, build] of ADAPTERS) {
    for (const status of [401, 429, 500, 400]) {
      try {
        // The body echoes the secret, simulating a provider that reflects the
        // request back in its error — the worst realistic case.
        await build(errorFetch(status, `bad request with ${SECRET} inside`)).chat(
          CONVERSATION,
          OPTIONS,
        );
      } catch (err) {
        const serialised = JSON.stringify(
          err instanceof ProviderError ? err.toWireFormat() : { message: String(err) },
        );
        assert.ok(
          !serialised.includes(SECRET),
          `${name} leaked the credential in a ${String(status)} error: ${serialised}`,
        );
      }
    }
  }
});

test('a missing vault entry fails cleanly rather than sending an empty credential', async () => {
  for (const [name, build] of ADAPTERS) {
    const deps: AdapterDependencies = {
      resolveSecret: () => undefined,
      transport: {
        fetch: (() => {
          throw new Error('must not be called');
        }) as unknown as typeof globalThis.fetch,
      },
    };
    await assert.rejects(
      () => build(deps).chat(CONVERSATION, OPTIONS),
      ProviderError,
      `${name} should refuse to call with no credential`,
    );
  }
});

test('testConnection reports failure rather than throwing', async () => {
  for (const [name, build] of ADAPTERS) {
    const result = await build(errorFetch(401)).testConnection(OPTIONS);
    assert.equal(result.ok, false, `${name} should report ok:false`);
    assert.ok(!(result.detail ?? '').includes(SECRET), `${name} leaked the key into detail`);
  }
});

// What a person actually reads when a call is refused.
//
// Both of these came from one live run on a real Ollama Cloud key: the
// catalogue offered nineteen models, six of them ran, and picking one of the
// other thirteen printed the gateway's JSON envelope on screen.

test('a provider error is unwrapped to the sentence inside it', () => {
  assert.equal(
    providerMessage('{"error":{"message":"model not found","type":"api_error","param":null}}'),
    'model not found',
  );
  // The other two envelopes in circulation.
  assert.equal(providerMessage('{"error":"no such model"}'), 'no such model');
  assert.equal(providerMessage('{"message":"context length exceeded"}'), 'context length exceeded');
  // Not JSON at all, or JSON with nothing to unwrap: keep it rather than
  // replacing a hard-to-read message with no message.
  assert.equal(providerMessage('502 Bad Gateway'), '502 Bad Gateway');
  assert.equal(providerMessage('{"detail":{"code":7}}'), '{"detail":{"code":7}}');
  assert.equal(providerMessage('   '), '');
});

test('a model the plan does not cover is its own error, not a bad request', () => {
  const body = JSON.stringify({
    error: {
      message: 'this model requires a subscription, upgrade for access: https://ollama.com/upgrade',
      type: 'api_error',
    },
  });
  const err = errorForStatus('Ollama Cloud', 400, new Headers(), body);

  assert.ok(err instanceof ProviderError);
  assert.equal(err.code, 'PROVIDER_MODEL_UNAVAILABLE');
  // It says what to do, and it does not say it in brackets.
  assert.match(err.message, /Pick a different model for this step/);
  assert.equal(err.message.includes('"type"'), false);
});

test('an ordinary rejection still carries the provider’s reason', () => {
  const err = errorForStatus(
    'Ollama Cloud',
    400,
    new Headers(),
    '{"error":{"message":"max_tokens is too large"}}',
  );
  assert.equal((err as ProviderError).code, 'PROVIDER_INVALID_REQUEST');
  assert.match(err.message, /max_tokens is too large/);
  assert.equal(err.message.includes('{'), false);
});
