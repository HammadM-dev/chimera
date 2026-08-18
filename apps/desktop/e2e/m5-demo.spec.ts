import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// M5-6, the milestone's exit criterion: a batch processed through fan-out on
// budget, with a failure report — plus the two things M5 adds around it, a
// swarm working through the blackboard and tiers making the automation
// portable.
//
// The gateway serves two model ids at different prices, so the blended-cost
// comparison is arithmetic on real rates rather than a placeholder.

const ITEMS = Array.from({ length: 24 }, (_, index) => `row-${String(index + 1)}`);

async function startGateway(): Promise<{
  baseUrl: string;
  modelsUsed: () => string[];
  close: () => Promise<void>;
}> {
  const used: string[] = [];

  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models') === true) {
      // Connection: close on every reply. `fetch` in the main process is
      // undici, which pools sockets; a pooled socket that this server has since
      // dropped surfaces either as "fetch failed" or as a request that hangs
      // until the adapter's two-minute timeout. A test gateway has no reason to
      // keep sockets alive, and the flake is not worth the microseconds.
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          // A cheap model and an expensive one, both with verified prices in
          // the capability matrix, so the comparison has two real rates.
          data: [{ id: 'claude-haiku-4-5' }, { id: 'claude-sonnet-4-6' }],
        }),
      );
      return;
    }
    if (req.url?.startsWith('/v1/chat/completions') !== true) {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const request = JSON.parse(body) as { model: string };
      used.push(request.model);

      const asksForVerdict = body.includes('Has the task been achieved');
      const doomed = body.includes('row-5');
      const content = asksForVerdict
        ? doomed
          ? '{"verified": false, "evidence": "unreadable"}'
          : '{"verified": true, "evidence": "handled"}'
        : doomed
          ? 'I cannot read this one.'
          : 'Handled.';

      // Connection: close on every reply. `fetch` in the main process is
      // undici, which pools sockets; a pooled socket that this server has since
      // dropped surfaces either as "fetch failed" or as a request that hangs
      // until the adapter's two-minute timeout. A test gateway has no reason to
      // keep sockets alive, and the flake is not worth the microseconds.
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          id: 'm5-1',
          model: request.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          // Sized to fit the summariser role's own budget: 24 items at two
          // calls each has to stay inside the 100K tokens that role declares,
          // and a demo that ran out of budget would be testing the Governor
          // rather than the fan-out.
          usage: { prompt_tokens: 500, completion_tokens: 100 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    modelsUsed: () => [...used],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test.setTimeout(300_000);

test('M5 exit: a batch through fan-out on tiers, with a failure report and the saving', async () => {
  const gateway = await startGateway();
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl } });

  try {
    const page = await app.firstWindow();

    await goTo(page, 'providers');
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
      timeout: 15_000,
    });
    await page.getByTestId('omniroute-import').click();
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
      timeout: 15_000,
    });

    // 1. Say what this workspace means by each tier.
    await page.getByTestId('tier-cheap').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page
      .getByTestId('tier-frontier')
      .selectOption({ label: 'OmniRoute · claude-sonnet-4-6' });

    // 2. Build a fan-out whose worker asks for the cheap tier by name.
    await goTo(page, 'build');
    await page.getByTestId('palette-transform').click();
    await page.getByTestId('transform-template').fill(JSON.stringify(ITEMS));

    await page.getByTestId('palette-fanout').click();
    await page.getByTestId('fanout-concurrency').fill('6');
    await page.getByTestId('fanout-max').fill('100');
    await page.getByTestId('fanout-dead-letter').fill('10');

    await page.getByTestId('palette-summariser').click();
    await page.getByTestId('node-model').selectOption('tier:cheap');
    await page.getByTestId('node-instruction').fill('Handle this row.');

    const join = async (from: string, to: string) => {
      await page
        .locator(`[data-testid="${from}"] .react-flow__handle-right`)
        .dragTo(page.locator(`[data-testid="${to}"] .react-flow__handle-left`));
    };
    await join('node-transform', 'node-fanout');
    await join('node-fanout', 'node-summariser');

    await page.getByTestId('brief-input').fill('Handle every row.');
    await page.getByTestId('brief-name').fill('Batch');

    // The step is bound to a tier rather than a model, and that is enough.
    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();

    await expect(page.getByTestId('node-fanout')).toContainText(/succeeded|denied/, {
      timeout: 240_000,
    });
    // The run as a whole, not just the node: a graph whose last step is a
    // fan-out still has to report that it finished. Given a generous window
    // because the last items are still finishing when the node flips.
    // The run as a whole, not just the node: a graph whose last step is a
    // fan-out still has to report that it finished, and "cancelled" was what it
    // used to say — `last` is the final *agent* step's result and a fan-out is
    // not one.
    await expect(page.getByTestId('run-note')).toContainText('succeeded', { timeout: 120_000 });

    // 3. It ran on the model the workspace calls cheap — the automation never
    //    named one.
    const models = gateway.modelsUsed();
    expect(models.length).toBeGreaterThan(20);
    expect(models.every((model) => model === 'claude-haiku-4-5')).toBe(true);

    // 4. The failure report names the one that failed, and the saving against
    //    the frontier tier is stated rather than claimed.
    await goTo(page, 'runs');
    await expect(page.getByTestId('run-failures')).toContainText('row-5', { timeout: 20_000 });
    await expect(page.getByTestId('run-blended')).toContainText('frontier tier');
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
