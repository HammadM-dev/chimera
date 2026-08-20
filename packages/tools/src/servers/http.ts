import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolExecutionError } from '@chimera/errors';
import { htmlToText } from '../html.ts';

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

/**
 * How far this automation may reach.
 *
 * `allowlist` — only the hosts it names. The tightest, and until now the only
 * setting there was, which made an agent whose job is research useless until
 * somebody guessed the right domains in advance.
 *
 * `browse` — read anything public, send only to named hosts. The default,
 * because the two halves carry very different risk. Fetching a page is how
 * research works. A POST is how a contract leaves the building, and an agent
 * that has read a mailbox and can post anywhere is an exfiltration path — one
 * a hostile page will try to talk it into using, which is the attack the
 * untrusted-data envelope exists to survive. Reading the web costs none of that.
 *
 * `open` — anything, anywhere, for an automation that must submit to hosts it
 * cannot name in advance. Chosen deliberately, never by default.
 */
export type EgressMode = 'allowlist' | 'browse' | 'open';

/** Methods that only read. Anything else can change something at the far end. */
const READ_METHODS = ['GET', 'HEAD'];

/**
 * Addresses inside this machine or the network around it.
 *
 * Refused whenever a host is reached by wandering rather than by being named.
 * "Browse the web" must not mean the router's admin page, a cloud instance's
 * metadata endpoint, or whatever is listening on localhost — the classic way an
 * outward-looking fetch becomes an inward-looking one. A host somebody put in
 * the allowlist is always permitted, because they typed it on purpose.
 */
export function isPrivateHost(host: string): boolean {
  const target = host.toLowerCase();
  if (target === 'localhost' || target.endsWith('.localhost') || target.endsWith('.internal')) {
    return true;
  }
  if (target === '::1' || target.startsWith('fc') || target.startsWith('fd')) return true;

  const parts = target.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^[0-9]{1,3}$/.test(part))) return false;
  const [a, b] = parts.map(Number);
  if (a === undefined || b === undefined) return false;
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

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
  /** Defaults to `browse`: read the public web, send only where named. */
  egressMode?: EgressMode;
  /** How much of a page reaches the prompt. Defaults to DEFAULT_MAX_PAGE_CHARS. */
  maxPageChars?: number;
  transport?: HttpTransport;
}

/**
 * How much of a page is read, when the automation does not say otherwise.
 *
 * Was 200,000 and not changeable — about fifty thousand tokens for one page,
 * most of it markup nobody needs. Pages now arrive as text rather than HTML and
 * this is what is left after that. A default, not a rule: an automation reading
 * contracts can raise it, one skimming headlines can drop it.
 */
export const DEFAULT_MAX_PAGE_CHARS = 40_000;

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
 * May this automation be on this host at all?
 *
 * The reading half of the rule, in one place, because the browser asks it from
 * four — a navigation, a redirect, a subresource, and the check before every
 * action — and four copies of a security rule is how three of them end up
 * subtly weaker than the fourth.
 */
export function mayReachHost(
  host: string,
  allowlist: readonly string[],
  mode: EgressMode = 'allowlist',
): boolean {
  if (isHostAllowed(host, allowlist)) return true;
  if (mode === 'allowlist') return false;
  // Reached by wandering, so it has to be out on the internet rather than
  // inside the network this machine sits on.
  return !isPrivateHost(host);
}

/**
 * Parses and authorises a URL, or throws.
 *
 * Exported because `browser.ts` (M6) needs the identical check, and two
 * implementations of one rule is how the two drift apart.
 */
