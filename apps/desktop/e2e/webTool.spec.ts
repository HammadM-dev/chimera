import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

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
  // The allowlist names somewhere else entirely; the model asks for the site.
  const run = await runWith('example.com', '');
  try {
    expect(run.hits()).toBe(0);
    expect(run.trace).not.toContain('RENEWAL-CLAUSE-FOUND');
    // Refused, and on the record as refused — not quietly skipped. The tool
    // was offered and the call was attempted, which is what makes the zero
    // above mean "stopped" rather than "never tried".
    expect(run.trace).toContain('http__request');
    expect(run.trace).toContain('allowlist');
  } finally {
    await run.done();
  }
});
