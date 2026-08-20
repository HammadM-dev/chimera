import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// An automation whose agents can use the web, in a workspace that allows no
// sites.
//
// Hammad ran one. The researcher tried catalog.data.gov, was refused, tried
// example.com, was refused, and carried on until it hit the iteration limit:
// 101,848 tokens and two minutes and forty-seven seconds to discover, one host
// at a time, that the door was locked. Nothing had told it, and nothing had
// told him.

test.describe.configure({ timeout: 120_000 });

test('a web-using agent with no allowed sites is flagged before the run, not during it', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'build');

    // Allowlist mode, where the list is the whole rule and an empty one means
    // nothing is reachable. Under the default, `browse`, reading needs no list
    // and there is nothing to warn about.
    await page.getByTestId('brief-egress-mode').selectOption('allowlist');

    // The summariser has no web tools, so nothing is said.
    await page.getByTestId('palette-summariser').click();
    await expect(page.getByTestId('brief-sites-warning')).toHaveCount(0);

    // The researcher has http.request.
    await page.getByTestId('palette-researcher').click();
    const warning = page.getByTestId('brief-sites-warning');
    await expect(warning).toBeVisible({ timeout: 20_000 });
    await expect(warning).toContainText('Researcher');
    await expect(warning).toContainText('every address will be refused');

    // Naming a site answers it.
    await page.getByTestId('brief-sites').fill('catalog.data.gov');
    await expect(page.getByTestId('brief-sites-warning')).toHaveCount(0);

    // And taking the sites away brings it back.
    await page.getByTestId('brief-sites').fill('');
    await expect(page.getByTestId('brief-sites-warning')).toBeVisible();

    // Switching to browse answers it a different way: reading the open web
    // needs no list, so there is nothing left to warn about.
    await page.getByTestId('brief-egress-mode').selectOption('browse');
    await expect(page.getByTestId('brief-sites-warning')).toHaveCount(0);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
