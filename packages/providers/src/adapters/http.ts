import { ProviderAuthError, ProviderError, ProviderRateLimitError, redact } from '@chimera/errors';
import { getSecret, type AuthRef } from '@chimera/store';

// Transport plumbing shared by every real adapter: one HTTP call, one error
// mapping, one SSE reader. Deliberately carries no provider knowledge — an
// adapter passes its own URL, headers, and body in. Sharing the *transport* is
// not the same as sharing provider behaviour, which stays in each adapter.

/**
 * `fetch` is injected rather than reached for globally so tests can supply a
 * fixture response with no network. CLAUDE.md: "never hit a real API in CI" —
 * and a test that could reach the network is a test that will, eventually, on
 * someone's laptop at the wrong moment.
 */
export interface AdapterTransport {
  fetch: typeof globalThis.fetch;
}

export const defaultTransport: AdapterTransport = { fetch: globalThis.fetch };

/**
 * Everything an adapter reaches outside itself, in one injectable bag.
 *
 * `resolveSecret` is here rather than called directly for the same reason
 * `fetch` is: an adapter test that had to write a real key into the OS keychain
 * would skip on any CI runner without a keyring daemon — and a test that skips
 * in CI is not a test that runs in CI, which is what the ticket asks for.
 * Production still resolves through the real vault; only the seam moves.
 */
export interface AdapterDependencies {
  transport: AdapterTransport;
  resolveSecret: (ref: AuthRef) => string | undefined;
}

export const defaultDependencies: AdapterDependencies = {
  transport: defaultTransport,
  resolveSecret: getSecret,
};

function retryAfterMs(headers: Headers): number | undefined {
  const header = headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  // Retry-After is either delta-seconds or an HTTP date. Only the numeric form
  // is handled; a date form returns undefined rather than a wrong number, and
  // the caller falls back to its own backoff.
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * Removes known secrets from text that is about to become an error message.
 *
 * CLAUDE.md: "Secrets never leave the vault. Not into SQLite, not into logs,
 * not into run traces, not into error messages." The earlier version of this
 * file asserted a credential could not reach an error because "the key travels
 * in a header" — which was wrong twice over. Providers echo the request body
 * back in error responses, and Google's API takes the key as a URL query
 * parameter, so a transport failure message can carry it. A test caught it.
 *
 * Scrubbing every candidate rather than reasoning about which paths are safe:
 * the reasoning is what failed last time.
 */
/**
 * How long any one provider call may hang.
 *
 * There was no timeout at all, and a gateway that accepts a connection and then
 * never answers — a real OmniRoute, routing to a provider it has no credential
 * for — left the app waiting on a dead socket and then reporting "body was not
 * valid JSON", which is true and tells the user nothing. Two minutes is longer
 * than any reasonable completion and far shorter than forever.
 */
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * An abort signal that fires on timeout, combined with any caller's own.
 *
 * `timedOut` distinguishes the two reasons this signal can fire, and the
 * difference matters: a caller cancelling a run must propagate untouched, while
 * our own deadline is a transient provider condition that callers should be
 * free to retry. Without the flag both arrive as an abort, the raw
 * `Error('timeout')` escaped as itself, and every retry loop in the product
 * ignored it — `isRetryable` takes a `ProviderError` and this was not one. A
 * swarm that met one slow request gave up on the spot and put the word
 * "timeout" on screen.
 */
export function withTimeout(signal?: AbortSignal): {
  signal: AbortSignal;
  done: () => void;
  readonly timedOut: boolean;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('timeout'));
  }, REQUEST_TIMEOUT_MS);

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else
      signal.addEventListener('abort', () => {
        controller.abort(signal.reason);
      });
  }

  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
    },
    get timedOut() {
      return timedOut;
    },
  };
}

export function scrub(text: string, secrets: readonly string[]): string {
  return redact(text, secrets);
}

/**
 * Maps an HTTP failure onto the shared error taxonomy.
 *
 * `body` is the provider's own error text, included because a message like
 * "model not found: gpt-5-turbo" is the entire diagnostic value of the failure
 * — but it is scrubbed first, because some providers echo the request back.
 */
/**
 * Digs the provider's own sentence out of its error envelope.
 *
 * Every OpenAI-compatible gateway wraps the useful part in at least one layer
 * of JSON, and some in two. Dumping the envelope verbatim is what put
 * `{"error":{"message":"...","type":"api_error","param":null,"code":null}}` on
 * screen where a person was meant to read what went wrong — reported as "a shit
 * ton of brackets", which is exactly what it was.
 *
 * Falls back to the raw body: a message that is hard to read beats no message.
 */
