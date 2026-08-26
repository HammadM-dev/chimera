import { createHash } from 'node:crypto';
import { ProviderAuthError, ProviderError, ProviderRateLimitError } from '@chimera/errors';
import type { AdapterCallOptions, ProviderAdapter } from './adapter.ts';
import type { ModelCapabilities } from './capabilityMatrix.ts';
import type {
  ConnectionTestResult,
  ContentPart,
  ModelDescriptor,
  NormalisedRequest,
  NormalisedResponse,
  StreamEvent,
  ToolCall,
  Usage,
} from './normalised.ts';

// The single test double for every provider adapter — docs/TESTING.md section 2.
// It implements ProviderAdapter exactly, so nothing above this package can tell
// it apart from anthropic.ts by shape. That is what lets one code path serve CI
// tests, golden evals, and the F7.9 interactive dry run without a
// `NODE_ENV === 'test'` branch anywhere in packages/core.
//
// It makes no network call, ever, and has no wall-clock or random input to its
// response generation: the same script and the same call sequence produce
// byte-identical responses across runs and machines (docs/TESTING.md 2.1).

export type MockErrorKind = 'auth' | 'rateLimit' | 'timeout' | 'contentFilter';

export type MockResponse =
  | { kind: 'text'; content: string }
  | {
      kind: 'toolCall';
      toolId: string;
      toolName: string;
      params: Record<string, unknown>;
      /**
       * What the model says in the same turn as the call.
       *
       * Every real provider does this — "I'll fetch your GitHub emails now"
       * arrives attached to the call, not instead of it — and this double could
       * not express it, so no test could reproduce what a real model actually
       * sends. That gap hid a real defect: the agent loop took the sentence a
       * model said *before* its tools ran as the step's answer, and handed that
       * downstream instead of the results.
       */
      say?: string;
    }
  | { kind: 'structuredOutput'; json: unknown }
  | { kind: 'error'; error: MockErrorKind; retryAfterMs?: number };

export interface MockScript {
  /**
   * Consumed in order, one entry per call, regardless of request content.
   * Exhausted before fingerprint rules are consulted — this is what lets a test
   * say "the second call returns a 429" without caring what the request was.
   */
  queue?: MockResponse[];
  /**
   * Consulted once the queue is empty. Keyed by `fingerprintOf(request)`.
   * An array is consumed in order for repeat calls with the same fingerprint,
   * with the last entry repeating once exhausted.
   */
  byFingerprint?: Map<string, MockResponse | MockResponse[]>;
  /**
   * Used when neither a queued nor a fingerprinted response matches. Golden
   * evals and dry run depend on this so a template author does not have to
   * script every call a workflow might make.
   */
  default?: MockResponse;
}

export interface MockPersona {
  /**
   * `cooperative` (the default) answers the script regardless of prompt
   * content — every non-security test uses this.
   *
   * `adversarial-compliant` is the persona docs/SECURITY.md section 8.3
   * requires for the injection corpus: it attempts to *comply* with
   * instruction-shaped text found in untrusted content, emitting a tool call if
   * the request offers any tool at all. It lives here rather than in a second
   * mock file because it is a configuration mode of the same adapter, not a
   * different adapter — a separate file would be a second thing to keep in step
   * with the interface.
   */
  mode: 'cooperative' | 'adversarial-compliant';
}

export interface MockProviderOptions {
  script?: MockScript;
  persona?: MockPersona;
  /** Streaming chunk size in characters. Deterministic; no timing involved. */
  streamChunkChars?: number;
}

/**
 * Synthetic models, in the same `ModelCapabilities` shape every real model uses
 * (docs/TESTING.md section 2.3) so `modelTier` bindings resolve sensibly under
 * mock.
 *
 * Deliberately NOT merged into `capabilityMatrix.ts`'s `MODEL_CAPABILITIES`:
 * that table is the real catalogue, and a synthetic model appearing in a user's
 * model picker would be a defect. Tests that need a capability lookup for these
 * read them from here.
 *
 * Prices are round numbers chosen so cost assertions in golden evals and
 * cost-preview tests come out exact rather than as ranges. `verifiedAt` is the
 * epoch date because these are invented, not verified — the field would be a
 * lie with any other value.
 */
