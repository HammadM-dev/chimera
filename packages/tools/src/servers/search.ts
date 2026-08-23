import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpTransport } from './http.ts';

// Web search.
//
// Until this existed, an agent could fetch a page and could not find one. The
// researcher's whole job — "answer this from what is out there" — was only
// possible if a person had already worked out which URLs to read and typed them
// into the instruction, which is the research done by hand with the agent left
// to do the reading. It is the difference the product is for.
//
// Search is deliberately a *separate server* from `http`, with its own tool id,
// rather than a mode of `http.request`. Two reasons: a role can be granted the
// ability to find things without being granted the ability to send anything
// anywhere, and the egress rules below are genuinely different — a query goes
// to one of a handful of engines this file names, never to a host the model
// chose, so there is no SSRF surface here at all.

/** Where a query may go. Fixed in code: the model never names the host. */
interface Engine {
  id: string;
  /** Builds the query URL. */
  url: (query: string, region: string) => string;
  /** Pulls results out of the returned markup. */
  parse: (html: string) => SearchResult[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Results per query, unless the caller asks for fewer. The user's cap is on the automation. */
export const DEFAULT_MAX_RESULTS = 8;
/** How much of each snippet survives. Enough to judge a result by; not a page. */
const MAX_SNIPPET_CHARS = 300;

/**
 * Encodes a query the way a search form does.
 *
 * `encodeURIComponent` spells a space `%20`, which is correct and which Bing
 * reads as a single-word query: "best selling electric car UK 2026" came back
 * with three dictionary definitions of the word "best". Search engines expect
 * the `application/x-www-form-urlencoded` spelling, where a space is `+`.
 */
function queryParam(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
        rsaquo: '›',
        lsaquo: '‹',
        hellip: '…',
        mdash: '—',
        ndash: '–',
      };
      if (entity.startsWith('#')) {
        const code = entity.startsWith('#x')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : whole;
      }
      return named[entity.toLowerCase()] ?? whole;
    })
    .replace(/&amp;/g, '&');
}

/**
 * Mojeek: an independent index, and the one engine tried here that answers a
 * plain request without a bot challenge.
 *
 * Its results carry the destination URL directly rather than a tracking
 * redirect, which is why it is first: nothing has to be un-wrapped, so there is
 * nothing to un-wrap wrongly.
 */
const MOJEEK: Engine = {
  id: 'mojeek',
  url: (query, region) =>
    `https://www.mojeek.com/search?q=${queryParam(query)}${
      region === '' ? '' : `&reg=${encodeURIComponent(region)}`
    }`,
  parse: (html) =>
    parseBlocks(html, /<li[\s>]/i, {
      skipUrl: /\bmojeek\.com|buttondown/i,
      snippet: /<p\b[^>]*class="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
    }),
};

/**
 * Pulls title, link and snippet out of one engine's result blocks.
 *
 * Shared because both engines lay a result out the same way and both have the
 * same trap in them: the *first* anchor in a block is the grey citation line
 * ("bankofengland.co.uk › monetary-policy › ..."), and the title is the one
 * inside the `<h2>`. Reading the first anchor produced results titled with
 * their own breadcrumb — and, on Mojeek, none at all, because the guard against
 * that discarded the whole block rather than looking one anchor further.
 */
function parseBlocks(
  html: string,
  splitOn: RegExp,
  patterns: { skipUrl: RegExp; snippet: RegExp },
): SearchResult[] {
  const results: SearchResult[] = [];

  for (const block of html.split(splitOn).slice(1)) {
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1] ?? block;
    const link = /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(heading);
    if (!link?.[1] || !link[2]) continue;

    const url = unwrapBing(decodeEntities(link[1]));
    if (!/^https?:\/\//i.test(url) || patterns.skipUrl.test(url)) continue;

    const title = stripTags(link[2]);
    // A "title" that is just the URL again is the citation line, not a title.
    if (title === '' || /^https?:\/\//i.test(title)) continue;

    const snippet = stripTags(patterns.snippet.exec(block)?.[1] ?? '');
    if (results.some((existing) => existing.url === url)) continue;
    results.push({ title, url, snippet: snippet.slice(0, MAX_SNIPPET_CHARS) });
  }

  return results;
}

/**
 * Bing, as the fallback, with its redirect wrapper undone.
 *
 * Every result URL arrives as `bing.com/ck/a?...&u=a1<base64>`. Left wrapped,
 * the agent's next `http.request` would fetch a redirect page and read nothing,
 * so a fallback that returned them verbatim would look like it worked and
 * wouldn't.
 */
const BING: Engine = {
  id: 'bing',
  url: (query, region) =>
    `https://www.bing.com/search?q=${queryParam(query)}${
      region === '' ? '' : `&cc=${encodeURIComponent(region)}`
    }`,
  parse: (html) =>
    parseBlocks(html, /<li class="b_algo/i, {
      skipUrl: /\bbing\.com|\bmicrosoft\.com\/[a-z-]+\/bing/i,
      snippet: /<p\b[^>]*>([\s\S]*?)<\/p>/i,
    }),
};

