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

// Google Gemini generateContent. Wire format verified against Google's
// published REST reference: the model is part of the *path*
// (`/v1beta/models/{model}:generateContent`), the API key is a query
// parameter, roles are `user` and `model` (there is no `assistant`), the system
// prompt is a separate `systemInstruction` object, and streaming is requested
// with `:streamGenerateContent?alt=sse`.

const PROVIDER = 'Google';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiFunctionCall {
  name: string;
  args?: Record<string, unknown>;
}

interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  responseId?: string;
  modelVersion?: string;
}

function finishReasonFrom(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII':
      return 'contentFilter';
    default:
      return 'stop';
  }
}

/**
 * Gemini has no `assistant` or `tool` role — only `user` and `model` — and a
 * tool result travels as a `functionResponse` part inside a *user* turn.
 * Consecutive turns of the same role are merged, because the API rejects a
 * `contents` array that repeats a role.
 */
function toGeminiContents(request: NormalisedRequest): {
  systemInstruction: { parts: Array<{ text: string }> } | undefined;
  contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }>;
} {
  const systemTexts: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = [];

  const push = (role: 'user' | 'model', parts: GeminiPart[]): void => {
    if (parts.length === 0) return;
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const message of request.messages) {
    if (message.role === 'system') {
      systemTexts.push(typeof message.content === 'string' ? message.content : '');
      continue;
    }

    if (message.role === 'tool') {
      push('user', [
        {
          functionResponse: {
            // The API correlates a response to a call by *name*, not by id, so
            // the normalised toolCallId cannot be used here.
            name: message.toolCallId ?? 'unknown',
            response: {
              content: typeof message.content === 'string' ? message.content : '',
            },
          },
        } as GeminiPart,
      ]);
      continue;
    }

    const parts: GeminiPart[] = [];
    const contentParts: ContentPart[] =
      typeof message.content === 'string'
        ? message.content === ''
          ? []
          : [{ type: 'text', text: message.content }]
        : message.content;

    for (const part of contentParts) {
      if (part.type === 'text') parts.push({ text: part.text });
      else parts.push({ inlineData: { mimeType: part.mediaType, data: part.data } });
    }

    for (const call of message.toolCalls ?? []) {
      parts.push({ functionCall: { name: call.name, args: call.arguments } });
    }

    push(message.role === 'assistant' ? 'model' : 'user', parts);
  }

  return {
    systemInstruction:
      systemTexts.length > 0 ? { parts: [{ text: systemTexts.join('\n\n') }] } : undefined,
    contents,
  };
}

function buildBody(request: NormalisedRequest): Record<string, unknown> {
  const { systemInstruction, contents } = toGeminiContents(request);
  const generationConfig: Record<string, unknown> = {};

  if (request.maxOutputTokens !== undefined) {
    generationConfig['maxOutputTokens'] = request.maxOutputTokens;
  }
  if (request.temperature !== undefined) generationConfig['temperature'] = request.temperature;
  if (request.topP !== undefined) generationConfig['topP'] = request.topP;
  if (request.stopSequences) generationConfig['stopSequences'] = request.stopSequences;
  if (request.responseFormat?.type === 'json_schema') {
    generationConfig['responseMimeType'] = 'application/json';
    generationConfig['responseSchema'] = request.responseFormat.schema;
  }

  const body: Record<string, unknown> = { contents };
  if (systemInstruction) body['systemInstruction'] = systemInstruction;
  if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;

  if (request.tools && request.tools.length > 0) {
    body['tools'] = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ];
  }

  return body;
}