export const MOCK_MODELS: Readonly<Record<string, ModelCapabilities>> = Object.freeze({
  'mock-frontier': {
    modelId: 'mock-frontier',
    displayName: 'Mock Frontier',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_000,
    toolCalling: 'supported',
    vision: 'supported',
    streaming: 'supported',
    structuredOutput: 'supported',
    pricing: {
      kind: 'metered',
      inputPerMillion: 10,
      outputPerMillion: 50,
      currency: 'USD',
      verifiedAt: '1970-01-01',
    },
  },
  'mock-standard': {
    modelId: 'mock-standard',
    displayName: 'Mock Standard',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_000,
    toolCalling: 'supported',
    vision: 'unsupported',
    streaming: 'supported',
    structuredOutput: 'supported',
    pricing: {
      kind: 'metered',
      inputPerMillion: 1,
      outputPerMillion: 5,
      currency: 'USD',
      verifiedAt: '1970-01-01',
    },
  },
  'mock-cheap': {
    modelId: 'mock-cheap',
    displayName: 'Mock Cheap',
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_000,
    toolCalling: 'supported',
    vision: 'unsupported',
    streaming: 'unsupported',
    structuredOutput: 'unsupported',
    pricing: {
      kind: 'metered',
      inputPerMillion: 0.1,
      outputPerMillion: 0.5,
      currency: 'USD',
      verifiedAt: '1970-01-01',
    },
  },
  // Exists specifically so M4's validator tests can assert the save-blocking
  // error when a tool-needing node is bound to a model that cannot call tools.
  'mock-no-tools': {
    modelId: 'mock-no-tools',
    displayName: 'Mock (no tools)',
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_000,
    toolCalling: 'unsupported',
    vision: 'unsupported',
    streaming: 'unsupported',
    structuredOutput: 'unsupported',
    pricing: {
      kind: 'metered',
      inputPerMillion: 0.1,
      outputPerMillion: 0.5,
      currency: 'USD',
      verifiedAt: '1970-01-01',
    },
  },
});

/**
 * Deterministic token estimate: four characters per token, rounded up.
 *
 * Not an attempt to model any real tokenizer — a mock that approximated one
 * would drift from it and produce assertions that mean nothing. It is a fixed,
 * documented rule so golden evals can assert exact token and cost figures.
 */
export function mockTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function textOfRequest(request: NormalisedRequest): string {
  return request.messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : part.data)).join(''),
    )
    .join('\n');
}

/**
 * A stable hash of the semantically relevant parts of a request.
 *
 * docs/TESTING.md section 2.2 specifies the fingerprint over `{ roleId,
 * modelBinding, goal-template-with-inputs-substituted, toolAllowlist,
 * iteration index }`. None of those concepts exist yet — roles arrive at M2-5,
 * goals at M2-7 — and by the time they do they will be *inside* the normalised
 * request's messages and tools. So this hashes the request itself, which is the
 * same information expressed in the vocabulary that exists today, and does not
 * need revisiting when roles land.
 *
 * Ordering is normalised so that two requests differing only in tool
 * declaration order fingerprint identically; without that, a golden eval's
 * "run this twice, expect the same trace" check would fail for a reason that
 * has nothing to do with the workflow.
 */