export function assertEgressAllowed(
  url: string,
  allowlist: readonly string[],
  mode: EgressMode = 'allowlist',
  method = 'GET',
): URL {
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

  // A named host is permitted whatever the mode and whatever the method: it is
  // there because somebody put it there.
  if (isHostAllowed(parsed.hostname, allowlist)) return parsed;

  const reading = READ_METHODS.includes(method.toUpperCase());

  if (mode === 'open' || (mode === 'browse' && reading)) {
    // Reached by wandering rather than by being named, so it must be somewhere
    // out on the internet and not inside the network this machine sits on.
    if (isPrivateHost(parsed.hostname)) {
      throw new ToolExecutionError(
        `"${parsed.hostname}" is an address inside this machine or its local network, which this automation may not reach by browsing. If you meant it, add it to the automation's allowed sites.`,
        { url, host: parsed.hostname, mode },
      );
    }
    return parsed;
  }

  // The message says what to do next, because otherwise the agent keeps
  // guessing: a researcher refused one host simply tried another, and another,
  // until it hit the iteration limit — a hundred thousand tokens spent
  // discovering, one host at a time, that the door was locked.
  if (mode === 'browse' && !reading) {
    throw new ToolExecutionError(
      `This automation can read any site but may only send to ones it names${
        allowlist.length === 0 ? ', and it names none' : `: ${allowlist.join(', ')}`
      }. A ${method.toUpperCase()} to "${parsed.hostname}" is refused. Read the page instead, or say that this address needs adding to the automation's allowed sites.`,
      { url, host: parsed.hostname, method, allowlist: [...allowlist] },
    );
  }

  throw new ToolExecutionError(
    allowlist.length === 0
      ? `This automation has no allowed sites, so no address can be reached and trying another will not help. Say that you need a site added to the automation's allowed sites, and stop.`
      : `"${parsed.hostname}" is not allowed. This automation may only reach: ${allowlist.join(', ')}. Do not try other addresses.`,
    { url, host: parsed.hostname, allowlist: [...allowlist] },
  );
}

/**
 * What the agent is told it can reach.
 *
 * Enforcement does not depend on this, but an agent that has not been told
 * either wastes its budget guessing or declines work it could have done — both
 * of which happened before this said anything specific.
 */
function describeReach(options: HttpServerOptions): string {
  const mode = options.egressMode ?? 'browse';
  const named =
    options.egressAllowlist.length === 0
      ? ''
      : ` Named sites: ${options.egressAllowlist.join(', ')}.`;

  if (mode === 'open') return `Makes an HTTP request to any address.${named}`;
  if (mode === 'browse') {
    return `Fetches any public web page with GET or HEAD, so you can research freely. Sending — POST, PUT, PATCH, DELETE — only works for sites this automation names.${named || ' It names none, so nothing can be sent.'}`;
  }
  return options.egressAllowlist.length === 0
    ? 'Makes an HTTP request — but this automation has no allowed sites, so every address will be refused. Do not call this tool; say that a site needs adding to the automation.'
    : `Makes an HTTP request. This automation may only reach: ${options.egressAllowlist.join(', ')}.`;
}

function looksLikeHtml(response: Response, body: string): boolean {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('html')) return true;
  if (type !== '' && !type.includes('text/plain')) return false;
  return /<html|<body|<div|<p[ >]/i.test(body.slice(0, 2_000));
}

export function createHttpServer(options: HttpServerOptions): McpServer {
  const transport: HttpTransport = options.transport ?? ((url, init) => fetch(url, init));
  const server = new McpServer({ name: 'chimera-http', version: '0.0.0' });

  server.registerTool(
    'request',
    {
      description: describeReach(options),
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
        target = assertEgressAllowed(
          url,
          options.egressAllowlist,
          options.egressMode ?? 'browse',
          method ?? 'GET',
        );
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

      const raw = await response.text();
      // Markup is not information. A page arrives as what it says rather than
      // as what it is made of, which is most of the saving.
      const text = looksLikeHtml(response, raw) ? htmlToText(raw) : raw;
      const cap = options.maxPageChars ?? DEFAULT_MAX_PAGE_CHARS;
      const truncated =
        text.length > cap
          ? `${text.slice(0, cap)}\n[truncated at ${String(cap)} characters — raise the page limit on the automation if more is needed]`
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