function toNormalised(payload: GeminiResponse, model: string): NormalisedResponse {
  const candidate = payload.candidates?.[0];
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];

  for (const [index, part] of (candidate?.content?.parts ?? []).entries()) {
    if (part.text !== undefined) content.push({ type: 'text', text: part.text });
    if (part.functionCall) {
      // Gemini assigns no call id, so one is synthesised from position. It is
      // stable within a response, which is all a tool-result correlation needs.
      toolCalls.push({
        id: `${part.functionCall.name}-${String(index)}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args ?? {},
      });
    }
  }

  const usage: Usage = {
    inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
    ...(payload.usageMetadata?.cachedContentTokenCount === undefined
      ? {}
      : { cachedInputTokens: payload.usageMetadata.cachedContentTokenCount }),
    ...(payload.usageMetadata?.thoughtsTokenCount === undefined
      ? {}
      : { reasoningTokens: payload.usageMetadata.thoughtsTokenCount }),
  };

  return {
    id: payload.responseId ?? 'gemini-response',
    model: payload.modelVersion ?? model,
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'toolCalls' : finishReasonFrom(candidate?.finishReason),
    usage,
  };
}

export class GoogleAdapter implements ProviderAdapter {
  readonly kind = 'google' as const;

  // A declared field plus an assignment, not a parameter property: Node 22
  // runs this TypeScript by stripping types, and `constructor(private readonly
  // x: T)` is the one syntax that needs real emit. It typechecks under tsc and
  // throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at runtime — caught by the tests,
  // not the compiler.
  private readonly deps: AdapterDependencies;

  constructor(deps: AdapterDependencies = defaultDependencies) {
    this.deps = deps;
  }

  /** The credential, for scrubbing out of any error raised by this call. */
  private secrets(options: AdapterCallOptions): string[] {
    const key = this.deps.resolveSecret(options.authRef);
    return key === undefined ? [] : [key];
  }

  private url(model: string, options: AdapterCallOptions, stream: boolean): string {
    const key = this.deps.resolveSecret(options.authRef);
    if (key === undefined) {
      throw invalidResponse(PROVIDER, 'no credential found in the vault for this connection');
    }
    const base = options.baseUrl ?? DEFAULT_BASE_URL;
    const method = stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?';
    // The key is a query parameter on this API rather than a header. It is
    // built here and never logged: nothing in this package writes a URL to a
    // log line, and errorForStatus reports the status and body, never the URL.
    return `${base}/models/${model}:${method}key=${encodeURIComponent(key)}`;
  }

  async chat(request: NormalisedRequest, options: AdapterCallOptions): Promise<NormalisedResponse> {
    const payload = await postJson<GeminiResponse>({
      transport: this.deps.transport,
      provider: PROVIDER,
      url: this.url(request.model, options, false),
      headers: {},
      body: buildBody(request),
      secrets: this.secrets(options),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!payload.candidates || payload.candidates.length === 0) {
      throw invalidResponse(PROVIDER, 'response contained no candidates');
    }
    return toNormalised(payload, request.model);
  }

  async *streamChat(
    request: NormalisedRequest,
    options: AdapterCallOptions,
  ): AsyncIterable<StreamEvent> {
    const events = streamSse({
      transport: this.deps.transport,
      provider: PROVIDER,
      url: this.url(request.model, options, true),
      headers: {},
      body: buildBody(request),
      secrets: this.secrets(options),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    let started = false;
    let finishReason: FinishReason = 'stop';
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let toolIndex = 0;

    for await (const data of events) {
      const chunk = parseSseJson<GeminiResponse>(data);
      if (!chunk) continue;

      if (!started) {
        started = true;
        yield {
          type: 'start',
          id: chunk.responseId ?? 'gemini-response',
          model: chunk.modelVersion ?? request.model,
        };
      }

      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount ?? usage.inputTokens,
          outputTokens: chunk.usageMetadata.candidatesTokenCount ?? usage.outputTokens,
        };
      }

      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text) yield { type: 'textDelta', text: part.text };
        if (part.functionCall) {
          // Gemini streams a function call whole rather than as argument
          // fragments, so this emits one complete delta rather than faking
          // a fragmented one.
          yield {
            type: 'toolCallDelta',
            index: toolIndex,
            id: `${part.functionCall.name}-${String(toolIndex)}`,
            name: part.functionCall.name,
            argumentsDelta: JSON.stringify(part.functionCall.args ?? {}),
          };
          toolIndex += 1;
        }
      }

      if (candidate?.finishReason) finishReason = finishReasonFrom(candidate.finishReason);
    }

    if (!started) throw invalidResponse(PROVIDER, 'stream ended before any chunk arrived');
    yield {
      type: 'finish',
      finishReason: toolIndex > 0 ? 'toolCalls' : finishReason,
      usage,
    };
  }

  listModels(_options: AdapterCallOptions): Promise<ModelDescriptor[]> {
    return Promise.resolve([]);
  }

  async testConnection(options: AdapterCallOptions): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    try {
      await this.chat(
        {
          model: 'gemini-2.5-flash',
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