export function unwrapBing(url: string): string {
  if (!/bing\.com\/ck\/a/i.test(url)) return url;
  const encoded = /[?&]u=a1([^&]+)/.exec(url)?.[1];
  if (encoded === undefined) return url;
  try {
    const normalised = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

/**
 * DuckDuckGo's lite endpoint: a table of rows rather than result cards.
 *
 * Third because it answers a bot challenge from some networks and not others —
 * it was challenge-walled from the machine this was written on and is included
 * anyway, since the point of a fallback chain is that the machines it runs on
 * are not this one.
 */
const DDG_LITE: Engine = {
  id: 'duckduckgo',
  url: (query) => `https://lite.duckduckgo.com/lite/?q=${queryParam(query)}`,
  parse: (html) => {
    const results: SearchResult[] = [];
    const rows = html.split(/<tr\b/i).slice(1);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] ?? '';
      const link = /<a\b[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(
        row,
      );
      if (!link?.[1] || !link[2]) continue;
      const url = decodeEntities(link[1]);
      if (!/^https?:\/\//i.test(url)) continue;
      const title = stripTags(link[2]);
      if (title === '') continue;
      // The snippet sits in the row after the link's, not inside it.
      const snippet = stripTags(
        /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i.exec(rows[index + 1] ?? '')?.[1] ??
          '',
      );
      if (results.some((existing) => existing.url === url)) continue;
      results.push({ title, url, snippet: snippet.slice(0, MAX_SNIPPET_CHARS) });
    }
    return results;
  },
};

/**
 * Tried in order, first usable answer wins.
 *
 * Bing leads on measurement rather than preference: over repeated queries from
 * one machine it kept answering, and Mojeek — which answered first and parses
 * more cleanly — started returning a captcha page after a handful of requests.
 * A captcha parses to zero results, which is why "zero results" moves to the
 * next engine instead of being reported as an empty web.
 */
const ENGINES: readonly Engine[] = [BING, MOJEEK, DDG_LITE];

/**
 * A search API the workspace holds a key for.
 *
 * All three are one GET or POST with the key in a header and JSON back, so they
 * differ only in where the query goes and what the result array is called. When
 * one is configured it is tried first and the scraped engines become its
 * fallback, rather than the other way round.
 */
interface KeyedEngine {
  id: string;
  request: (query: string, key: string, count: number, region: string) => [string, RequestInit];
  parse: (payload: unknown) => SearchResult[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Reads `{results: [{title, url, description|content|snippet}]}` in whatever spelling. */
function readResults(rows: unknown): SearchResult[] {
  if (!Array.isArray(rows)) return [];
  const results: SearchResult[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    const url = asString(record['url'] ?? record['link']);
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: asString(record['title']) || url,
      url,
      snippet: (
        asString(record['description']) ||
        asString(record['content']) ||
        asString(record['snippet'])
      ).slice(0, MAX_SNIPPET_CHARS),
    });
  }
  return results;
}

const KEYED: Record<string, KeyedEngine> = {
  brave: {
    id: 'brave',
    request: (query, key, count, region) => [
      `https://api.search.brave.com/res/v1/web/search?q=${queryParam(query)}&count=${String(count)}${
        region === '' ? '' : `&country=${queryParam(region)}`
      }`,
      { method: 'GET', headers: { accept: 'application/json', 'x-subscription-token': key } },
    ],
    parse: (payload) => readResults(asRecord(asRecord(payload)['web'])['results']),
  },
  tavily: {
    id: 'tavily',
    request: (query, key, count) => [
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: count }),
      },
    ],
    parse: (payload) => readResults(asRecord(payload)['results']),
  },
  serper: {
    id: 'serper',
    request: (query, key, count, region) => [
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({
          q: query,
          num: count,
          ...(region === '' ? {} : { gl: region.toLowerCase() }),
        }),
      },
    ],
    parse: (payload) => readResults(asRecord(payload)['organic']),
  },
};

export interface SearchServerOptions {
  transport?: HttpTransport;
  /** Which keyed API to try first. Absent or `none` means the scraped engines only. */
  provider?: string;
  /**
   * The key for `provider`, already read out of the vault by the caller.
   *
   * Passed as a value because this server makes the request; it is never
   * logged, never returned in a result, and never reaches a prompt.
   */
  apiKey?: string;
  /**
   * The automation's egress mode. Search is a read, so it works under `browse`
   * and `open` and is refused under `allowlist` — an automation locked to named
   * hosts has said it does not want its agents wandering, and finding new hosts
   * is exactly wandering.
   */
  egressMode?: 'allowlist' | 'browse' | 'open';
  /** Default result count for this automation. The caller may ask for fewer. */
  maxResults?: number;
  /** Region hint passed to the engine, e.g. `uk`. Empty means no hint. */
  region?: string;
}

