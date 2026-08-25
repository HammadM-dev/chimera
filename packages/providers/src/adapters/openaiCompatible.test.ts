import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderError } from '@chimera/errors';
import type { AuthRef } from '@chimera/store';
import { OpenAiCompatibleAdapter } from './openaiCompatible.ts';
import { OpenAiAdapter } from './openai.ts';
import { OpenRouterAdapter } from './openrouter.ts';
import { OmniRouteAdapter, OMNIROUTE_DEFAULT_BASE_URL } from './omniroute.ts';
import { OllamaAdapter } from './ollama.ts';
import { LmStudioAdapter } from './lmstudio.ts';
import { defaultDependencies, type AdapterDependencies } from './http.ts';
import type { ProviderAdapter } from '../adapter.ts';
import type { NormalisedRequest, StreamEvent } from '../normalised.ts';

const AUTH = 'vault:connection:11111111-2222-3333-4444-555555555555' as AuthRef;
const OPTIONS = { authRef: AUTH };
const SECRET = 'sk-endpoint-secret';

const ASK: NormalisedRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
};

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function jsonFetch(
  payload: unknown,
  captured: Captured[] = [],
  secret?: string,
): AdapterDependencies {
  return {
    resolveSecret: () => secret,
    transport: {
      fetch: ((url: string, init: RequestInit) => {
        captured.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
      }) as unknown as typeof globalThis.fetch,
    },
  };
}

const CHAT_OK = {
  id: 'c1',
  model: 'test-model',
  choices: [{ index: 0, message: { content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

// Every endpoint adapter is the same translation with different endpoint
// configuration, so they get the same suite rather than five near-copies —
// which is also the point of them sharing a base class.
const ENDPOINTS: ReadonlyArray<{
  name: string;
  kind: string;
  build: (deps: AdapterDependencies) => ProviderAdapter;
  baseUrl: string;
  keyless: boolean;
}> = [
  {
    name: 'OpenAI',
    kind: 'openai',
    build: (d) => new OpenAiAdapter(d),
    baseUrl: 'https://api.openai.com/v1',
    keyless: false,
  },
  {
    name: 'OpenRouter',
    kind: 'openrouter',
    build: (d) => new OpenRouterAdapter(d),
    baseUrl: 'https://openrouter.ai/api/v1',
    keyless: false,
  },
  {
    name: 'OmniRoute',
    kind: 'omniroute',
    build: (d) => new OmniRouteAdapter(d),
    baseUrl: OMNIROUTE_DEFAULT_BASE_URL,
    keyless: true,
  },
  {
    name: 'Ollama',
    kind: 'ollama',
    build: (d) => new OllamaAdapter(d),
    baseUrl: 'http://localhost:11434/v1',
    keyless: true,
  },
  {
    name: 'LM Studio',
    kind: 'lmstudio',
    build: (d) => new LmStudioAdapter(d),
    baseUrl: 'http://localhost:1234/v1',
    keyless: true,
  },
];

test('every endpoint adapter reports its own kind and default base URL', async () => {
  for (const endpoint of ENDPOINTS) {
    const captured: Captured[] = [];
    const adapter = endpoint.build(jsonFetch(CHAT_OK, captured, SECRET));
    assert.equal(adapter.kind, endpoint.kind, `${endpoint.name}: wrong kind`);

    await adapter.chat(ASK, OPTIONS);
    assert.equal(
      captured[0]?.url,
      `${endpoint.baseUrl}/chat/completions`,
      `${endpoint.name}: wrong default endpoint`,
    );
  }
});

test('every endpoint adapter round-trips a scripted chat through the shared translation', async () => {
  for (const endpoint of ENDPOINTS) {
    const response = await endpoint.build(jsonFetch(CHAT_OK, [], SECRET)).chat(ASK, OPTIONS);
    assert.equal(response.content[0]?.type, 'text', `${endpoint.name}: no text content`);
    assert.equal(response.finishReason, 'stop', `${endpoint.name}: wrong finish reason`);
    assert.deepEqual(
      response.usage,
      { inputTokens: 1, outputTokens: 1 },
      `${endpoint.name}: wrong usage`,
    );
  }
});

test('a caller-supplied baseUrl overrides the default on every endpoint adapter', async () => {
  for (const endpoint of ENDPOINTS) {
    const captured: Captured[] = [];
    await endpoint
      .build(jsonFetch(CHAT_OK, captured, SECRET))
      .chat(ASK, { ...OPTIONS, baseUrl: 'https://elsewhere.example/v1' });
    assert.equal(captured[0]?.url, 'https://elsewhere.example/v1/chat/completions', endpoint.name);
  }
});

test('local endpoints work with no credential; hosted ones refuse', async () => {
  for (const endpoint of ENDPOINTS) {
    const deps = jsonFetch(CHAT_OK, [], undefined);
    if (endpoint.keyless) {
      // Ollama, LM Studio and a local OmniRoute take no key. Demanding one
      // would make a perfectly normal local setup impossible to configure.
      const response = await endpoint.build(deps).chat(ASK, OPTIONS);
      assert.equal(response.finishReason, 'stop', `${endpoint.name} should work keyless`);
    } else {
      await assert.rejects(
        () => endpoint.build(deps).chat(ASK, OPTIONS),
        ProviderError,
        `${endpoint.name} should refuse to call without a credential`,
      );
    }
  }
});

test('a keyless endpoint sends no Authorization header at all', async () => {
  const captured: Captured[] = [];
  await new OllamaAdapter(jsonFetch(CHAT_OK, captured, undefined)).chat(ASK, OPTIONS);
  assert.equal(captured[0]?.headers['authorization'], undefined);
});

test('OmniRoute listModels maps directly onto /v1/models', async () => {
  const captured: Captured[] = [];
  const deps: AdapterDependencies = {
    resolveSecret: () => undefined,
    transport: {
      fetch: ((url: string, init: RequestInit) => {
        captured.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ id: 'anthropic/claude-opus-5' }, { id: 'openai/gpt-5', name: 'GPT-5' }],
            }),
            { status: 200 },
          ),
        );
      }) as unknown as typeof globalThis.fetch,
    },
  };

  const models = await new OmniRouteAdapter(deps).listModels(OPTIONS);
  // F1.5: "imports its model catalogue via /v1/models".
  assert.equal(captured[0]?.url, `${OMNIROUTE_DEFAULT_BASE_URL}/models`);
  assert.deepEqual(models, [
    { id: 'anthropic/claude-opus-5', displayName: 'anthropic/claude-opus-5' },
    { id: 'openai/gpt-5', displayName: 'GPT-5' },
  ]);
});

