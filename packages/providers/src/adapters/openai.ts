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
  invalidResponse,
  parseSseJson,
  postJson,
  streamSse,
  type AdapterDependencies,
} from './http.ts';

// OpenAI Chat Completions. Wire format verified against OpenAI's published
// OpenAPI specification: POST /v1/chat/completions, Bearer auth,
// `max_completion_tokens` (`max_tokens` is deprecated there), tool call
// arguments carried as a JSON *string*, and a `data: [DONE]` stream sentinel.
//
// This shape is also what every "OpenAI-compatible" endpoint speaks, so M1-5's
// OpenRouter, Ollama, LM Studio and generic adapters reuse this translation
// rather than reimplementing it.

const PROVIDER = 'OpenAI';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

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

  if (stream) {
    body['stream'] = true;
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

export class OpenAiAdapter implements ProviderAdapter {
  readonly kind = 'openai' as const;

  // A declared field plus an assignment, not a parameter property: Node 22
  // runs this TypeScript by stripping types, and `constructor(private readonly
  // x: T)` is the one syntax that needs real emit. It typechecks under tsc and
  // throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at runtime — caught by the tests,
  // not the compiler.
  private readonly deps: AdapterDependencies;

  constructor(deps: AdapterDependencies = defaultDependencies) {
    this.deps = deps;
  }

  protected get provider(): string {
    return PROVIDER;
  }

  protected get defaultBaseUrl(): string {
    return DEFAULT_BASE_URL;
  }

  private headers(options: AdapterCallOptions): Record<string, string> {
    const key = this.deps.resolveSecret(options.authRef);
    if (key === undefined) {
      throw invalidResponse(this.provider, 'no credential found in the vault for this connection');
    }
    return { authorization: `Bearer ${key}` };
  }

  /** The credential, for scrubbing out of any error raised by this call. */
  private secrets(options: AdapterCallOptions): string[] {
    const key = this.deps.resolveSecret(options.authRef);
    return key === undefined ? [] : [key];
  }

  private url(options: AdapterCallOptions): string {
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

  listModels(_options: AdapterCallOptions): Promise<ModelDescriptor[]> {
    // See the note on AnthropicAdapter.listModels — capability discovery is
    // M1-8's, not a second network path bolted on here.
    return Promise.resolve([]);
  }

  async testConnection(options: AdapterCallOptions): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    try {
      await this.chat(
        { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'ping' }], maxOutputTokens: 1 },
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
