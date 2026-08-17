import type { AdapterCallOptions, ProviderAdapter } from '../adapter.ts';
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
  getJson,
  invalidResponse,
  parseSseJson,
  postJson,
  streamSse,
  type AdapterDependencies,
} from './http.ts';

// OpenAI Chat Completions, and the base every OpenAI-compatible endpoint
// reuses. Wire format verified against OpenAI's published OpenAPI
// specification: POST /v1/chat/completions, Bearer auth,
// `max_completion_tokens` (`max_tokens` is deprecated there), tool call
// arguments carried as a JSON *string*, and a `data: [DONE]` stream sentinel.
//
// OpenRouter, OmniRoute, Ollama, LM Studio and the generic URL-configured
// adapter are all this class with different endpoint configuration. They
// subclass rather than copy, so a fix to the translation lands in all of them
// at once — the alternative is five files that drift.

import type { ProviderKind } from '../registry.ts';

export interface OpenAiCompatibleConfig {
  kind: ProviderKind;
  /** Human-readable name, used in error messages only. */
  provider: string;
  /** Used when the connection supplies no baseUrl of its own. */
  defaultBaseUrl: string;
  /**
   * False for servers that run on the user's own machine and take no key.
   * Ollama and LM Studio accept any Authorization header or none; demanding a
   * credential would make a local connection impossible to configure.
   */
  requiresCredential?: boolean;
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiChoice {
  index: number;
  message?: { content: string | null; tool_calls?: OpenAiToolCall[] };
  delta?: {
    content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason: string | null;
}

interface OpenAiResponse {
  id: string;
  model: string;
  choices: OpenAiChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

function finishReasonFrom(reason: string | null): FinishReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'toolCalls';
    case 'content_filter':
      return 'contentFilter';
    default:
      return 'stop';
  }
}

/**
 * Tool call arguments cross OpenAI's wire as a JSON *string*, not an object.
 *
 * A model that emits malformed JSON here is common enough that OpenAI's own
 * documentation warns about it, so this never throws: an unparseable argument
 * blob surfaces as `{}` plus the raw text, leaving the caller with something to
 * log rather than an exception that loses the whole response.
 */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

export function toOpenAiMessages(request: NormalisedRequest): unknown[] {
  return request.messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: typeof message.content === 'string' ? message.content : '',
      };
    }

    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part: ContentPart) =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : {
                  type: 'image_url',
                  image_url: { url: `data:${part.mediaType};base64,${part.data}` },
                },
          );

    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: typeof content === 'string' && content === '' ? null : content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    }

    return { role: message.role, content };
  });
}