export function providerMessage(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') return '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }

  // Unwrap as far as the nesting goes: `{error: {message}}`, `{error: "..."}`,
  // and bare `{message}` are all in circulation, sometimes from one vendor.
  let node: unknown = parsed;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof node === 'string') return node.trim();
    if (typeof node !== 'object' || node === null) break;
    const record = node as Record<string, unknown>;
    const next = record['message'] ?? record['error'] ?? record['detail'];
    if (next === undefined) break;
    node = next;
  }
  if (typeof node === 'string') return node.trim();
  return trimmed;
}

export function errorForStatus(
  provider: string,
  status: number,
  headers: Headers,
  body: string,
  secrets: readonly string[] = [],
): Error {
  const detail = providerMessage(scrub(body, secrets)).slice(0, 500);

  // A plan limit is not a bad request, whatever status the gateway gives it.
  // The catalogue lists every model the vendor has; the key can run a subset,
  // and nothing says which until you try. Measured on a real Ollama Cloud key:
  // 19 models offered, 6 usable. Somebody picking one of the other 13 has made
  // no mistake and needs to be told what to do, not shown a 400.
  if (/subscription|upgrade for access|requires (?:both )?(?:a )?(?:pro|max|team)/i.test(detail)) {
    return new ProviderError(
      'PROVIDER_MODEL_UNAVAILABLE',
      `${provider} lists this model but will not run it on your current plan. Pick a different model for this step, or upgrade the plan. The provider said: ${detail}`,
      { provider, status, detail },
    );
  }

  if (status === 401 || status === 403) {
    return new ProviderAuthError(`${provider} rejected the credential. Check the API key.`, {
      provider,
      status,
    });
  }
  if (status === 429) {
    const after = retryAfterMs(headers);
    return new ProviderRateLimitError(`${provider} rate limit reached.`, {
      provider,
      status,
      ...(after === undefined ? {} : { retryAfterMs: after }),
    });
  }
  if (status >= 500) {
    return new ProviderError(
      'PROVIDER_SERVER_ERROR',
      `${provider} returned ${String(status)}. Retry, or check the provider's status page.`,
      { provider, status, detail },
    );
  }
  return new ProviderError(
    'PROVIDER_INVALID_REQUEST',
    `${provider} rejected the request (${String(status)}): ${detail}`,
    { provider, status, detail },
  );
}

/** A response that parsed but is not the shape the adapter expects. */
export function invalidResponse(provider: string, why: string): Error {
  return new ProviderError(
    'PROVIDER_INVALID_RESPONSE',
    `${provider} returned a response this adapter could not read: ${why}`,
    { provider },
  );
}

export interface PostOptions {
  transport: AdapterTransport;
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  /**
   * Values that must never appear in an error raised from this call. Every
   * adapter passes the resolved credential; Google also passes it because the
   * key is in its URL.
   */
  secrets?: readonly string[];
}

async function send(options: PostOptions): Promise<Response> {
  let response: Response;
  const timeout = withTimeout(options.signal);
  try {
    response = await options.transport.fetch(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(options.body),
      signal: timeout.signal,
    });
  } catch (err) {
    // Our own deadline, not the caller's cancellation. Typed, so the retry
    // loops can see it for what it is: the provider was slow, which is worth
    // trying again, rather than an unknown error worth giving up on.
    if (timeout.timedOut) {
      throw new ProviderError(
        'PROVIDER_UNREACHABLE',
        `${options.provider} accepted the connection and sent nothing back within ${String(REQUEST_TIMEOUT_MS / 1000)}s.`,
        { provider: options.provider },
      );
    }
    // A transport failure is not a provider failure — surface it as one
    // typed error rather than letting a raw TypeError from fetch escape.
    if (err instanceof Error && err.name === 'AbortError') throw err;
    const raw = err instanceof Error ? err.message : String(err);
    // A fetch failure message can contain the request URL, and Google's URL
    // carries the API key.
    const message = scrub(raw, options.secrets ?? []);
    throw new ProviderError(
      'PROVIDER_UNREACHABLE',
      message === 'timeout' || /aborted|timeout/i.test(message)
        ? `${options.provider} accepted the connection and sent nothing back within ${String(REQUEST_TIMEOUT_MS / 1000)}s. The gateway is running but the model you picked is not answering — check that provider is connected in its dashboard.`
        : `Could not reach ${options.provider}: ${message}`,
      { provider: options.provider },
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw errorForStatus(
      options.provider,
      response.status,
      response.headers,
      text,
      options.secrets ?? [],
    );
  }
  return response;
}

