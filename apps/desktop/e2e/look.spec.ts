import { test } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// A throwaway spec that only takes pictures. Not part of the suite's argument
// about correctness — it exists because the two faults this section has had
// (a graph silently dropped at the IPC boundary, and a layout that drew a
// sunburst) were both invisible to every assertion and obvious in a screenshot.

const SHOTS = process.env['CHIMERA_SHOTS'] ?? '';

test.describe('look', () => {
  test.skip(SHOTS === '', 'Set CHIMERA_SHOTS to a directory to run this.');

  test('the new sections', async () => {
    const profile = freshProfile();
    const app = await launchApp({ profile });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });

      await goTo(page, 'apps');
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${SHOTS}/apps-setup.png` });

      const key = process.env['COMPOSIO_API_KEY'] ?? '';
      if (key !== '') {
        const enabled = page.getByTestId('composio-enabled');
        if (!(await enabled.isChecked())) await enabled.click();
        await page.getByTestId('composio-key').fill(key);
        await page.getByTestId('composio-save').click();
        await page.getByTestId('composio-toolkits').waitFor({ timeout: 90_000 });
        await page.waitForTimeout(4000);
        await page.screenshot({ path: `${SHOTS}/apps-directory.png`, fullPage: false });

        await page.getByTestId('composio-filter').fill('gmail');
        await page.waitForTimeout(1500);
        await page.getByTestId('composio-how-gmail').click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${SHOTS}/apps-guide.png` });
      }

      await goTo(page, 'build');
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${SHOTS}/canvas.png` });

      await goTo(page, 'swarm');
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/swarm.png` });

      await goTo(page, 'providers');
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/providers.png` });
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });
});
