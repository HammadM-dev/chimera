import type { AdapterCallOptions, ProviderAdapter } from '../adapter.ts';
import { get as capabilitiesFor } from '../capabilityMatrix.ts';
import type {
  ConnectionTestResult,
  ContentPart,
  FinishReason,
  ModelDescriptor,
  NormalisedRequest,
  NormalisedResponse,
  StreamEvent,
  ToolCall,
  Usage,
} from '../normalised.ts';
import {
  defaultDependencies,
  invalidResponse,
  parseSseJson,
  postJson,
  streamSse,
  type AdapterDependencies,
} from './http.ts';

// Anthropic Messages API. Wire format per the published API reference:
// POST /v1/messages, x-api-key + anthropic-version headers, a top-level
// `system` string (not a message role), and tool results carried as
// `tool_result` content blocks inside a *user* turn.
//
// Everything provider-specific about Anthropic lives in this file and nowhere
// else — that is the whole point of the adapter layer.

const PROVIDER = 'Anthropic';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

/** Anthropic requires max_tokens on every request; the API has no "unbounded". */
const FALLBACK_MAX_TOKENS = 4096;

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicMessageResponse {
  id: string;
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
  };
}

function finishReasonFrom(stopReason: string | null): FinishReason {
  switch (stopReason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'toolCalls';
    case 'refusal':
      return 'contentFilter';
    // end_turn, stop_sequence, pause_turn, and null all mean "it stopped
    // normally" as far as anything above this package is concerned.
    default:
      return 'stop';
  }
}

/**
 * Splits the normalised messages into Anthropic's shape.
 *
 * Three translations matter: system turns are hoisted out of the array into a
 * top-level string (Anthropic has no system role); assistant tool calls become
 * `tool_use` content blocks; and tool results become `tool_result` blocks in a
 * *user* turn, which is where Anthropic expects them.
 */
function toAnthropicMessages(request: NormalisedRequest): {
  system: string | undefined;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
} {
  const systemParts: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];

  for (const message of request.messages) {
    if (message.role === 'system') {
      systemParts.push(typeof message.content === 'string' ? message.content : '');
      continue;
    }

    if (message.role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: typeof message.content === 'string' ? message.content : '',
          },
        ],
      });
      continue;
    }

    const blocks: unknown[] = [];
    const parts: ContentPart[] =
      typeof message.content === 'string'
        ? message.content === ''
          ? []
          : [{ type: 'text', text: message.content }]
        : message.content;

    for (const part of parts) {
      if (part.type === 'text') {
        blocks.push({ type: 'text', text: part.text });
      } else {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: part.mediaType, data: part.data },
        });
      }
    }

    for (const call of message.toolCalls ?? []) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
    }

    // A turn with no blocks at all is rejected by the API; an assistant turn
    // that only carried tool calls has already produced blocks above.
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
    messages.push({ role: message.role, content: blocks });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages,
  };
}

function buildBody(request: NormalisedRequest, stream: boolean): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(request);
  const capabilities = capabilitiesFor(request.model);

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    // Required by the API. Falls back to the model's own documented ceiling
    // where the capability matrix knows it, so a caller that omits the field
    // gets the model's full range rather than an arbitrary cap.
    max_tokens: request.maxOutputTokens ?? capabilities.maxOutputTokens ?? FALLBACK_MAX_TOKENS,
  };

  if (system !== undefined) body['system'] = system;
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.topP !== undefined) body['top_p'] = request.topP;
  if (request.stopSequences) body['stop_sequences'] = request.stopSequences;
  if (stream) body['stream'] = true;

  if (request.tools && request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  if (request.toolChoice !== undefined) {
    body['tool_choice'] =
      typeof request.toolChoice === 'string'
        ? request.toolChoice === 'required'
          ? { type: 'any' }
          : { type: request.toolChoice }
        : { type: 'tool', name: request.toolChoice.name };
  }

  return body;
}

