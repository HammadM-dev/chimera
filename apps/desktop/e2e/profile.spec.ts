import { test, expect } from '@playwright/test';
import { dismissTour, freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';
import { startStub } from './support/stub.ts';

// The name on the home screen, and the light switch in the rail.
//
// Both are device-local preferences that have to survive a restart. The name
// has one further requirement, which is the whole reason it can be asked for at
// all: it must not leave the machine. There is a test for that below, and it is
// the one worth reading.

test.describe.configure({ timeout: 180_000 });

/** The greeting the current hour should produce, so this does not fail every afternoon. */
function expectedGreeting(hour: number): string {
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  if (hour < 22) return 'Good evening';
  return 'Working late';
}

test('a name given at setup is greeted, and survives a restart', async () => {
  const stub = await startStub();
  const profile = freshProfile();

  const app = await launchApp({
    profile,
    splash: true,
    env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.splash', { state: 'detached', timeout: 20_000 });
    await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('intro-start').click();
    await page.getByTestId('intro-first-name').fill('Hammad');
    await page.getByTestId('intro-last-name').fill('M');
    await page.getByTestId('intro-you-next').click();
    await page.getByTestId('intro-skip').click();

    await expect(page.getByTestId('home-greeting')).toHaveText(
      `${expectedGreeting(new Date().getHours())}, Hammad`,
      { timeout: 20_000 },
    );
  } finally {
    await app.close();
  }

  // Reopened on the same profile: still there, so it was written to disk rather
  // than held in a tab.
  const again = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl } });
  try {
    const page = await again.firstWindow();
    await expect(page.getByTestId('home-greeting')).toContainText('Hammad', { timeout: 20_000 });
  } finally {
    await again.close();
    removeProfile(profile);
    await stub.close();
  }
});

test('the theme switches, and stays switched', async () => {
  const stub = await startStub();
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl } });

  try {
    const page = await app.firstWindow();

    // A fresh profile opens on the setup guide, which covers the rail. Out of
    // the way first — this test is about the switch, not about reaching it.
    const guide = page.getByTestId('onboarding');
    if (await guide.isVisible().catch(() => false)) {
      await page.getByTestId('intro-skip').click();
      await expect(guide).toHaveCount(0);
    }
    // And the tour behind it, which dims the rail and takes the click.
    await dismissTour(page);

    // Dark is the default and is not merely the absence of a choice: the
    // attribute is set, so every token block has something to match on.
    const root = page.locator('html');
    await expect(root).toHaveAttribute('data-theme', 'dark', { timeout: 20_000 });

    const toggle = page.getByTestId('nav-theme');
    await expect(toggle).toHaveText('Light mode');
    await toggle.click();

    await expect(root).toHaveAttribute('data-theme', 'light');
    // The control offers the way back rather than describing where you are.
    await expect(toggle).toHaveText('Dark mode');

    // And the palette actually changed, not only the attribute.
    const canvas = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim(),
    );
    expect(canvas).not.toBe('#0d0d0c');
  } finally {
    await app.close();
  }

  const again = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl } });
  try {
    const page = await again.firstWindow();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light', { timeout: 20_000 });
  } finally {
    await again.close();
    removeProfile(profile);
    await stub.close();
  }
});

test('the name is on this machine and in one file, and nowhere else', async () => {
  // The promise the setup screen makes, checked rather than trusted. A name in
  // the workspace database would be swept into F10's shared-workspace sync
  // later; a name in a run would reach a provider.
  const stub = await startStub();
  const profile = freshProfile();
  const app = await launchApp({
    profile,
    splash: true,
    env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl },
  });

  // Distinctive enough that a match cannot be a coincidence.
  const secret = 'Zebediah';

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.splash', { state: 'detached', timeout: 20_000 });
    await page.getByTestId('intro-start').click();
    await page.getByTestId('intro-first-name').fill(secret);
    await page.getByTestId('intro-you-next').click();
    await page.getByTestId('intro-skip').click();
    await expect(page.getByTestId('home-greeting')).toContainText(secret, { timeout: 20_000 });

    // Also: it does not reach the run. Visiting the views that build one is
    // enough to catch a name that had been folded into a prompt template.
    await goTo(page, 'build');
    await goTo(page, 'home');
  } finally {
    await app.close();
  }

  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const path = await import('node:path');

  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(full);
        continue;
      }
      if (statSync(full).size > 20_000_000) continue;
      try {
        if (readFileSync(full, 'latin1').includes(secret)) found.push(path.relative(profile, full));
      } catch {
        // A file that will not read holds nothing this test can object to.
      }
    }
  };
  walk(profile);

  expect(found, `the name appeared in: ${found.join(', ')}`).toEqual(['profile.json']);

  removeProfile(profile);
  await stub.close();
});
