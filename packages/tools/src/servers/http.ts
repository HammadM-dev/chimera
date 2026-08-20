import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolExecutionError } from '@chimera/errors';

// The HTTP tool server, and the first place egress control is implemented
// (F3, CLAUDE.md hard rule 3).
//
// The allowlist is checked here even though the Governor checks it too and the
// workflow validator checked it at save time. That redundancy is deliberate and
// is the pattern docs/ARCHITECTURE.md §7 and docs/SECURITY.md both call for: a
// workflow edited after validation, or a call path nobody anticipated, still
// cannot get a packet out of this process.

/** Injected so a test can prove zero outbound requests, rather than infer it. */
export type HttpTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpServerOptions {
  /**
   * Hosts this run may contact — `policy.egressAllowlist` from the workflow.
   *
   * An entry is either an exact host (`api.example.com`) or one level of
   * wildcard (`*.example.com`, which matches subdomains but not the apex). An
   * empty list means no network access, which is the correct default for a tool
   * server nobody has granted egress to.
   */
  egressAllowlist: readonly string[];
  transport?: HttpTransport;
}

/** Body larger than this is truncated rather than fed whole into a prompt. */
const MAX_BODY_CHARS = 200_000;

export function isHostAllowed(host: string, allowlist: readonly string[]): boolean {
  const target = host.toLowerCase();
  return allowlist.some((entry) => {
    const candidate = entry.toLowerCase().trim();
    if (candidate === '') return false;
    if (candidate.startsWith('*.')) {
      const suffix = candidate.slice(1); // ".example.com"
      // Subdomains only. A wildcard that also matched the apex would silently
      // widen every allowlist entry written by someone who meant subdomains.
      return target.endsWith(suffix) && target.length > suffix.length;
    }
    return target === candidate;
  });
}

/**
 * Parses and authorises a URL, or throws.
 *
 * Exported because `browser.ts` (M6) needs the identical check, and two
 * implementations of one rule is how the two drift apart.
 */
export function assertEgressAllowed(url: string, allowlist: readonly string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolExecutionError(`"${url}" is not a valid URL.`, { url });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // file: would read the disk through a tool that has no sandbox check, and
    // the other schemes are worse.
    throw new ToolExecutionError(
      `Only http and https are permitted; "${parsed.protocol}" is not.`,
      { url, protocol: parsed.protocol },
    );
  }

  if (!isHostAllowed(parsed.hostname, allowlist)) {
    // The message tells the agent what to do next, because otherwise it keeps
    // guessing. An automation with an empty allowlist can reach nothing, and a
    // researcher that was refused one host simply tried another, and another,
    // until it hit the iteration limit — a hundred thousand tokens spent
    // discovering, one host at a time, that the door was locked.
    throw new ToolExecutionError(
      allowlist.length === 0
        ? `This automation has no allowed sites, so no address can be reached and trying another will not help. Say that you need a site added to the automation's allowed sites, and stop.`
        : `"${parsed.hostname}" is not allowed. This automation may only reach: ${allowlist.join(', ')}. Do not try other addresses.`,
      { url, host: parsed.hostname, allowlist: [...allowlist] },
    );
  }
  return parsed;
}

export function createHttpServer(options: HttpServerOptions): McpServer {
  const transport: HttpTransport = options.transport ?? ((url, init) => fetch(url, init));
  const server = new McpServer({ name: 'chimera-http', version: '0.0.0' });

  server.registerTool(
    'request',
    {
      description:
        options.egressAllowlist.length === 0
          ? 'Makes an HTTP request — but this automation has no allowed sites, so every address will be refused. Do not call this tool; say that a site needs adding to the automation.'
          : `Makes an HTTP request. This automation may only reach: ${options.egressAllowlist.join(', ')}.`,
      inputSchema: {
        url: z.string(),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
        headers: z.record(z.string(), z.string()).default({}),
        body: z.string().optional(),
      },
    },
    async ({ url, method, headers, body }) => {
      let target: URL;
      try {
        target = assertEgressAllowed(url, options.egressAllowlist);
      } catch (err) {
        // Refused before the transport is touched at all — the test counts
        // calls to prove it, because "we checked first" is otherwise an
        // untestable claim about ordering.
        return {
          content: [
            { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
          ],
          isError: true as const,
        };
      }

      const response = await transport(target.toString(), {
        method: method ?? 'GET',
        headers: headers ?? {},
        ...(body === undefined ? {} : { body }),
        // Redirects are not followed. A 302 to a host outside the allowlist
        // would otherwise carry the request straight past the check that was
        // just made — the allowlist would hold for the URL the agent asked for
        // and not for the one it actually reached.
        redirect: 'manual',
      });

      const text = await response.text();
      const truncated =
        text.length > MAX_BODY_CHARS
          ? `${text.slice(0, MAX_BODY_CHARS)}\n[truncated at ${String(MAX_BODY_CHARS)} characters]`
          : text;

      const location = response.headers.get('location');
      const redirectNote =
        location === null
          ? ''
          : `\n[redirect to ${location} was not followed — re-request it explicitly if the target is allowlisted]`;

      return {
        content: [
          {
            type: 'text' as const,
            text: `status: ${String(response.status)}${redirectNote}\n\n${truncated}`,
          },
        ],
        ...(response.ok ? {} : { isError: true as const }),
      };
    },
  );

  return server;
}