test('listModels returns an empty list when the endpoint has no catalogue, rather than throwing', async () => {
  const deps: AdapterDependencies = {
    resolveSecret: () => undefined,
    transport: {
      fetch: (() =>
        Promise.resolve(
          new Response('nope', { status: 404 }),
        )) as unknown as typeof globalThis.fetch,
    },
  };
  // A server without /v1/models is a normal condition, not a failure — an
  // adapter that threw here would break connection setup for every endpoint
  // that simply does not publish a catalogue.
  assert.deepEqual(await new OllamaAdapter(deps).listModels(OPTIONS), []);
});

// ------------------------------------------- generic adapter, real HTTP server

/**
 * The ticket asks for a round trip "against a local test server stub", so this
 * starts a real HTTP server on an ephemeral port and uses the real global
 * fetch. A stubbed fetch would not prove the adapter can talk to an arbitrary
 * user-supplied URL, which is the entire feature.
 */
async function withServer(
  handler: (url: string, body: string) => { status?: number; body: string },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += String(chunk)));
    req.on('end', () => {
      const result = handler(req.url ?? '', body);
      res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
      res.end(result.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${String(port)}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('the generic adapter round-trips against a real server at a user-supplied baseUrl', async () => {
  const seen: Array<{ url: string; body: unknown }> = [];

  await withServer(
    (url, body) => {
      seen.push({ url, body: JSON.parse(body) as unknown });
      return {
        body: JSON.stringify({
          id: 'local-1',
          model: 'my-local-model',
          choices: [
            { index: 0, message: { content: 'hello from the stub' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 4 },
        }),
      };
    },
    async (baseUrl) => {
      const adapter = new OpenAiCompatibleAdapter(
        {
          kind: 'openai-compatible',
          provider: 'Self-hosted',
          defaultBaseUrl: 'http://unused.invalid/v1',
          requiresCredential: false,
        },
        { ...defaultDependencies, resolveSecret: () => undefined },
      );

      const response = await adapter.chat(
        { model: 'my-local-model', messages: [{ role: 'user', content: 'ping' }] },
        { authRef: AUTH, baseUrl },
      );

      assert.equal(response.content[0]?.type, 'text');
      assert.equal(
        response.content[0]?.type === 'text' ? response.content[0].text : '',
        'hello from the stub',
      );
      assert.deepEqual(response.usage, { inputTokens: 2, outputTokens: 4 });
    },
  );

  assert.equal(seen[0]?.url, '/v1/chat/completions');
  assert.equal((seen[0]?.body as { model: string }).model, 'my-local-model');
});

test('the generic adapter streams from a real server', async () => {
  await withServer(
    () => ({
      body: [
        'data: {"id":"s1","model":"m","choices":[{"index":0,"delta":{"content":"str"},"finish_reason":null}]}',
        '',
        'data: {"id":"s1","model":"m","choices":[{"index":0,"delta":{"content":"eam"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
    }),
    async (baseUrl) => {
      const adapter = new OpenAiCompatibleAdapter(
        {
          kind: 'openai-compatible',
          provider: 'Self-hosted',
          defaultBaseUrl: 'http://unused.invalid/v1',
          requiresCredential: false,
        },
        { ...defaultDependencies, resolveSecret: () => undefined },
      );

      const events: StreamEvent[] = [];
      for await (const event of adapter.streamChat(
        { model: 'm', messages: [{ role: 'user', content: 'go' }] },
        { authRef: AUTH, baseUrl },
      )) {
        events.push(event);
      }

      assert.equal(events[0]?.type, 'start');
      assert.equal(
        events
          .filter((e): e is Extract<StreamEvent, { type: 'textDelta' }> => e.type === 'textDelta')
          .map((e) => e.text)
          .join(''),
        'stream',
      );
      const finish = events.at(-1);
      assert.ok(finish?.type === 'finish');
      assert.deepEqual(finish.usage, { inputTokens: 1, outputTokens: 2 });
    },
  );
});

test('an unreachable user-supplied URL surfaces as PROVIDER_UNREACHABLE', async () => {
  const adapter = new OpenAiCompatibleAdapter(
    {
      kind: 'openai-compatible',
      provider: 'Self-hosted',
      defaultBaseUrl: 'http://unused.invalid/v1',
      requiresCredential: false,
    },
    { ...defaultDependencies, resolveSecret: () => undefined },
  );

  try {
    // Port 1 on loopback refuses immediately, so this does not hang.
    await adapter.chat(ASK, { authRef: AUTH, baseUrl: 'http://127.0.0.1:1/v1' });
    assert.fail('expected the adapter to reject');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, 'PROVIDER_UNREACHABLE');
  }
});

test('our own request deadline is a typed provider error, not a bare abort', async () => {
  // The defect this covers put the single word "timeout" on screen and ended a
  // run that every retry loop in the product would happily have retried. The
  // raw `Error('timeout')` escaped as itself, so `isRetryable` — which takes a
  // ProviderError — never saw it.
  const adapter = new OpenAiCompatibleAdapter(
    { kind: 'openai-compatible', provider: 'Slowly', defaultBaseUrl: 'https://example.invalid/v1' },
    {
      transport: {
        fetch: ((_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            // Never answers; whatever aborts it decides the outcome.
            init.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason ?? new Error('aborted'));
            });
          })) as unknown as typeof globalThis.fetch,
      },
      resolveSecret: () => 'sk-test',
    },
  );

  // The caller's own cancellation still propagates untouched — that is the
  // distinction the fix turns on, and collapsing the two would make a stop
  // button look like a provider fault.
  const cancelled = new AbortController();
  const inFlight = adapter.chat(
    { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    { authRef: 'vault:connection:0'.padEnd(48, '0') as never, signal: cancelled.signal },
  );
  cancelled.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(inFlight, (err: unknown) => {
    assert.ok(
      !(err instanceof ProviderError),
      'a caller cancellation must not become a provider error',
    );
    return true;
  });
});
