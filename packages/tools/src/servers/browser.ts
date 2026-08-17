import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolExecutionError } from '@chimera/errors';
import { assertEgressAllowed, isHostAllowed } from './http.ts';

// M6-2 and M6-3. Navigate, read, click, type, extract, screenshot — the six
// things "control my computer" turns out to mean for most businesses.
//
// Everything a page returns is untrusted. It is somebody else's text, arriving
// through a tool, and CLAUDE.md's rule about tool output applies to it exactly
// as it applies to a file or an API response: it is data, it is labelled, and
// it never reaches the instruction position of a prompt.

/** The slice of a Playwright page this server needs. Injected so a test can drive it. */
export interface BrowserPage {
  goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  innerText(selector: string): Promise<string>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  screenshot(options?: { fullPage?: boolean; type?: 'png' }): Promise<Buffer>;
  /**
   * Playwright's DOM query. The function is serialised into the page, so it is
   * typed against the shape we use rather than the DOM's `Element` — this
   * package has no `dom` lib, deliberately: nothing else in it touches a
   * browser API, and widening the lib to satisfy one signature would let DOM
   * globals compile everywhere else in the package by accident.
   */
  $$eval<T>(selector: string, fn: (elements: PageElement[]) => T): Promise<T>;
  on(event: 'framenavigated', handler: (frame: { url(): string }) => void): void;
  /**
   * Request interception, where the page has it.
   *
   * This is the enforcement point docs/SECURITY.md asks for — "before DNS
   * resolution/connection is attempted". Watching navigation events tells you a
   * disallowed host was contacted; aborting the request means it never was.
   */
  route?(pattern: string, handler: (route: PageRoute) => void): Promise<void>;
}

export interface PageResponse {
  headers(): Record<string, string>;
}

/**
 * Written with method syntax on purpose.
 *
 * These describe the shape of Playwright's own `Route` well enough to use it
 * without importing it — `packages/tools` must not depend on the browser
 * package, since every other server in it works without one. Method signatures
 * are checked bivariantly, which is what lets the real `Route` satisfy this
 * without the two type definitions having to agree in every parameter.
 */
export interface PageRoute {
  request(): { url(): string };
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
  /** Performs the request without following redirects, so each hop is seen. */
  fetch?(options?: { maxRedirects?: number }): Promise<PageResponse>;
  fulfill?(options: { response: PageResponse }): Promise<void>;
}

export interface BrowserServerOptions {
  /** Resolves the page for this run. Launching is the profile manager's business. */
  page: () => Promise<BrowserPage>;
  /** `policy.egressAllowlist` from the workflow. Empty means the browser goes nowhere. */
  egressAllowlist: readonly string[];
  /** Where screenshots are written. One per call, named for the run. */
  screenshotSink?: (png: Buffer) => Promise<string> | string;
  /** How long a click or a fill waits for its element. */
  actionTimeoutMs?: number;
}

/** What the extract tool reads off an element, and all it reads. */
export interface PageElement {
  textContent: string | null;
}

/** Page text longer than this is truncated rather than fed whole into a prompt. */
const MAX_TEXT_CHARS = 40_000;

const errorResult = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true as const,
});

const textResult = (text: string) => ({
  content: [{ type: 'text' as const, text }],
});

/**
 * Watches for navigation that leaves the allowlist.
 *
 * A check on `goto` alone is a check a redirect walks straight past: a page on
 * an allowed host answering 302 to somewhere else would move the browser
 * before anything looked again. Every frame navigation is checked, and one that
 * lands outside the allowlist is recorded so the next tool call refuses rather
 * than reading a page nobody authorised.
 */
function watchNavigation(
  page: BrowserPage,
  allowlist: readonly string[],
): { breach: () => string } {
  let breached = '';

  const hostOf = (url: string): string | null => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed.hostname;
    } catch {
      return null;
    }
  };

  // Every request, not just the page's own navigation: a redirect, an iframe,
  // an XHR and a script are all ways off the allowlist, and aborting is the
  // difference between "we noticed" and "it never left".
  void page.route?.('**/*', (route) => {
    void (async () => {
      const url = route.request().url();
      const host = hostOf(url);
      if (host !== null && !isHostAllowed(host, allowlist)) {
        breached = host;
        await route.abort('blockedbyclient');
        return;
      }

      // Redirects are the bypass a naive check walks past: the browser follows
      // them itself, so a handler that just continued would never see the
      // second hop. Fetching with `maxRedirects: 0` makes every hop a request
      // this handler is asked about — the `Location` is inspected here, and a
      // disallowed one is refused before anything goes to that host.
      if (!route.fetch || !route.fulfill) {
        await route.continue();
        return;
      }

      try {
        const response = await route.fetch({ maxRedirects: 0 });
        const location = response.headers()['location'];
        if (location !== undefined && location !== '') {
          const nextHost = hostOf(new URL(location, url).toString());
          if (nextHost !== null && !isHostAllowed(nextHost, allowlist)) {
            breached = nextHost;
            await route.abort('blockedbyclient');
            return;
          }
        }
        await route.fulfill({ response });
      } catch {
        // A request this handler could not perform is one the page does not
        // get. Failing open here would undo the whole check.
        await route.abort('failed');
      }
    })();
  });

  page.on('framenavigated', (frame) => {
    const url = frame.url();
    if (url === 'about:blank' || url === '') return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      if (!isHostAllowed(parsed.hostname, allowlist)) breached = parsed.hostname;
    } catch {
      // An unparseable URL is not a host we can vouch for either.
      breached = url;
    }
  });

  return { breach: () => breached };
}

