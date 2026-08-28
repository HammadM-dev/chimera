import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, joinSteps, launchApp, removeProfile } from './support/app.ts';

// What one step hands the next, against a real model.
//
// Reported from a real run: an App operator fetched somebody's GitHub email
// through Composio, and the step after it was handed "I'll fetch your GitHub
// emails now" — the sentence the model said in the same turn as the call,
// before any result existed. The emails went nowhere, and the second agent
// correctly refused to summarise what it had never been shown.
//
// The unit tests cover the mechanism. This covers the thing they could not:
// that a real model, narrating as real models do, actually produces the shape
// that used to break it. The page is served locally so the *facts* are fixed
// and only the model is live — a test that also depended on the internet
// having a particular opinion would fail for reasons that are not this.
//
// Skipped unless OPENROUTER_API_KEY is set, so CI stays offline per CLAUDE.md.

const KEY = process.env['OPENROUTER_API_KEY'] ?? '';
// A free model that exists today. `stealth/ox-alpha` was retired, and a live
// test pinned to a model that no longer exists fails for a reason that has
// nothing to do with the product.
const MODEL = process.env['CHIMERA_LIVE_OPENROUTER_MODEL'] ?? 'minimax/minimax-m3:free';

/** A marker no model could produce by guessing, so a pass cannot be luck. */
const MARKER = 'TURBINE-9F4X-QUARTZ';

test.describe.configure({ timeout: 900_000 });

async function startSite(): Promise<{ url: string; host: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(
      JSON.stringify({
        partNumber: MARKER,
        status: 'shipped',
        quantity: 47,
        destination: 'Rotterdam',
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/order.json`,
    // The hostname alone. The allowlist matches hostnames, not authorities —
    // `127.0.0.1:43411` matches nothing, and the first run of this test spent
    // nine minutes proving it.
    host: '127.0.0.1',
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test.describe('what one step hands the next', () => {
  test.skip(KEY === '', 'Set OPENROUTER_API_KEY to run this.');

  test('a step that used a tool passes on the results, not its intention', async () => {
    const site = await startSite();
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();

      await goTo(page, 'providers');
      await page.getByTestId('connection-label').fill('OpenRouter');
      await page.getByTestId('connection-kind').selectOption('openrouter');
      await page.getByTestId('connection-key').fill(KEY);
      await page.getByTestId('connection-create').click();
      await expect(page.getByTestId('connection-row')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('connection-models')).not.toContainText('No catalogue', {
        timeout: 120_000,
      });

      await goTo(page, 'build');

      const place = async (id: string, instruction: string): Promise<void> => {
        await page.getByTestId(`palette-${id}`).click();
        await page.getByTestId('node-model').selectOption({ label: `OpenRouter · ${MODEL}` });
        await page.getByTestId('node-instruction').fill(instruction);
      };

      // Exactly the reported shape: one agent uses a tool, one downstream has
      // nothing but what the first hands it.
      await place(
        'researcher',
        `Fetch ${site.url} and report every field it contains, copying the values exactly.`,
      );
      await place(
        'summariser',
        'Say in one sentence what the order above is: give its part number, its quantity and where it is going, copied exactly from what you were given.',
      );

      await joinSteps(page, 'node-researcher', 'node-summariser');

      await page.getByTestId('brief-egress-mode').selectOption('browse');
      await page.getByTestId('brief-sites').fill(site.host);
      await page.getByTestId('brief-name').fill('Order handoff');
      await page.getByTestId('brief-input').fill('What is in the order record?');

      await expect(page.getByTestId('brief-run')).toBeEnabled({ timeout: 20_000 });
      await page.getByTestId('brief-run').click();

      await expect(
        page.getByTestId('run-note').or(page.getByTestId('run-result')).first(),
      ).toBeVisible({ timeout: 840_000 });

      // Printed before anything is asserted: when a live run goes wrong the
      // useful information is why, not that it did.
      for (const id of ['node-researcher', 'node-summariser']) {
        console.log(`[step] ${(await page.getByTestId(id).textContent()) ?? ''}`);
      }

      // Read from the result panel rather than by clicking the nodes: the
      // panel opens over the canvas when a run finishes, so the nodes behind it
      // are not clickable and never will be.
      const steps = page.getByTestId('result-steps');
      await expect(steps).toBeVisible({ timeout: 30_000 });
      for (const row of await steps.locator('summary').all()) await row.click();

      const all = (await steps.textContent()) ?? '';
      console.log(`[steps] ${all.slice(0, 1200)}`);

      // The first step's own answer carries the facts. This is the assertion
      // the bug fails: its output used to be the sentence it said before the
      // fetch, with the marker nowhere in it.
      expect(all, 'no step passed on what was fetched').toContain(MARKER);

      // And the second step, which has no tool of its own and could only know
      // this from the handoff, repeats it — so the marker appears twice.
      const seen = all.split(MARKER).length - 1;
      expect(seen, 'the second step never received the first step’s findings').toBeGreaterThan(1);


      // The exact failure text the user saw, in any step.
      expect(all).not.toMatch(
        /never (?:reached|passed)|source data never|nothing was ever recorded/i,
      );
    } finally {
      await app.close();
      removeProfile(profile);
      await site.close();
    }
  });
});