/** A GET, for catalogue endpoints like `/v1/models`. */
export async function getJson<T>(options: Omit<PostOptions, 'body'>): Promise<T> {
  let response: Response;
  const timeout = withTimeout(options.signal);
  try {
    response = await options.transport.fetch(options.url, {
      method: 'GET',
      headers: options.headers,
      signal: timeout.signal,
    });
  } catch (err) {
    // Our own deadline, as above: typed so a caller may retry it.
    if (timeout.timedOut) {
      throw new ProviderError(
        'PROVIDER_UNREACHABLE',
        `${options.provider} did not answer within ${String(REQUEST_TIMEOUT_MS / 1000)}s.`,
        { provider: options.provider },
      );
    }
    if (err instanceof Error && err.name === 'AbortError') throw err;
    const message = scrub(err instanceof Error ? err.message : String(err), options.secrets ?? []);
    throw new ProviderError(
      'PROVIDER_UNREACHABLE',
      message === 'timeout' || /aborted|timeout/i.test(message)
        ? `${options.provider} accepted the connection and sent nothing back within ${String(REQUEST_TIMEOUT_MS / 1000)}s. The gateway is running but the model you picked is not answering — check that provider is connected in its dashboard.`
        : `Could not reach ${options.provider}: ${message}`,
      { provider: options.provider },
    );
  } finally {
    timeout.done();
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw errorForStatus(
      options.provider,
      response.status,
      response.headers,
      text,
      options.secrets ?? [],
    );
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw unreadableBody(options.provider, response, text);
  }
}

/**
 * Says what actually came back.
 *
 * "body was not valid JSON" is true and useless: it does not say what the
 * status was, what content type arrived, or what the first bytes looked like —
 * the three facts that distinguish a gateway's HTML error page from an empty
 * body from a stream sent to a non-streaming endpoint. A real OmniRoute that
 * accepted the connection and answered nothing produced exactly this message,
 * and it sent the user nowhere.
 */
function unreadableBody(provider: string, response: Response, text: string): Error {
  const type = response.headers.get('content-type') ?? 'no content type';
  const opening = text.trim().slice(0, 120);
  const detail =
    text.trim() === ''
      ? 'the body was empty'
      : `the body starts "${opening}${text.length > 120 ? '…' : ''}"`;

  return invalidResponse(
    provider,
    `HTTP ${String(response.status)}, ${type}, and ${detail}. That is not the JSON this endpoint returns — check the model is one your gateway can actually route.`,
  );
}

/**
 * The final object out of an SSE body.
 *
 * A gateway that streams a request which asked not to be streamed is
 * misbehaving, and CHIMERA now says `stream: false` explicitly so it should not
 * happen — but a stream is still readable, and failing on one when the answer
 * is right there would be pedantry the user pays for. The last non-`[DONE]`
 * frame carries the completed message for every OpenAI-shaped gateway.
 */
function fromEventStream(text: string): unknown {
  const frames = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload !== '' && payload !== '[DONE]');

  let merged: Record<string, unknown> | null = null;
  let content = '';

  for (const frame of frames) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(frame) as Record<string, unknown>;
    } catch {
      continue;
    }
    merged = parsed;
    const choices = parsed['choices'];
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as {
        delta?: { content?: unknown };
        message?: { content?: unknown };
      };
      const piece = first.delta?.content ?? first.message?.content;
      if (typeof piece === 'string') content += piece;
    }
  }

  if (merged === null) return null;

  // Reshaped into the non-streaming form the caller expects, with the
  // accumulated text as the message — a delta is not a message.
  const choices = merged['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    merged['choices'] = [
      {
        ...(choices[0] as Record<string, unknown>),
        message: { role: 'assistant', content },
        delta: undefined,
      },
    ];
  }
  return merged;
}

export async function postJson<T>(options: PostOptions): Promise<T> {
  const response = await send(options);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const streamed = text.startsWith('data:') ? fromEventStream(text) : null;
    if (streamed !== null) return streamed as T;
    throw unreadableBody(options.provider, response, text);
  }
}

/**
 * Yields the `data:` payload of each SSE event, skipping comments, blank
 * keep-alives, and the `[DONE]` sentinel.
 *
 * Buffers across chunk boundaries on purpose: a network read can split an event
 * mid-line, and a parser that assumed one chunk equals one event would drop
 * data intermittently under load — the kind of bug that never reproduces
 * locally.
 */
export async function* streamSse(options: PostOptions): AsyncGenerator<string> {
  const response = await send(options);
  if (!response.body) throw invalidResponse(options.provider, 'streaming response had no body');

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');

      if (line === '' || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;

      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      yield data;
    }
  }
}

export function parseSseJson<T>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T;
  } catch {
    // A single unparseable event is not worth failing an otherwise good
    // stream over — providers do emit occasional non-JSON keep-alive frames.
    return undefined;
  }
}
