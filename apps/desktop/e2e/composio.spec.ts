import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// Composio, with no Composio.
//
// The interesting state is the one every workspace starts in and most stay in
// for a while: the feature is there, no key has been given, and the question is
// whether that reads as "not set up yet" or as a broken screen. A tool that
// cannot reach its service should say which of the two it is, and an agent that
// calls it should get that sentence back rather than a stack trace.

test.describe.configure({ timeout: 120_000 });

test('Composio is off until it is given a key, and says so plainly', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'providers');

    const panel = page.getByTestId('composio');
    await expect(panel).toBeVisible({ timeout: 20_000 });

    // Off to begin with: no key field, nothing claiming a connection.
    const enabled = page.getByTestId('composio-enabled');
    await expect(enabled).not.toBeChecked();
    await expect(page.getByTestId('composio-key')).toHaveCount(0);

    // Switching it on asks for the key rather than pretending to be connected.
    await enabled.check();
    await expect(page.getByTestId('composio-key')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('composio-toolkits')).toHaveCount(0);

    // And switching it off again puts it back, rather than leaving a
    // half-configured panel behind.
    await enabled.uncheck();
    await expect(page.getByTestId('composio-key')).toHaveCount(0);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('a Composio tool call with no key is an answer, not a crash', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();

    // Straight at the tool, through the same bridge the agent runtime uses.
    // What matters is the shape of the failure: a sentence a person can act on,
    // and an app still standing afterwards.
    const answer = await page.evaluate(async () => {
      const chimera = (
        window as unknown as {
          chimera: { invoke: (channel: string, payload: unknown) => Promise<unknown> };
        }
      ).chimera;
      try {
        return await chimera.invoke('composio:toolkits', {});
      } catch (err) {
        return { threw: err instanceof Error ? err.message : String(err) };
      }
    });

    assertMentionsSetup(JSON.stringify(answer));

    // Still alive.
    await goTo(page, 'providers');
    await expect(page.getByTestId('composio')).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

function assertMentionsSetup(text: string): void {
  expect(text.toLowerCase()).toContain('composio');
  expect(text).toMatch(/not connected|Providers/i);
}
