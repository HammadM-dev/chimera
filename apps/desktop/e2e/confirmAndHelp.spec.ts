import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';
import { startStub } from './support/stub.ts';

// Asking before destroying, and showing how before failing.

test.describe.configure({ timeout: 180_000 });

test('deleting a saved automation asks first, and taking it back leaves it alone', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'build');
    await page.getByTestId('palette-summariser').click();
    await page.getByTestId('brief-input').fill('Summarise the week.');
    await page.getByTestId('brief-name').fill('Weekly summary');
    await page.getByTestId('brief-save').click();
    await expect(page.getByTestId('saved-list')).toContainText('Weekly summary', {
      timeout: 20_000,
    });

    // Asked, and it says what is lost and what is kept.
    await page.locator('[data-testid^="forget-"]').first().click();
    await expect(page.getByTestId('confirm')).toBeVisible();
    await expect(page.getByTestId('confirm')).toContainText('Weekly summary');
    await expect(page.getByTestId('confirm')).toContainText('Its runs stay');

    // Backing out changes nothing.
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm')).toHaveCount(0);
    await expect(page.getByTestId('saved-list')).toContainText('Weekly summary');

    // Escape backs out too.
    await page.locator('[data-testid^="forget-"]').first().click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('confirm')).toHaveCount(0);
    await expect(page.getByTestId('saved-list')).toContainText('Weekly summary');

    // And going through does the thing.
    await page.locator('[data-testid^="forget-"]').first().click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('saved-list')).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('removing a connection asks first, and says the key goes with it', async () => {
  const stub = await startStub();
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl } });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'providers');
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
      timeout: 20_000,
    });
    await page.getByTestId('omniroute-import').click();
    await expect(page.getByTestId('connection-row')).toHaveCount(1, { timeout: 20_000 });

    await page.getByTestId('connection-remove').first().click();
    await expect(page.getByTestId('confirm')).toContainText('keychain');
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('connection-row')).toHaveCount(1);

    await page.getByTestId('connection-remove').first().click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('connection-row')).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await app.close();
    removeProfile(profile);
    await stub.close();
  }
});

test('the setup steps are there for a mailbox and for a plugin', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'providers');

    // Gmail: the app-password walk, which is the thing everybody gets wrong.
    await page.getByTestId('email-add').click();
    await page.getByTestId('email-preset').selectOption('gmail');
    await page.getByTestId('email-accounts').getByTestId('howto-toggle').click();
    const emailSteps = page.getByTestId('email-accounts').getByTestId('howto-body');
    await expect(emailSteps).toContainText('2-Step Verification');
    await expect(emailSteps).toContainText('App passwords');
    await expect(emailSteps).toContainText('IMAP is enabled');
    await page.getByTestId('email-cancel').click();

    // Outlook says the part nothing in this app can fix.
    await page.getByTestId('email-add').click();
    await page.getByTestId('email-preset').selectOption('outlook');
    await page.getByTestId('email-accounts').getByTestId('howto-toggle').click();
    await expect(page.getByTestId('email-accounts').getByTestId('howto-body')).toContainText(
      'administrator',
    );
    await page.getByTestId('email-cancel').click();

    // Plugins: what an MCP server even is, and where the command comes from.
    await page.getByTestId('plugin-add').click();
    await page.getByTestId('plugins-panel').getByTestId('howto-toggle').click();
    const pluginSteps = page.getByTestId('plugins-panel').getByTestId('howto-body');
    await expect(pluginSteps).toContainText('MCP server');
    await expect(pluginSteps).toContainText('npx');
    await expect(pluginSteps).toContainText('keychain');
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
