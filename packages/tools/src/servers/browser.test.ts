import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type BrowserContext } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectInProcess } from '../mcpClient.ts';
import { createToolRegistry } from '../toolRegistry.ts';
import { ToolAllowlistError } from '@chimera/errors';
import { createBrowserServer, type BrowserPage } from './browser.ts';

// M6-2 and M6-3, against a real browser and a real page.
//
// The six tools are only meaningfully tested against something that actually
// renders: a fake page proves the arguments were passed on, not that a click
// clicked anything. The egress rules are tested against a real redirect for the
// same reason — the bypass this closes is one a fake could not perform.

let available = true;
try {
  available = fs.existsSync(chromium.executablePath());
} catch {
  available = false;
}
const options = { skip: available ? false : 'the Playwright browser is not installed' };

const PAGE = `<!doctype html><title>Test site</title>
  <h1>Invoices</h1>
  <table><tbody>
    <tr><td class="ref">INV-1</td><td class="amount">120.00</td></tr>
    <tr><td class="ref">INV-2</td><td class="amount">340.00</td></tr>
  </tbody></table>
  <form action="/submitted" method="get">
    <input id="note" name="note" />
    <button id="send" type="submit">Send</button>
  </form>
  <a id="offsite" href="/redirect">Leave</a>`;

async function site(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/redirect') === true) {
      // Off the allowlist, from a page that was on it. The bypass a
      // check-on-navigate-only implementation walks straight past.
      res.writeHead(302, { location: 'http://elsewhere.invalid/', connection: 'close' }).end();
      return;
    }
    if (req.url?.startsWith('/submitted') === true) {
      res.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
      res.end('<!doctype html><title>Sent</title><p id="ok">Thank you</p>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
    res.end(PAGE);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function harness(allowlist: readonly string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-browsertest-'));
  const context: BrowserContext = await chromium.launchPersistentContext(dir, { headless: true });
  const page = (context.pages()[0] ?? (await context.newPage())) as unknown as BrowserPage;

  const shots: Buffer[] = [];
  const tools = createToolRegistry();
  await tools.registerServer(
    'browser',
    await connectInProcess(
      createBrowserServer({
        page: () => Promise.resolve(page),
        egressAllowlist: allowlist,
        screenshotSink: (png) => {
          shots.push(png);
          return `screenshot-${String(shots.length)}.png`;
        },
      }),
    ),
  );

  const role = { id: 'browser-operator', toolAllowlist: ['browser.*'] };
  const call = (tool: string, params: Record<string, unknown>) =>
    tools.invoke(tool, params, { role });
  const callAs = (
    other: { id: string; toolAllowlist: string[] },
    tool: string,
    params: Record<string, unknown>,
  ) => tools.invoke(tool, params, { role: other });

  return {
    call,
    callAs,
    shots,
    page,
    close: async () => {
      await tools.close();
      await context.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test(
  'navigate, read, extract, type, click and screenshot all work on a real page',
  options,
  async () => {
    const server = await site();
    const h = await harness(['127.0.0.1']);

    try {
      const opened = await h.call('browser.navigate', { url: server.origin });
      assert.equal(opened.isError, false);
      assert.match(opened.text, /Test site/);

      const read = await h.call('browser.read', { selector: 'h1' });
      assert.equal(read.text.trim(), 'Invoices');

      const extracted = await h.call('browser.extract', { selector: '.ref', limit: 10 });
      assert.deepEqual(JSON.parse(extracted.text) as string[], ['INV-1', 'INV-2']);

      const typed = await h.call('browser.type', { selector: '#note', text: 'hunter2' });
      // The value is not echoed: a password typed into a login form would
      // otherwise be sitting in the trace in plain text.
      assert.doesNotMatch(typed.text, /hunter2/);
      assert.match(typed.text, /7 characters/);

      const clicked = await h.call('browser.click', { selector: '#send' });
      assert.equal(clicked.isError, false);
      assert.match(h.page.url(), /submitted/);

      const shot = await h.call('browser.screenshot', { fullPage: false });
      assert.match(shot.text, /screenshot-1\.png/);
      assert.equal(h.shots.length, 1);
      // A real PNG, not an empty buffer: the first eight bytes are the signature.
      assert.equal(h.shots[0]?.subarray(1, 4).toString(), 'PNG');
    } finally {
      await h.close();
      await server.close();
    }
  },
);

test('a host outside the allowlist is refused before the browser moves', options, async () => {
  const server = await site();
  const h = await harness(['allowed.example']);

  try {
    const refused = await h.call('browser.navigate', { url: server.origin });
    assert.equal(refused.isError, true);
    // The meaning, not the wording: this refusal names what may be reached
    // and tells the agent not to keep guessing.
    assert.match(refused.text, /not allowed|no allowed sites/);
    // The browser never went: the page is still where it started, so nothing
    // was resolved, connected to, or loaded.
    assert.equal(h.page.url(), 'about:blank');
  } finally {
    await h.close();
    await server.close();
  }
});

test('a redirect off the allowlist is caught, not just the first hop', options, async () => {
  const server = await site();
  const h = await harness(['127.0.0.1']);

  try {
    await h.call('browser.navigate', { url: server.origin });

    // Allowed host, allowed link — and the server answers 302 to somewhere that
    // is not allowed. A check on `goto` alone would have let everything after
    // this run against the page it landed on.
    const followed = await h.call('browser.navigate', { url: `${server.origin}/redirect` });
    assert.equal(followed.isError, true);
    assert.match(followed.text, /elsewhere\.invalid/);

    // And the tools stay refused afterwards rather than reading the page.
    const read = await h.call('browser.read', { selector: 'body' });
    assert.equal(read.isError, true);
    assert.match(read.text, /allowlist/);
  } finally {
    await h.close();
    await server.close();
  }
});

test('a role without browser tools cannot call one', options, async () => {
  const server = await site();
  const h = await harness(['127.0.0.1']);

  try {
    // The same allowlist mechanism every other tool server is subject to —
    // refused by the registry, before the server is reached. No special case
    // for the browser, which is the whole point of the test.
    await assert.rejects(
      () =>
        h.callAs({ id: 'summariser', toolAllowlist: ['memory.recall'] }, 'browser.navigate', {
          url: server.origin,
        }),
      (err: unknown) => err instanceof ToolAllowlistError,
    );

    assert.equal(h.page.url(), 'about:blank');
  } finally {
    await h.close();
    await server.close();
  }
});