function toNormalised(payload: AnthropicMessageResponse): NormalisedResponse {
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of payload.content) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text });
    else toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
  }

  const usage: Usage = {
    inputTokens: payload.usage.input_tokens,
    outputTokens: payload.usage.output_tokens,
    ...(payload.usage.cache_read_input_tokens === undefined
      ? {}
      : { cachedInputTokens: payload.usage.cache_read_input_tokens }),
  };

  return {
    id: payload.id,
    model: payload.model,
    content,
    toolCalls,
    finishReason: finishReasonFrom(payload.stop_reason),
    usage,
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = 'anthropic' as const;

  // A declared field plus an assignment, not a parameter property: Node 22
  // runs this TypeScript by stripping types, and `constructor(private readonly
  // x: T)` is the one syntax that needs real emit. It typechecks under tsc and
  // throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at runtime — caught by the tests,
  // not the compiler.
  private readonly deps: AdapterDependencies;

  constructor(deps: AdapterDependencies = defaultDependencies) {
    this.deps = deps;
  }

  private headers(options: AdapterCallOptions): Record<string, string> {
    // Resolved here, at the moment of the call, and never stored: the plaintext
    // key exists only for the duration of this request (see AdapterCallOptions).
    const key = this.deps.resolveSecret(options.authRef);
    if (key === undefined) {
      throw invalidResponse(PROVIDER, 'no credential found in the vault for this connection');
    }
    return { 'x-api-key': key, 'anthropic-version': API_VERSION };
  }

  /** The credential, for scrubbing out of any error raised by this call. */
  private secrets(options: AdapterCallOptions): string[] {
    const key = this.deps.resolveSecret(options.authRef);
    return key === undefined ? [] : [key];
  }

  private url(options: AdapterCallOptions): string {
    return `${options.baseUrl ?? DEFAULT_BASE_URL}/v1/messages`;
  }

  async chat(request: NormalisedRequest, options: AdapterCallOptions): Promise<NormalisedResponse> {
    const payload = await postJson<AnthropicMessageResponse>({
      transport: this.deps.transport,
      provider: PROVIDER,
      url: this.url(options),
      headers: this.headers(options),
      body: buildBody(request, false),
      secrets: this.secrets(options),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!Array.isArray(payload.content)) {
      throw invalidResponse(PROVIDER, 'response had no content array');
    }
    return toNormalised(payload);
  }

  async *streamChat(
    request: NormalisedRequest,
    options: AdapterCallOptions,
  ): AsyncIterable<StreamEvent> {
    const events = streamSse({
      transport: this.deps.transport,
      provider: PROVIDER,
      url: this.url(options),
      headers: this.headers(options),
      body: buildBody(request, true),
      secrets: this.secrets(options),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    // Anthropic reports input tokens on message_start and output tokens on
    // message_delta, so the finish event has to be assembled from both.
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: FinishReason = 'stop';
    let started = false;
    const toolIndexes = new Map<number, number>();
    let nextToolIndex = 0;

    for await (const data of events) {
      const event = parseSseJson<Record<string, unknown>>(data);
      if (!event) continue;

      switch (event['type']) {
        case 'message_start': {
          const message = event['message'] as AnthropicMessageResponse | undefined;
          if (!message) break;
          usage = { inputTokens: message.usage.input_tokens, outputTokens: 0 };
          started = true;
          yield { type: 'start', id: message.id, model: message.model };
          break;
        }
        case 'content_block_start': {
          const block = event['content_block'] as AnthropicContentBlock | undefined;
          if (block?.type !== 'tool_use') break;
          const index = nextToolIndex++;
          toolIndexes.set(event['index'] as number, index);
          yield { type: 'toolCallDelta', index, id: block.id, name: block.name };
          break;
        }
        case 'content_block_delta': {
          const delta = event['delta'] as Record<string, unknown> | undefined;
          if (delta?.['type'] === 'text_delta') {
            yield { type: 'textDelta', text: delta['text'] as string };
          } else if (delta?.['type'] === 'input_json_delta') {
            const index = toolIndexes.get(event['index'] as number);
            if (index !== undefined) {
              yield {
                type: 'toolCallDelta',
                index,
                argumentsDelta: delta['partial_json'] as string,
              };
            }
          }
          break;
        }
        case 'message_delta': {
          const delta = event['delta'] as Record<string, unknown> | undefined;
          const deltaUsage = event['usage'] as { output_tokens?: number } | undefined;
          if (delta?.['stop_reason'] !== undefined) {
            finishReason = finishReasonFrom(delta['stop_reason'] as string | null);
          }
          if (deltaUsage?.output_tokens !== undefined) {
            usage = { ...usage, outputTokens: deltaUsage.output_tokens };
          }
          break;
        }
        default:
          break;
      }
    }

    if (!started) throw invalidResponse(PROVIDER, 'stream ended before message_start');
    yield { type: 'finish', finishReason, usage };
  }

  listModels(_options: AdapterCallOptions): Promise<ModelDescriptor[]> {
    // Deliberately not a live /v1/models call yet: M1-8 owns capability
    // discovery, and a second unrelated network path here would have to be
    // rewritten when it lands. The statically known Anthropic models come from
    // the capability matrix instead.
    return Promise.resolve([]);
  }

  async testConnection(options: AdapterCallOptions): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    try {
      await this.chat(
        {
          model: 'claude-haiku-4-5',
          messages: [{ role: 'user', content: 'ping' }],
          maxOutputTokens: 1,
        },
        options,
      );
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      // Never throws for an expected failure — the interface contract. The
      // detail is the provider's message, which never contains the credential.
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