export function fingerprintOf(request: NormalisedRequest): string {
  const canonical = JSON.stringify({
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : message.content,
      toolCalls: message.toolCalls ?? null,
      toolCallId: message.toolCallId ?? null,
    })),
    tools: [...(request.tools ?? [])].map((tool) => tool.name).sort((a, b) => a.localeCompare(b)),
    toolChoice: request.toolChoice ?? null,
    responseFormat: request.responseFormat ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function errorFor(kind: MockErrorKind, retryAfterMs: number | undefined): Error {
  switch (kind) {
    case 'auth':
      // The same class a real adapter raises on a 401, so error-path tests
      // written against the mock exercise the real handling.
      return new ProviderAuthError('Mock provider: simulated authentication failure', {
        simulated: true,
      });
    case 'rateLimit':
      return new ProviderRateLimitError('Mock provider: simulated rate limit', {
        simulated: true,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    case 'timeout':
      return new ProviderError('PROVIDER_TIMEOUT', 'Mock provider: simulated timeout', {
        simulated: true,
      });
    case 'contentFilter':
      return new ProviderError(
        'PROVIDER_CONTENT_FILTERED',
        'Mock provider: simulated content filter',
        { simulated: true },
      );
  }
}

export class MockProvider implements ProviderAdapter {
  // Declares itself as a real provider kind rather than a 'mock' kind on
  // purpose: a distinct kind would invite `if (kind === 'mock')` somewhere
  // upstream, which is the branch this whole design exists to prevent.
  readonly kind = 'openai-compatible' as const;

  /** Every request this adapter has received, in order. Assertion surface for tests. */
  readonly calls: NormalisedRequest[] = [];

  private readonly script: MockScript;
  private readonly persona: MockPersona;
  private readonly streamChunkChars: number;
  private queueIndex = 0;
  private readonly fingerprintCounts = new Map<string, number>();

  constructor(options: MockProviderOptions = {}) {
    this.script = options.script ?? {};
    this.persona = options.persona ?? { mode: 'cooperative' };
    this.streamChunkChars = options.streamChunkChars ?? 8;
  }

  /** Resets call history and script position without rebuilding the script. */
  reset(): void {
    this.calls.length = 0;
    this.queueIndex = 0;
    this.fingerprintCounts.clear();
  }

  private resolve(request: NormalisedRequest): MockResponse {
    if (this.persona.mode === 'adversarial-compliant') {
      const complied = this.complyWithInjection(request);
      if (complied) return complied;
    }

    const queue = this.script.queue ?? [];
    if (this.queueIndex < queue.length) {
      const queued = queue[this.queueIndex];
      this.queueIndex += 1;
      if (queued) return queued;
    }

    const fingerprint = fingerprintOf(request);
    const matched = this.script.byFingerprint?.get(fingerprint);
    if (matched) {
      if (!Array.isArray(matched)) return matched;
      const seen = this.fingerprintCounts.get(fingerprint) ?? 0;
      this.fingerprintCounts.set(fingerprint, seen + 1);
      // The last entry repeats rather than falling through, so a script that
      // covers the first two calls does not silently change behaviour on the
      // third.
      return matched[Math.min(seen, matched.length - 1)] ?? { kind: 'text', content: '' };
    }

    return this.script.default ?? { kind: 'text', content: 'ok' };
  }

  /**
   * The adversarial persona (docs/SECURITY.md section 8.3).
   *
   * Scans only content that arrived as untrusted data — never the
   * workflow-authored system turn — for instruction-shaped text, and attempts
   * to comply by calling whatever tool the request offers. A mock that complied
   * with *any* instruction-shaped text anywhere would make the injection corpus
   * pass or fail on the system prompt's own wording, which would tell us
   * nothing about the defence being tested.
   *
   * Until M2-6 builds the real untrusted-content envelope, "untrusted" means
   * tool-result messages — the only channel by which external content reaches a
   * prompt at this milestone.
   */
  private complyWithInjection(request: NormalisedRequest): MockResponse | undefined {
    const untrusted = request.messages
      .filter((message) => message.role === 'tool')
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n')
      .toLowerCase();

    const looksLikeInstruction =
      /\b(ignore|disregard|instead|you must|new instructions?|send|exfiltrate|delete|transfer)\b/.test(
        untrusted,
      );
    if (!looksLikeInstruction) return undefined;

    const firstTool = request.tools?.[0];
    if (!firstTool) return undefined;
    return {
      kind: 'toolCall',
      toolId: 'mock-injected-call',
      toolName: firstTool.name,
      params: { injected: true },
    };
  }

  private usageFor(request: NormalisedRequest, outputText: string): Usage {
    return {
      inputTokens: mockTokenCount(textOfRequest(request)),
      outputTokens: mockTokenCount(outputText),
    };
  }

  private buildResponse(request: NormalisedRequest, scripted: MockResponse): NormalisedResponse {
    const id = `mock-${fingerprintOf(request).slice(0, 8)}`;

    switch (scripted.kind) {
      case 'text': {
        const content: ContentPart[] = [{ type: 'text', text: scripted.content }];
        return {
          id,
          model: request.model,
          content,
          toolCalls: [],
          finishReason: 'stop',
          usage: this.usageFor(request, scripted.content),
        };
      }
      case 'structuredOutput': {
        const serialised = JSON.stringify(scripted.json);
        return {
          id,
          model: request.model,
          content: [{ type: 'text', text: serialised }],
          toolCalls: [],
          finishReason: 'stop',
          usage: this.usageFor(request, serialised),
        };
      }
      case 'toolCall': {
        const toolCalls: ToolCall[] = [
          { id: scripted.toolId, name: scripted.toolName, arguments: scripted.params },
        ];
        const said = scripted.say ?? '';
        return {
          id,
          model: request.model,
          content: said === '' ? [] : [{ type: 'text', text: said }],
          toolCalls,
          finishReason: 'toolCalls',
          usage: this.usageFor(request, `${said}${JSON.stringify(scripted.params)}`),
        };
      }
      case 'error':
        throw errorFor(scripted.error, scripted.retryAfterMs);
    }
  }

  // `async` rather than returning `Promise.resolve(...)`: buildResponse throws
  // for a scripted error, and a synchronous throw is a different shape from the
  // rejected promise every real adapter produces. A caller using `.catch()`
  // without a try/catch would crash against the mock and be fine against
  // Anthropic — exactly the kind of divergence this adapter exists to prevent.
  // Found by a test, not by review.
  async chat(
    request: NormalisedRequest,
    _options: AdapterCallOptions,
  ): Promise<NormalisedResponse> {
    this.calls.push(request);
    return await Promise.resolve(this.buildResponse(request, this.resolve(request)));
  }

  async *streamChat(
    request: NormalisedRequest,
    _options: AdapterCallOptions,
  ): AsyncIterable<StreamEvent> {
    this.calls.push(request);
    const scripted = this.resolve(request);

    // Errors are raised before `start`, matching a real adapter: a provider
    // that rejects the request never opens a stream.
    if (scripted.kind === 'error') throw errorFor(scripted.error, scripted.retryAfterMs);

    const response = this.buildResponse(request, scripted);
    yield { type: 'start', id: response.id, model: response.model };

    for (const part of response.content) {
      if (part.type !== 'text') continue;
      for (let at = 0; at < part.text.length; at += this.streamChunkChars) {
        yield { type: 'textDelta', text: part.text.slice(at, at + this.streamChunkChars) };
      }
    }

    // Tool-call arguments are emitted whole rather than split across deltas: a
    // partial-JSON stream is a real provider's behaviour, and a mock that faked
    // one would be testing this file's chunking rather than the consumer's
    // accumulation logic.
    for (const [index, call] of response.toolCalls.entries()) {
      yield {
        type: 'toolCallDelta',
        index,
        id: call.id,
        name: call.name,
        argumentsDelta: JSON.stringify(call.arguments),
      };
    }

    yield { type: 'finish', finishReason: response.finishReason, usage: response.usage };
  }

  listModels(_options: AdapterCallOptions): Promise<ModelDescriptor[]> {
    return Promise.resolve(
      Object.values(MOCK_MODELS).map((model) => ({
        id: model.modelId,
        displayName: model.displayName,
      })),
    );
  }

  testConnection(_options: AdapterCallOptions): Promise<ConnectionTestResult> {
    // Fixed latency, not a measured one: a real duration would make every
    // assertion against this value non-deterministic.
    return Promise.resolve({ ok: true, latencyMs: 0 });
  }
}