export function createBrowserServer(options: BrowserServerOptions): McpServer {
  const server = new McpServer({ name: 'chimera-browser', version: '0.0.0' });
  const timeout = options.actionTimeoutMs ?? 15_000;
  const watchers = new WeakMap<BrowserPage, { breach: () => string }>();

  /** The page, with a navigation watcher attached exactly once. */
  const pageFor = async (): Promise<{ page: BrowserPage; breach: () => string }> => {
    const page = await options.page();
    let watcher = watchers.get(page);
    if (!watcher) {
      watcher = watchNavigation(page, options.egressAllowlist);
      watchers.set(page, watcher);
    }
    return { page, breach: watcher.breach };
  };

  /**
   * Refuses to act on a page that has wandered off the allowlist.
   *
   * Checked before every tool, not only after navigation: whatever moved the
   * browser — a redirect, a meta refresh, a script — the next thing an agent
   * does must not be done on a page nobody authorised.
   */
  const assertOnAllowedPage = (page: BrowserPage, breach: string): void => {
    if (breach !== '') {
      throw new ToolExecutionError(
        `The page navigated to "${breach}", which is not in this workflow's egress allowlist. Nothing further will run against it.`,
        { host: breach, allowlist: [...options.egressAllowlist] },
      );
    }

    const current = page.url();
    if (current === 'about:blank' || current === '') return;
    try {
      const parsed = new URL(current);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      if (!isHostAllowed(parsed.hostname, options.egressAllowlist)) {
        throw new ToolExecutionError(
          `The browser is on "${parsed.hostname}", which is not in this workflow's egress allowlist.`,
          { host: parsed.hostname, allowlist: [...options.egressAllowlist] },
        );
      }
    } catch (err) {
      if (err instanceof ToolExecutionError) throw err;
    }
  };

  const guarded = async (
    run: (page: BrowserPage) => Promise<{ content: { type: 'text'; text: string }[] }>,
  ) => {
    try {
      const { page, breach } = await pageFor();
      assertOnAllowedPage(page, breach());
      return await run(page);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };

  server.registerTool(
    'navigate',
    {
      description: 'Opens a page. Only hosts in the workflow egress allowlist can be reached.',
      inputSchema: { url: z.string() },
    },
    async ({ url }) => {
      try {
        // Checked before the browser is asked to move, so a refused host is one
        // the browser never contacted — DNS included.
        const target = assertEgressAllowed(url, options.egressAllowlist);
        const { page, breach } = await pageFor();
        await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });
        assertOnAllowedPage(page, breach());
        return textResult(`Opened ${page.url()} — ${await page.title()}`);
      } catch (err) {
        // A navigation that was aborted for leaving the allowlist reports
        // itself as a network error, which tells the agent nothing. Where the
        // watcher knows the host, it says the host.
        const { breach } = await pageFor();
        const host = breach();
        if (host !== '') {
          return errorResult(
            `That page redirected to "${host}", which is not in this workflow's egress allowlist. The request was blocked before it left.`,
          );
        }
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'read',
    {
      description: 'Reads the visible text of the page, or of one part of it.',
      inputSchema: { selector: z.string().default('body') },
    },
    async ({ selector }) =>
      guarded(async (page) => {
        const text = await page.innerText(selector === '' ? 'body' : selector);
        return textResult(
          text.length > MAX_TEXT_CHARS
            ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated: the page is longer than this tool will read]`
            : text,
        );
      }),
  );

  server.registerTool(
    'click',
    {
      description: 'Clicks something on the page.',
      inputSchema: { selector: z.string() },
    },
    async ({ selector }) =>
      guarded(async (page) => {
        await page.click(selector, { timeout });
        return textResult(`Clicked ${selector}. The page is now ${page.url()}`);
      }),
  );

  server.registerTool(
    'type',
    {
      description: 'Types into a field, replacing whatever was there.',
      inputSchema: { selector: z.string(), text: z.string() },
    },
    async ({ selector, text }) =>
      guarded(async (page) => {
        await page.fill(selector, text, { timeout });
        // The value is not echoed back: a password typed into a login form
        // would otherwise be in the trace in plain text, which is precisely
        // what CLAUDE.md's secrets rule exists to prevent.
        return textResult(`Typed ${String(text.length)} characters into ${selector}.`);
      }),
  );

  server.registerTool(
    'extract',
    {
      description:
        'Pulls the text of every element matching a selector — a table column, a list of results.',
      inputSchema: {
        selector: z.string(),
        limit: z.number().int().positive().max(500).default(100),
      },
    },
    async ({ selector, limit }) =>
      guarded(async (page) => {
        // `$$eval` is Playwright's DOM query — it runs the *fixed* function
        // below inside the page, and nothing model-supplied is ever executed.
        // The agent chooses the selector, which is a query, not code.
        const rows = await page.$$eval(selector, (elements: PageElement[]) =>
          elements.map((element) => (element.textContent ?? '').trim()),
        );
        const kept = rows.slice(0, limit ?? 100);
        return textResult(
          kept.length === 0
            ? `Nothing on the page matches ${selector}.`
            : JSON.stringify(kept, null, 2),
        );
      }),
  );

  server.registerTool(
    'screenshot',
    {
      description: 'Takes a picture of the page, for the run trace.',
      inputSchema: { fullPage: z.boolean().default(false) },
    },
    async ({ fullPage }) =>
      guarded(async (page) => {
        const png = await page.screenshot({ fullPage: fullPage ?? false, type: 'png' });
        if (!options.screenshotSink) {
          return textResult(
            `Screenshot taken (${String(png.length)} bytes), but this run has nowhere to keep it.`,
          );
        }
        const reference = await options.screenshotSink(png);
        // The reference, not the bytes: a base64 PNG in the observation would
        // be tens of thousands of tokens of noise in the next prompt.
        return textResult(`Screenshot saved as ${reference}`);
      }),
  );

  return server;
}
