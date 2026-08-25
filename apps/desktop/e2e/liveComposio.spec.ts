import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// Composio, against Composio.
//
// Every other Composio test here runs on a stand-in, and a stand-in only ever
// proves the app agrees with whatever shape it was handed. That is exactly how
// the first version of this feature shipped broken: the response shape was
// guessed, the code and its tests were written to the same guess, all eleven
// tests passed, and `search` returned an empty list against the real service
// every single time. An empty list reads as "nothing matched", so nothing about
// it looked like a fault.
//
// This one uses a real key and asserts the things that guess got wrong.
//
// Skipped unless COMPOSIO_API_KEY is set, so CI stays offline per CLAUDE.md.
// The key is read from the environment and never written to the repo.

const KEY = process.env['COMPOSIO_API_KEY'] ?? '';
const LIVE = KEY !== '';

test.describe.configure({ timeout: 240_000 });

test.describe('Composio, live', () => {
  test.skip(!LIVE, 'Set COMPOSIO_API_KEY to run this.');

  test('a real key lists real apps, and a search reaches past the first page', async () => {
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await goTo(page, 'providers');

      await page.getByTestId('composio-enabled').check();
      await page.getByTestId('composio-key').fill(KEY);
      await page.getByTestId('composio-save').click();

      // Apps arrive. Not twenty of them — the paging defect showed exactly one
      // page and gave no sign there were twenty-seven more behind it.
      const list = page.getByTestId('composio-toolkits');
      await expect(list).toBeVisible({ timeout: 60_000 });
      await expect(list.locator('.toolkit')).not.toHaveCount(0, { timeout: 60_000 });
      await expect(list.locator('.toolkit')).not.toHaveCount(20, { timeout: 60_000 });

      // A search reaches the whole catalogue rather than filtering what was
      // already on screen. Notion is not in the first page of any ordering
      // this account returns, so finding it means the query went to Composio.
      await page.getByTestId('composio-filter').fill('notion');
      await expect(list).toContainText(/notion/i, { timeout: 60_000 });
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });

  test('a tool search comes back with slugs, schemas, and whether the app is connected', async () => {
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await goTo(page, 'providers');

      await page.getByTestId('composio-enabled').check();
      await page.getByTestId('composio-key').fill(KEY);
      await page.getByTestId('composio-save').click();
      await expect(page.getByTestId('composio-toolkits')).toBeVisible({ timeout: 60_000 });

      // Straight at the tool the agent would call. This is the assertion the
      // whole file exists for: the old reader returned `{tools: []}` here.
      const answer = await page.evaluate(async () => {
        const chimera = (
          window as unknown as {
            chimera: { invoke: (channel: string, payload: unknown) => Promise<unknown> };
          }
        ).chimera;
        return chimera.invoke('composio:search', { query: 'send an email with gmail' });
      });

      const found = answer as {
        tools: { slug: string; toolkit: string; inputSchema: unknown }[];
        toolkits: { toolkit: string; connected: boolean }[];
        pitfalls: string[];
      };

      expect(found.tools.length).toBeGreaterThan(0);
      expect(found.tools.map((tool) => tool.slug)).toContain('GMAIL_SEND_EMAIL');

      // A slug with no schema is a name the agent has to guess arguments for.
      const send = found.tools.find((tool) => tool.slug === 'GMAIL_SEND_EMAIL');
      expect(Object.keys((send?.inputSchema ?? {}) as object).length).toBeGreaterThan(0);

      // And it says whether Gmail is actually reachable, which is the
      // difference between a plan that can run and one that cannot.
      expect(found.toolkits.map((toolkit) => toolkit.toolkit)).toContain('gmail');
      expect(found.pitfalls.length).toBeGreaterThan(0);
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });
});