export function buildOpenAiBody(
  request: NormalisedRequest,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOpenAiMessages(request),
  };

  // max_completion_tokens, not max_tokens: the latter is deprecated in the
  // published spec and rejected by reasoning models.
  if (request.maxOutputTokens !== undefined) {
    body['max_completion_tokens'] = request.maxOutputTokens;
  }
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.topP !== undefined) body['top_p'] = request.topP;
  if (request.stopSequences) body['stop'] = request.stopSequences;

  // Stated either way, never omitted. A gateway that defaults to streaming —
  // OmniRoute does — answers a non-streaming request with `text/event-stream`,
  // and the adapter then reports a body it cannot read. Saying `false` costs
  // one field and removes a whole class of "works against one provider" bug.
  body['stream'] = stream;

  if (stream) {
    // Without this, a streamed response carries no usage at all and every
    // budget figure for a streaming run would be zero.
    body['stream_options'] = { include_usage: true };
  }

  if (request.tools && request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  if (request.toolChoice !== undefined) {
    body['tool_choice'] =
      typeof request.toolChoice === 'string'
        ? request.toolChoice
        : { type: 'function', function: { name: request.toolChoice.name } };
  }

  if (request.responseFormat?.type === 'json_schema') {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: {
        name: request.responseFormat.name,
        schema: request.responseFormat.schema,
        strict: true,
      },
    };
  }

  return body;
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly kind: ProviderKind;

  // A declared field plus an assignment, not a parameter property: Node 22
  // runs this TypeScript by stripping types, and `constructor(private readonly
  // x: T)` is the one syntax that needs real emit. It typechecks under tsc and
  // throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at runtime — caught by the tests,
  // not the compiler.
  protected readonly deps: AdapterDependencies;
  protected readonly config: OpenAiCompatibleConfig;

  constructor(config: OpenAiCompatibleConfig, deps: AdapterDependencies = defaultDependencies) {
    this.config = config;
    this.kind = config.kind;
    this.deps = deps;
  }

  protected get provider(): string {
    return this.config.provider;
  }

  protected get defaultBaseUrl(): string {
    return this.config.defaultBaseUrl;
  }

  protected headers(options: AdapterCallOptions): Record<string, string> {
    const key = this.deps.resolveSecret(options.authRef);
    // An empty string is not a credential. A local gateway is stored with one
    // because the column holds a vault handle by contract, and sending
    // `Authorization: Bearer ` makes a server that would have accepted an
    // unauthenticated request reject it instead — which looks to the user like
    // a connection that imported fine and then answers nothing.
    if (key === undefined || key === '') {
      if (this.config.requiresCredential === false) return {};
      throw invalidResponse(this.provider, 'no credential found in the vault for this connection');
    }
    return { authorization: `Bearer ${key}` };
  }

  /** The credential, for scrubbing out of any error raised by this call. */
  protected secrets(options: AdapterCallOptions): string[] {
    const key = this.deps.resolveSecret(options.authRef);
    return key === undefined || key === '' ? [] : [key];
  }

  protected url(options: AdapterCallOptions): string {
    return `${options.baseUrl ?? this.defaultBaseUrl}/chat/completions`;
  }

  async chat(request: NormalisedRequest, options: AdapterCallOptions): Promise<NormalisedResponse> {
    const payload = await postJson<OpenAiResponse>({
      transport: this.deps.transport,
      provider: this.provider,
      url: this.url(options),
      headers: this.headers(options),
      body: buildOpenAiBody(request, false),
      secrets: this.secrets(options),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const choice = payload.choices?.[0];
    if (!choice) throw invalidResponse(this.provider, 'response contained no choices');

    const text = choice.message?.content ?? '';
    const content: ContentPart[] = text === '' ? [] : [{ type: 'text', text }];
    const toolCalls: ToolCall[] = (choice.message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: parseArguments(call.function.arguments),
    }));

    const usage: Usage = {
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
    };

    return {
      id: payload.id,
      model: payload.model,
      content,
      toolCalls,
      finishReason: finishReasonFrom(choice.finish_reason),
      usage,
    };
  }

  async *streamChat(
    request: NormalisedRequest,
    options: AdapterCallOptions,
  ): AsyncIterable<StreamEvent> {
    const events = streamSse({
      transport: this.deps.transport,
      provider: this.provider,
      url: this.url(options),
      headers: this.headers(options),
      body: buildOpenAiBody(request, true),
      secrets: this.secrets(options),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    let started = false;
    let finishReason: FinishReason = 'stop';
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };

    for await (const data of events) {
      const chunk = parseSseJson<OpenAiResponse>(data);
      if (!chunk) continue;

      if (!started) {
        started = true;
        yield { type: 'start', id: chunk.id, model: chunk.model };
      }

      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.delta?.content) {
        yield { type: 'textDelta', text: choice.delta.content };
      }

      for (const call of choice.delta?.tool_calls ?? []) {
        // `index` is OpenAI's own correlation key for a tool call spread across
        // deltas — passed straight through rather than re-derived, so a
        // consumer accumulating by index groups them the same way OpenAI did.
        yield {
          type: 'toolCallDelta',
          index: call.index,
          ...(call.id === undefined ? {} : { id: call.id }),
          ...(call.function?.name === undefined ? {} : { name: call.function.name }),
          ...(call.function?.arguments === undefined
            ? {}
            : { argumentsDelta: call.function.arguments }),
        };
      }

      if (choice.finish_reason) finishReason = finishReasonFrom(choice.finish_reason);
    }

    if (!started) throw invalidResponse(this.provider, 'stream ended before any chunk arrived');
    yield { type: 'finish', finishReason, usage };
  }

  /** Model used by testConnection's probe call. Overridden per endpoint. */
  protected get probeModel(): string {
    return 'gpt-5-mini';
  }

  /**
   * Lists models from the endpoint's `/v1/models`, which every
   * OpenAI-compatible server exposes. Returns an empty list rather than
   * throwing when the endpoint does not implement it — a provider without a
   * catalogue is a normal condition, not a failure.
   */
  async listModels(options: AdapterCallOptions): Promise<ModelDescriptor[]> {
    try {
      const payload = await getJson<{ data?: Array<{ id: string; name?: string }> }>({
        transport: this.deps.transport,
        provider: this.provider,
        url: `${options.baseUrl ?? this.defaultBaseUrl}/models`,
        headers: this.headers(options),
        secrets: this.secrets(options),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return (payload.data ?? []).map((model) => ({
        id: model.id,
        displayName: model.name ?? model.id,
      }));
    } catch {
      return [];
    }
  }

  async testConnection(options: AdapterCallOptions): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    try {
      await this.chat(
        {
          model: this.probeModel,
          messages: [{ role: 'user', content: 'ping' }],
          maxOutputTokens: 1,
        },
        options,
      );
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
