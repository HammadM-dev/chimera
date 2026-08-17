// TencentDB Agent Memory, when it is running.
//
// Tencent's open-source (MIT) memory hub for agents: a four-tier pyramid
// (conversation → atom → scenario → persona) over local SQLite with sqlite-vec,
// reached over an MCP-shaped HTTP API at `/v3/tools/list` and `/v3/tools/call`,
// on port 8125 by default.
//
// Detected rather than required, exactly like OmniRoute. CHIMERA does not
// install it, does not start it, and works without it — a memory system that
// stops working when a service is down is worse than a simple one that does
// not, and this is the tier every agent writes to.

export const TENCENTDB_DEFAULT_URL = 'http://localhost:8125';

export interface TencentDbStatus {
  available: boolean;
  baseUrl: string;
  /** Tool names it advertises, when it answered. */
  tools: string[];
  detail: string;
}

function baseUrl(): string {
  const override = process.env['CHIMERA_TENCENTDB_URL'];
  return override !== undefined && override !== '' ? override : TENCENTDB_DEFAULT_URL;
}

/**
 * Asks whether it is there.
 *
 * Never throws: "not installed" is the normal answer for almost everyone, and
 * the correct response to it is to carry on with local memory, not to surface
 * a failure the user cannot act on and did not ask about.
 */
export async function detectTencentDb(url = baseUrl()): Promise<TencentDbStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 4_000);

  try {
    const response = await fetch(`${url}/v3/tools/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        available: false,
        baseUrl: url,
        tools: [],
        detail: `HTTP ${String(response.status)}`,
      };
    }

    const payload = (await response.json()) as { tools?: { name?: unknown }[] };
    const tools = (payload.tools ?? [])
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === 'string');

    return {
      available: tools.length > 0,
      baseUrl: url,
      tools,
      detail: tools.length > 0 ? '' : 'answered but advertised no tools',
    };
  } catch (err) {
    return {
      available: false,
      baseUrl: url,
      tools: [],
      detail: err instanceof Error && err.name === 'AbortError' ? 'no answer' : 'not running',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Calls one of its tools. Shaped like MCP because its API is. */
export async function callTencentDb(
  name: string,
  args: Record<string, unknown>,
  url = baseUrl(),
): Promise<string> {
  const response = await fetch(`${url}/v3/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  });
  if (!response.ok)
    throw new Error(`TencentDB Agent Memory returned HTTP ${String(response.status)}`);

  const payload = (await response.json()) as { content?: { type?: string; text?: string }[] };
  return (payload.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
}
