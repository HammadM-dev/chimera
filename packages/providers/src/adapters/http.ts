import { ProviderAuthError, ProviderError, ProviderRateLimitError } from '@chimera/errors';
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
export function scrub(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    scrubbed = scrubbed.split(secret).join('[redacted]');
    // Also the percent-encoded form, since a key in a URL is encoded.
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) scrubbed = scrubbed.split(encoded).join('[redacted]');
  }
  return scrubbed;
}

/**
 * Maps an HTTP failure onto the shared error taxonomy.
 *
 * `body` is the provider's own error text, included because a message like
 * "model not found: gpt-5-turbo" is the entire diagnostic value of the failure
 * — but it is scrubbed first, because some providers echo the request back.
 */
export function errorForStatus(
  provider: string,
  status: number,
  headers: Headers,
  body: string,
  secrets: readonly string[] = [],
): Error {
  const detail = scrub(body, secrets).slice(0, 500);
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
  try {
    response = await options.transport.fetch(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(options.body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    // A transport failure is not a provider failure — surface it as one
    // typed error rather than letting a raw TypeError from fetch escape.
    if (err instanceof Error && err.name === 'AbortError') throw err;
    const raw = err instanceof Error ? err.message : String(err);
    // A fetch failure message can contain the request URL, and Google's URL
    // carries the API key.
    const message = scrub(raw, options.secrets ?? []);
    throw new ProviderError(
      'PROVIDER_UNREACHABLE',
      `Could not reach ${options.provider}: ${message}`,
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
  try {
    response = await options.transport.fetch(options.url, {
      method: 'GET',
      headers: options.headers,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    const message = scrub(err instanceof Error ? err.message : String(err), options.secrets ?? []);
    throw new ProviderError(
      'PROVIDER_UNREACHABLE',
      `Could not reach ${options.provider}: ${message}`,
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
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw invalidResponse(options.provider, 'body was not valid JSON');
  }
}

export async function postJson<T>(options: PostOptions): Promise<T> {
  const response = await send(options);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw invalidResponse(options.provider, 'body was not valid JSON');
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
