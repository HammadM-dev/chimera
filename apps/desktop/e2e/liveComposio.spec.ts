import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';
import type { Page } from '@playwright/test';

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

test.describe.configure({ timeout: 300_000 });

/** Saves the key and waits for the catalogue to land. */
async function connectComposio(page: Page): Promise<void> {
  await goTo(page, 'apps');
  const enabled = page.getByTestId('composio-enabled');
  if (!(await enabled.isChecked())) await enabled.click();
  await expect(page.getByTestId('composio-key')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('composio-key').fill(KEY);
  await page.getByTestId('composio-save').click();
  await expect(page.getByTestId('composio-toolkits')).toBeVisible({ timeout: 90_000 });
}

async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  return page.evaluate(
    async ([one, two]) => {
      const chimera = (
        window as unknown as {
          chimera: { invoke: (channel: string, payload: unknown) => Promise<unknown> };
        }
      ).chimera;
      return chimera.invoke(one as string, two);
    },
    [channel, payload],
  ) as Promise<T>;
}

test.describe('Composio, live', () => {
  test.skip(!LIVE, 'Set COMPOSIO_API_KEY to run this.');

  test('a real key lists real apps, and a search reaches past the first page', async () => {
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await connectComposio(page);

      // Apps arrive. Not twenty of them — the paging defect showed exactly one
      // page and gave no sign there were twenty-seven more behind it.
      const rows = page.getByTestId('composio-toolkits').locator('.app');
      await expect(rows.first()).toBeVisible({ timeout: 90_000 });
      expect(await rows.count()).toBeGreaterThan(20);

      // A search reaches the whole catalogue rather than filtering what was
      // already on screen. Notion is not in the first page of any ordering
      // this account returns, so finding it means the whole catalogue is here.
      await page.getByTestId('composio-filter').fill('notion');
      await expect(page.getByTestId('composio-app-notion')).toBeVisible({ timeout: 30_000 });
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
      await connectComposio(page);

      // Straight at the tool the agent would call. This is the assertion the
      // whole file exists for: the old reader returned `{tools: []}` here.
      const found = await invoke<{
        tools: { slug: string; toolkit: string; inputSchema: unknown }[];
        toolkits: { toolkit: string; connected: boolean }[];
        pitfalls: string[];
      }>(page, 'composio:search', { query: 'send an email with gmail' });

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

  test('Connect asks Composio for a real sign-in page', async () => {
    // The button that said "Opening" and did nothing for its whole life. The
    // renderer called `window.open`, the navigation guard denied it exactly as
    // designed, and the only record was a console line nobody had open.
    //
    // Asserted on the URL rather than on the browser coming up: whether
    // `shell.openExternal` succeeds depends on the machine having a browser
    // associated, which a test runner may not. What has to be true either way
    // is that a real link came back and that it is somewhere CHIMERA will go.
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await connectComposio(page);

      const started = await invoke<{ url: string; opened: boolean; reason: string }>(
        page,
        'composio:connect',
        { toolkit: 'notion' },
      );

      expect(started.url).toMatch(/^https:\/\/connect\.composio\.dev\/link\//);

      // And the gate agrees it is openable — the same function that runs when
      // the button is pressed.
      const allowed = await invoke<{ opened: boolean; reason: string }>(
        page,
        'shell:openExternal',
        { url: 'https://connect.composio.dev/link/whatever' },
      );
      expect(allowed.reason).not.toMatch(/only opens links to sites it knows/);

      // Whereas somewhere it does not know is refused, in the same run, so this
      // proves a check rather than a permissive default.
      const refused = await invoke<{ opened: boolean; reason: string }>(
        page,
        'shell:openExternal',
        { url: 'https://connect.composio.dev.example.com/link/x' },
      );
      expect(refused.opened).toBe(false);
      expect(refused.reason).toMatch(/only opens links to sites it knows/);
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });

  test('a tool’s app is resolved by asking rather than by reading its name', async () => {
    // The fact the per-step app limit is built on. A prefix match on the slug
    // would be the obvious implementation and would be wrong: ZOHO and
    // ZOHO_MAIL are both real toolkits, and twenty-five pairs in the catalogue
    // collide the same way — so an operator narrowed to `zoho` would silently
    // be handed every `zoho_mail` tool.
    //
    // The refusal itself is a unit test (`refusalFor`), because there is no IPC
    // channel that runs a Composio tool and there must not be one: every tool
    // call goes through the Governor. This is the half that needs Composio.
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await connectComposio(page);

      const gmail = await invoke<{ toolkit: string }>(page, 'composio:toolkitOf', {
        slug: 'GMAIL_SEND_EMAIL',
      });
      expect(gmail.toolkit).toBe('gmail');

      // The colliding one. A prefix rule scoped to `zoho` would claim this.
      const zoho = await invoke<{ toolkit: string }>(page, 'composio:toolkitOf', {
        slug: 'ZOHO_MAIL_MESSAGES_SEND_EMAIL',
      });
      expect(zoho.toolkit).toBe('zoho_mail');

      // And a slug Composio has never heard of resolves to nothing, which is
      // what makes the refusal fail closed rather than open.
      const invented = await invoke<{ toolkit: string }>(page, 'composio:toolkitOf', {
        slug: 'NOTION_DEFINITELY_NOT_A_REAL_TOOL',
      });
      expect(invented.toolkit).toBe('');
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });
});