function render(
  results: readonly SearchResult[],
  engine: string,
  query: string,
  keyed: boolean,
): string {
  const lines = results.map(
    (result, index) =>
      `${String(index + 1)}. ${result.title}\n   ${result.url}${
        result.snippet === '' ? '' : `\n   ${result.snippet}`
      }`,
  );
  return [
    `${String(results.length)} results for "${query}" (via ${engine}).`,
    'These are search results, not the pages themselves. Fetch the ones worth reading with http.request.',
    // Said out loud, because a scraped engine decides how much it likes the
    // address you are calling from and sometimes answers a five-word question
    // as though it were the first word. A result with nothing to do with the
    // query is a normal thing to receive here, and an agent that treats every
    // result as relevant will go and read it.
    ...(keyed
      ? []
      : [
          'This is the built-in search, which reads public engines without an account and is not always accurate. Check each result against the query before fetching it, and ignore any that plainly do not match.',
        ]),
    '',
    ...lines,
  ].join('\n');
}

export function createSearchServer(options: SearchServerOptions = {}): McpServer {
  const transport: HttpTransport = options.transport ?? ((url, init) => fetch(url, init));
  const mode = options.egressMode ?? 'browse';
  const server = new McpServer({ name: 'chimera-search', version: '0.0.0' });

  server.registerTool(
    'web',
    {
      description:
        mode === 'allowlist'
          ? 'Searches the web — but this automation is locked to named sites, so search is switched off. Work from the sites the automation names, or say that search needs turning on.'
          : 'Searches the web and returns titles, links and snippets. Use it whenever you need a fact, a page, or a source you were not given: search first, then fetch the promising links with http.request. Ask it a real question, the way you would type it.',
      inputSchema: {
        query: z.string().describe('What to search for, in plain words.'),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('How many results to return.'),
      },
    },
    async ({ query, maxResults }) => {
      const wanted = maxResults ?? options.maxResults ?? DEFAULT_MAX_RESULTS;
      const trimmed = query.trim();
      const region = options.region ?? '';

      if (mode === 'allowlist') {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Search is off for this automation: it may only reach the sites it names. Either work from those, or ask for the automation to be set to browse.',
            },
          ],
          isError: true as const,
        };
      }
      if (trimmed === '') {
        return {
          content: [{ type: 'text' as const, text: 'A search needs a query.' }],
          isError: true as const,
        };
      }

      // Each engine in turn. An engine that answers with nothing usable is a
      // failure to be moved past, not an answer to hand back: "0 results" from
      // a bot challenge and "0 results" from a genuinely empty index look
      // identical to the model, and only one of them means stop looking.
      const tried: string[] = [];

      const keyed = KEYED[options.provider ?? 'none'];
      if (keyed && (options.apiKey ?? '') !== '') {
        try {
          const [url, init] = keyed.request(trimmed, options.apiKey ?? '', wanted, region);
          const response = await transport(url, init);
          if (response.ok) {
            const results = keyed.parse(await response.json()).slice(0, wanted);
            if (results.length > 0) {
              return {
                content: [
                  { type: 'text' as const, text: render(results, keyed.id, trimmed, true) },
                ],
              };
            }
            tried.push(`${keyed.id} (no results)`);
          } else {
            // The status, never the body: a rejected search API echoes the
            // request back, and the request carries the key.
            tried.push(`${keyed.id} (HTTP ${String(response.status)})`);
          }
        } catch {
          // Not the message either, for the same reason.
          tried.push(`${keyed.id} (request failed)`);
        }
      }
      for (const engine of ENGINES) {
        let html: string;
        try {
          const response = await transport(engine.url(trimmed, region), {
            method: 'GET',
            headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
            redirect: 'follow',
          });
          if (!response.ok) {
            tried.push(`${engine.id} (HTTP ${String(response.status)})`);
            continue;
          }
          html = await response.text();
        } catch (err) {
          tried.push(`${engine.id} (${err instanceof Error ? err.message : String(err)})`);
          continue;
        }

        const results = engine.parse(html).slice(0, wanted);
        if (results.length === 0) {
          tried.push(`${engine.id} (no results)`);
          continue;
        }
        return {
          content: [{ type: 'text' as const, text: render(results, engine.id, trimmed, false) }],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `No search engine answered: ${tried.join(', ')}. Try a different wording, or work from what you already have and say that search was unavailable.`,
          },
        ],
        isError: true as const,
      };
    },
  );

  return server;
}
