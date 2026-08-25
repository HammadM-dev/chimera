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

test('Apps explains itself before it is given a key', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'apps');

    const panel = page.getByTestId('composio-view');
    await expect(panel).toBeVisible({ timeout: 20_000 });

    // The whole point of the section existing. Somebody who has never heard of
    // Composio should be able to get from here to a connected app without
    // leaving to read something, so the steps are on screen before the key is.
    const setup = page.getByTestId('composio-setup');
    await expect(setup).toBeVisible();
    await expect(setup).toContainText('Make a Composio account');
    await expect(setup).toContainText('App operator');
    await expect(page.getByTestId('composio-open-signup')).toBeVisible();

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

test('Providers points at Apps rather than holding a second copy of it', async () => {
  // Connecting somebody's mailbox stopped being a setting three scrolls down
  // Providers. Anybody who remembers where it was will look there first, so
  // there has to be something there saying where it went.
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'providers');
    await expect(page.getByText('now live in Apps')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('composio-key')).toHaveCount(0);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
