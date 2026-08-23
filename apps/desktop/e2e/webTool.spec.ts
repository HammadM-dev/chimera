import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';
import { startStub } from './support/stub.ts';

// The web tool, and the allowlist that is supposed to bound it.
//
// `http.request` is in the Researcher's shipped allowlist and is offered in the
// agent editor as "makes an HTTP request to an allowed host". Whether it works
// had never been asked end to end.

test.describe.configure({ timeout: 240_000 });

/** Something for the agent to fetch. */
async function startSite(): Promise<{ url: string; hits: number; close: () => Promise<void> }> {
  const state = { hits: 0 };
  const server: Server = createServer((_req, res) => {
    state.hits += 1;
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ headline: 'RENEWAL-CLAUSE-FOUND' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/facts.json`,
    get hits() {
      return state.hits;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A gateway that asks for one HTTP request against the given URL. */
async function startGateway(
  target: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let called = false;
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const verdict = body.includes('Has the task been achieved');
      const answer = (): unknown => {
        if (verdict) return { role: 'assistant', content: '{"verified": true, "evidence": "ok"}' };
        if (!called && body.includes('http__request')) {
          called = true;
          return {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'http__request',
                  arguments: JSON.stringify({ url: target, method: 'GET' }),
                },
              },
            ],
          };
        }
        return { role: 'assistant', content: 'Read the page.' };
      };
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          id: 'g-1',
          model: 'claude-haiku-4-5',
          choices: [{ index: 0, message: answer(), finish_reason: 'stop' }],
          usage: { prompt_tokens: 80, completion_tokens: 12 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function runWith(
  sites: string,
  target: string,
  mode: 'allowlist' | 'browse' | 'open' = 'browse',
): Promise<{ trace: string; hits: () => number; done: () => Promise<void> }> {
  const site = await startSite();
  const gateway = await startGateway(target === '' ? site.url : target);
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl } });
  const page = await app.firstWindow();

  await goTo(page, 'providers');
  await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
    timeout: 20_000,
  });
  await page.getByTestId('omniroute-import').click();
  await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  });

  await goTo(page, 'agents');
  await page.getByTestId('agent-add').click();
  await page.getByTestId('agent-name').fill('Fetcher');
  await page.getByTestId('agent-prompt').fill('You read one page and report what it says.');
  await page.getByTestId('agent-tool-http.request').check();
  await page.getByTestId('agent-save').click();
  await expect(page.getByTestId('agent-card-fetcher')).toBeVisible({ timeout: 20_000 });

  await goTo(page, 'build');
  await page.getByTestId('palette-fetcher').click();
  await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
  await page.getByTestId('node-instruction').fill('Fetch the page and say what it says.');
  await page.getByTestId('brief-egress-mode').selectOption(mode);
  await page.getByTestId('brief-sites').fill(sites);
  await page.getByTestId('brief-input').fill('Read the facts page.');
  await expect(page.getByTestId('brief-run')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('brief-run').click();
  await expect(page.getByTestId('run-result')).toBeVisible({ timeout: 180_000 });

  const trace = await page.evaluate(async () => {
    const chimera = (
      window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
    ).chimera;
    const runs = (await chimera.invoke('run:list', {})) as { runs: { id: string }[] };
    const events = (await chimera.invoke('trace:list', { runId: runs.runs[0]?.id ?? '' })) as {
      events: unknown[];
    };
    return JSON.stringify(events);
  });

  return {
    trace,
    hits: () => site.hits,
    done: async () => {
      await app.close();
      removeProfile(profile);
      await gateway.close();
      await site.close();
    },
  };
}

test('browsing cannot wander into this machine, even with nothing named', async () => {
  // Reading the open web needs no list — that rule is exercised against real
  // hostnames in packages/tools/src/egress.test.ts, because a test that must
  // stay offline cannot fetch a public page to prove it.
  //
  // What is worth proving here, end to end, is the other half: the stand-in
  // site is on loopback, and "browse the web" must not mean the things
  // listening on this machine. Named, it is reachable; unnamed, it is not.
  const run = await runWith('', '');
  try {
    expect(run.hits()).toBe(0);
    expect(run.trace).not.toContain('RENEWAL-CLAUSE-FOUND');
    expect(run.trace).toMatch(/inside this machine|local network/);
  } finally {
    await run.done();
  }
});

test('an agent granted the web tool can actually reach an allowed host', async () => {
  const run = await runWith('127.0.0.1', '');
  try {
    expect(run.trace).not.toContain('No tool registered');
    expect(run.trace).toContain('RENEWAL-CLAUSE-FOUND');
    expect(run.hits()).toBe(1);
  } finally {
    await run.done();
  }
});

test('a host that is not on the list is refused, and never contacted', async () => {
  // Allowlist mode: the tightest setting, where the list is the whole rule.
  const run = await runWith('example.com', '', 'allowlist');
  try {
    expect(run.hits()).toBe(0);
    expect(run.trace).not.toContain('RENEWAL-CLAUSE-FOUND');
    // Refused, and on the record as refused — not quietly skipped. The tool
    // was offered and the call was attempted, which is what makes the zero
    // above mean "stopped" rather than "never tried".
    expect(run.trace).toContain('http__request');
    // What the refusal has to convey, rather than the words it uses: which
    // hosts are permitted, and that guessing another will not help.
    expect(run.trace).toMatch(/not allowed|no allowed sites/);
  } finally {
    await run.done();
  }
});

test('search is a tool an agent can actually be given', async () => {
  // Not a test of what a search engine returns — that is somebody else's index
  // on somebody else's day, and `packages/tools/src/servers/search.test.ts`
  // covers the parsing against fixtures.
  //
  // What is worth proving end to end is the thing that has gone wrong before
  // and gives no symptom worth the name: a server built, exported, tested, and
  // registered nowhere. An agent granted a tool from a server that was never
  // registered is not told the tool failed — it is told it has no tools, and
  // then it improvises.
  const stub = await startStub();
  const profile = freshProfile();
  const app = await launchApp({
    profile,
    env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl },
  });

  try {
    const page = await app.firstWindow();

    await goTo(page, 'providers');
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
      timeout: 20_000,
    });
    await page.getByTestId('omniroute-import').click();
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
      timeout: 20_000,
    });

    await goTo(page, 'build');
    await page.getByTestId('palette-add-agent').click();
    await expect(page.getByTestId('agent-editor')).toBeVisible({ timeout: 20_000 });

    // Offered in the list a person picks from, which means the registry knows
    // about it — and described, so they can tell what it is for.
    const searchTool = page.getByTestId('agent-tool-search.web');
    await expect(searchTool).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('agent-tools')).toContainText('Searches the web');

    // And it can be granted, which is the half that a registry listing alone
    // does not prove.
    await searchTool.check();
    await expect(searchTool).toBeChecked();
  } finally {
    await app.close();
    removeProfile(profile);
    await stub.close();
  }
});
