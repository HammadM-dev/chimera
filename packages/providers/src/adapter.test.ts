import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthRef } from '@chimera/store';
import type { ProviderAdapter, AdapterCallOptions } from './adapter.ts';
import {
  textOf,
  toContentParts,
  type NormalisedRequest,
  type NormalisedResponse,
  type StreamEvent,
} from './normalised.ts';

// A trivial adapter, existing only to prove the interface is implementable and
// that a request survives the round trip with every field intact. The real
// adapters land in M1-4 and the CI-wide mock provider in M1-6; this one is
// scoped to this file on purpose so it cannot drift into being used as a test
// double elsewhere.
class EchoAdapter implements ProviderAdapter {
  readonly kind = 'openai-compatible' as const;

  lastRequest: NormalisedRequest | undefined;
  lastOptions: AdapterCallOptions | undefined;

  chat(request: NormalisedRequest, options: AdapterCallOptions): Promise<NormalisedResponse> {
    this.lastRequest = request;
    this.lastOptions = options;
    const lastMessage = request.messages.at(-1);
    const echoed = lastMessage ? toContentParts(lastMessage.content) : [];
    return Promise.resolve({
      id: 'echo-1',
      model: request.model,
      content: echoed,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 11, outputTokens: 7 },
    });
  }

  async *streamChat(
    request: NormalisedRequest,
    options: AdapterCallOptions,
  ): AsyncIterable<StreamEvent> {
    this.lastOptions = options;
    yield { type: 'start', id: 'echo-1', model: request.model };
    yield { type: 'textDelta', text: 'he' };
    yield { type: 'textDelta', text: 'llo' };
    yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 11, outputTokens: 7 } };
  }

  listModels(): Promise<{ id: string; displayName: string }[]> {
    return Promise.resolve([{ id: 'echo-small', displayName: 'Echo Small' }]);
  }

  testConnection(): Promise<{ ok: boolean; latencyMs: number }> {
    return Promise.resolve({ ok: true, latencyMs: 1 });
  }
}

const HANDLE = 'vault:connection:11111111-2222-3333-4444-555555555555' as AuthRef;

test('a representative request survives the interface with every field intact', async () => {
  const adapter = new EchoAdapter();

  // Deliberately exercises every optional field at once. A request that only
  // set `model` and `messages` would compile against a much weaker interface
  // and tell us nothing.
  const request: NormalisedRequest = {
    model: 'echo-small',
    messages: [
      { role: 'system', content: 'You extract data.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
        ],
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { query: 'chimera' } }],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'a mythical hybrid' },
    ],
    maxOutputTokens: 256,
    temperature: 0.2,
    topP: 0.9,
    stopSequences: ['<<END>>'],
    tools: [
      {
        name: 'lookup',
        description: 'Look a term up',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ],
    toolChoice: { name: 'lookup' },
    responseFormat: {
      type: 'json_schema',
      name: 'extraction',
      schema: { type: 'object', properties: { found: { type: 'boolean' } } },
    },
  };

  const response = await adapter.chat(request, { authRef: HANDLE, baseUrl: 'http://localhost:1' });

  // Round-tripped without loss.
  assert.deepEqual(adapter.lastRequest, request);

  // Every field the interface promises on the way back is present and typed.
  assert.equal(response.id, 'echo-1');
  assert.equal(response.model, 'echo-small');
  assert.equal(response.finishReason, 'stop');
  assert.deepEqual(response.toolCalls, []);
  assert.equal(response.usage.inputTokens, 11);
  assert.equal(response.usage.outputTokens, 7);
  assert.equal(textOf(response), 'a mythical hybrid');
});

test('the adapter receives a vault handle, never a secret value', async () => {
  const adapter = new EchoAdapter();
  await adapter.chat(
    { model: 'echo-small', messages: [{ role: 'user', content: 'hi' }] },
    {
      authRef: HANDLE,
    },
  );

  assert.equal(adapter.lastOptions?.authRef, HANDLE);
  assert.match(adapter.lastOptions?.authRef ?? '', /^vault:/);

  // Nothing on the options object is a plaintext credential — the whole point
  // of the handle indirection. Asserted rather than assumed because this is the
  // one call boundary where passing the value would be the obvious shortcut.
  const serialised = JSON.stringify(adapter.lastOptions);
  assert.ok(!/sk-[A-Za-z0-9]/.test(serialised));
});

test('streamChat always brackets its deltas with exactly one start and one finish', async () => {
  const adapter = new EchoAdapter();
  const events: StreamEvent[] = [];
  for await (const event of adapter.streamChat(
    { model: 'echo-small', messages: [{ role: 'user', content: 'hi' }] },
    { authRef: HANDLE },
  )) {
    events.push(event);
  }

  assert.equal(events.filter((e) => e.type === 'start').length, 1);
  assert.equal(events.filter((e) => e.type === 'finish').length, 1);
  assert.equal(events[0]?.type, 'start');
  assert.equal(events.at(-1)?.type, 'finish');

  const streamed = events
    .filter((e): e is Extract<StreamEvent, { type: 'textDelta' }> => e.type === 'textDelta')
    .map((e) => e.text)
    .join('');
  assert.equal(streamed, 'hello');
});

test('a plain string content is equivalent to a single text part', () => {
  assert.deepEqual(toContentParts('hi'), [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(toContentParts([{ type: 'text', text: 'hi' }]), [{ type: 'text', text: 'hi' }]);
});

test('textOf ignores image parts rather than stringifying them', () => {
  const response: NormalisedResponse = {
    id: 'r',
    model: 'm',
    content: [
      { type: 'text', text: 'a' },
      { type: 'image', mediaType: 'image/png', data: 'aGk=' },
      { type: 'text', text: 'b' },
    ],
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  assert.equal(textOf(response), 'ab');
});
