import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// Granting CHIMERA a folder to read.
//
// No provider: giving and taking back a permission is not something that
// should need a model connection.

test.describe.configure({ timeout: 120_000 });

test('a folder is granted, listed, and revoked', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-grant-'));
  fs.writeFileSync(path.join(folder, 'contract.txt'), 'renews 2027', 'utf8');

  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_E2E_PICK_DIRECTORY: folder } });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'providers');

    // Nothing is readable until somebody says so.
    await expect(page.getByTestId('file-grants-empty')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('grant-add').click();
    await expect(page.getByTestId('file-grants')).toContainText(folder, { timeout: 20_000 });
    // The panel states what the grant is, so nobody has to assume it.
    await expect(page.getByTestId('file-grants')).toContainText('cannot change or delete');

    // It survives a restart: a permission that forgets itself is not one.
    await app.close();
    const again = await launchApp({ profile, env: { CHIMERA_E2E_PICK_DIRECTORY: folder } });
    const page2 = await again.firstWindow();
    await goTo(page2, 'providers');
    await expect(page2.getByTestId('file-grants')).toContainText(folder, { timeout: 20_000 });

    // And taking it back is one click, next to the thing it takes back.
    await page2.getByTestId('grant-revoke').first().click();
    await expect(page2.getByTestId('file-grants-empty')).toBeVisible({ timeout: 20_000 });
    await again.close();
  } finally {
    removeProfile(profile);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
