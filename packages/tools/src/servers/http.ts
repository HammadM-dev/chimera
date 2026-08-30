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
/** Statuses that mean "it is somewhere else now". */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Enough for a site's http→https→www chain, and short of a redirect loop. */
const MAX_REDIRECTS = 5;

export function isPrivateHost(host: string): boolean {
  // WHATWG URL parsing already normalises the decimal, octal, hex and short
  // forms of an IPv4 address — `http://2130706433/` arrives here as
  // "127.0.0.1" — so those need no handling. IPv6 does: it arrives bracketed,
  // and an IPv4 address can be written inside one.
  const target = host.toLowerCase().replace(/^\[|\]$/g, '');

  if (target === '' || target === 'localhost') return true;
  if (target.endsWith('.localhost') || target.endsWith('.internal')) return true;
  if (target.endsWith('.local')) return true;

  if (target.includes(':')) return isPrivateIpv6(target);
  return isPrivateIpv4(target);
}

function isPrivateIpv4(target: string): boolean {
  const parts = target.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => (/^[0-9]{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];

  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local, and the address a cloud instance's metadata
  // service answers on. Reading it is how an SSRF turns into stolen
  // credentials, which makes it the single most important entry here.
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Carrier-grade NAT and the benchmarking range: not the public internet.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(target: string): boolean {
  if (target === '::' || target === '::1') return true;
  // Unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd]/.test(target)) return true;
  if (/^fe[89ab]/.test(target)) return true;

  // An IPv4 address wearing an IPv6 hat. `::ffff:127.0.0.1` is loopback, and
  // Node normalises it to `::ffff:7f00:1`, so both spellings have to be read —
  // this is the form that walked past the first version of this check.
  const mapped = /^::ffff:(.+)$/.exec(target);
  if (!mapped) return false;
  const rest = mapped[1] ?? '';
  if (rest.includes('.')) return isPrivateIpv4(rest);

  const groups = rest.split(':');
  if (groups.length !== 2) return false;
  const high = Number.parseInt(groups[0] ?? '', 16);
  const low = Number.parseInt(groups[1] ?? '', 16);
  if (Number.isNaN(high) || Number.isNaN(low)) return false;
  return isPrivateIpv4(
    [high >> 8, high & 0xff, low >> 8, low & 0xff].map((octet) => String(octet)).join('.'),
  );
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
 * Refuses a name that points somewhere private.
 *
 * The check above reads the address as written, which stops every literal form
 * of it. It does nothing about a name: `intranet.attacker.test` can be an
 * ordinary public hostname with an A record pointing at 169.254.169.254, and a
 * page telling an agent to fetch it is exactly the injection this product
 * expects. So a host reached by browsing is resolved, and refused if what it
 * resolves to is somewhere this automation may not go.
 *
 * A named host skips this: somebody typed it deliberately, and a company whose
 * internal API is on a private address should be able to say so.
 *
 * Known limit, and it is inherent rather than an oversight: the name is
 * resolved here and connected to a moment later, so a record that changes
 * between the two — DNS rebinding — is not covered. Closing that needs the
 * connection itself pinned to the address that was checked, which is a change
 * to how requests are made rather than to how they are authorised. Recorded in
 * docs/SECURITY.md 4.1.
 */
export async function assertResolvesPublic(host: string): Promise<void> {
  const { lookup } = await import('node:dns/promises');
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    // A name that does not resolve is not a name that reaches anything. Let
    // the request fail on its own terms rather than inventing a refusal.
    return;
  }

  const offender = addresses.find((entry) => isPrivateHost(entry.address));
  if (offender) {
    throw new ToolExecutionError(
      `"${host}" resolves to ${offender.address}, an address inside this machine or its local network. Browsing may not reach it. If you meant it, add the host to the automation's allowed sites.`,
      { host, resolved: offender.address },
    );
  }
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

      // Reached by browsing rather than by being named, so where the name
      // actually points matters as much as how it is spelt.
      if (!isHostAllowed(target.hostname, options.egressAllowlist)) {
        try {
          await assertResolvesPublic(target.hostname);
        } catch (err) {
          return {
            content: [
              { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
            ],
            isError: true as const,
          };
        }
      }

      // Redirects are followed, and every hop is checked exactly as the first
      // URL was.
      //
      // They used to be refused outright, with a note telling the agent to
      // re-request the target itself. The security reasoning was right — a 302
      // to a host off the allowlist would carry the request straight past the
      // check just made — but the conclusion was not: almost every real site
      // redirects, so a live research run spent a turn on `status: 308` from
      // motortrend.com and another asking again, and an agent with twelve
      // turns cannot afford two of them per link.
      //
      // Checking each hop keeps the property that mattered: every URL actually
      // fetched has passed the same allowlist and the same public-address
      // check. A redirect that leaves what this automation may reach still
      // stops, and now says so as a refusal rather than as a status code.
      let response = await transport(target.toString(), {
        method: method ?? 'GET',
        headers: headers ?? {},
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
      });

      let hops = 0;
      let reached = target;
      let refusal = '';

      while (REDIRECT_STATUSES.has(response.status) && hops < MAX_REDIRECTS) {
        const location = response.headers.get('location');
        if (location === null || location.trim() === '') break;

        let next: URL;
        try {
          // Resolved against the URL it came from, because Location is
          // routinely a path rather than an address.
          next = assertEgressAllowed(
            new URL(location, reached).toString(),
            options.egressAllowlist,
            options.egressMode ?? 'browse',
            // A redirect is followed as a GET unless it is one of the two that
            // preserve the method, which is what a browser does.
            response.status === 307 || response.status === 308 ? (method ?? 'GET') : 'GET',
          );
        } catch (err) {
          refusal = `\n[redirected to ${location}, which this automation may not reach: ${
            err instanceof Error ? err.message : String(err)
          }]`;
          break;
        }

        if (!isHostAllowed(next.hostname, options.egressAllowlist)) {
          try {
            await assertResolvesPublic(next.hostname);
          } catch (err) {
            refusal =
              `\n[redirected to ${next.toString()}, which resolves somewhere this ` +
              `automation may not reach: ${err instanceof Error ? err.message : String(err)}]`;
            break;
          }
        }

        reached = next;
        hops += 1;
        response = await transport(next.toString(), {
          method: response.status === 307 || response.status === 308 ? (method ?? 'GET') : 'GET',
          headers: headers ?? {},
          ...(body === undefined || !(response.status === 307 || response.status === 308)
            ? {}
            : { body }),
          redirect: 'manual',
        });
      }

      const raw = await response.text();
      // Markup is not information. A page arrives as what it says rather than
      // as what it is made of, which is most of the saving.
      const text = looksLikeHtml(response, raw) ? htmlToText(raw) : raw;
      const cap = options.maxPageChars ?? DEFAULT_MAX_PAGE_CHARS;
      const truncated =
        text.length > cap
          ? `${text.slice(0, cap)}\n[truncated at ${String(cap)} characters — raise the page limit on the automation if more is needed]`
          : text;

      // Where it ended up, when that is not where it was asked to go. An agent
      // that does not know it was redirected cites the URL it asked for.
      const arrival =
        reached.toString() === target.toString() ? '' : `\nfinal url: ${reached.toString()}`;
      const exhausted =
        refusal === '' && REDIRECT_STATUSES.has(response.status) && hops >= MAX_REDIRECTS
          ? `\n[stopped after ${String(MAX_REDIRECTS)} redirects]`
          : '';
      const redirectNote = `${arrival}${refusal}${exhausted}`;

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
