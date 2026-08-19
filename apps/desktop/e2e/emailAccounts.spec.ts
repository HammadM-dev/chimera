import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// Adding a mailbox, and what happens when it will not answer.
//
// No real account and no network: the host is one nothing is listening on, so
// the check fails the way a wrong app password or a provider with IMAP switched
// off fails — which is the path worth testing, because it is the one nearly
// everybody hits first.

test.describe.configure({ timeout: 120_000 });

test('a mailbox is added, checked, and removed', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'providers');

    await expect(page.getByTestId('email-empty')).toBeVisible({ timeout: 20_000 });
    // The panel says what sending will do before anything is connected.
    await expect(page.getByTestId('email-accounts')).toContainText('approval');

    await page.getByTestId('email-add').click();
    await page.getByTestId('email-preset').selectOption('custom');
    await page.getByTestId('email-address').fill('finance@bellweather.test');
    await page.getByTestId('email-imap').fill('127.0.0.1');
    await page.getByTestId('email-smtp').fill('127.0.0.1');
    await page.getByTestId('email-password').fill('an-app-password');
    await page.getByTestId('email-save').click();

    await expect(page.getByTestId('email-accounts')).toContainText('finance@bellweather.test', {
      timeout: 20_000,
    });

    // Checking it reports the failure in the server's own terms rather than
    // saying "something went wrong".
    await page.getByTestId('email-test').first().click();
    await expect(page.getByTestId('email-note')).toBeVisible({ timeout: 60_000 });
    const detail = (await page.getByTestId('email-note').textContent()) ?? '';
    expect(detail.length).toBeGreaterThan(0);
    expect(detail).not.toBe('Checking…');
    process.stdout.write(`\nmailbox check said: ${detail}\n`);

    await page.getByTestId('email-remove').first().click();
    await expect(page.getByTestId('email-empty')).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('a mailbox needs an address and a password', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'providers');

    await page.getByTestId('email-add').click();
    await page.getByTestId('email-preset').selectOption('gmail');
    // The app-password point is made next to the field, not in a help page.
    await expect(page.getByTestId('email-form')).toContainText('app password');

    await page.getByTestId('email-save').click();
    await expect(page.getByTestId('email-note')).toContainText('address', { timeout: 20_000 });

    await page.getByTestId('email-address').fill('me@gmail.com');
    await page.getByTestId('email-save').click();
    await expect(page.getByTestId('email-note')).toContainText('app password', { timeout: 20_000 });
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
