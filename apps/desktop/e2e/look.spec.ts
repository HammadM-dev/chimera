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

      // First-run setup, where the provider cards and their tags live.
      await page.waitForSelector('[data-testid="app-shell"]');
      await page.waitForSelector('.splash', { state: 'detached', timeout: 20_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/onboarding-welcome.png` });
      const start = page.getByTestId('intro-start').first();
      if ((await start.count()) > 0) {
        await start.click();
        await page.waitForTimeout(500);
        // Past the name step to the provider choice, which is what carries the
        // marks and the tags. A name is required to move on.
        await page.getByTestId('intro-first-name').fill('Hammad');
        await page.getByTestId('intro-you-next').click();
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${SHOTS}/onboarding-providers.png` });
      }

      // The tour comes up on a fresh profile, so photograph it before it is
      // dismissed — including a step that points at something.
      await page.waitForSelector('[data-testid="app-shell"]');
      await page.waitForSelector('.splash', { state: 'detached', timeout: 20_000 });
      const skip = page.getByTestId('intro-skip').first();
      if ((await skip.count()) > 0) await skip.click();
      await page.getByTestId('tour').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${SHOTS}/tour-1.png` });
      await page.getByTestId('tour-next').click();
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${SHOTS}/tour-2.png` });
      await page.getByTestId('tour-skip').click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/tour-skip.png` });
      await page.getByTestId('tour-skip-confirmed').click();
      await page.waitForTimeout(400);

      // Home first: the mark sits above the greeting there. Through `goTo` so
      // first-run setup is dismissed — it is a full-screen overlay, and a click
      // made underneath it is intercepted rather than delivered.
      await goTo(page, 'home');
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${SHOTS}/home-dark.png` });
      await page.getByTestId('nav-theme').click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${SHOTS}/home-light.png` });
      await page.getByTestId('nav-theme').click();
      await page.waitForTimeout(400);

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

      await goTo(page, 'notes');
      await page.waitForTimeout(500);
      // Something on the board, including a line an agent left, because an
      // empty board says nothing about how a full one reads.
      await page.evaluate(async () => {
        const chimera = (
          window as unknown as {
            chimera: { invoke: (c: string, p: unknown) => Promise<unknown> };
          }
        ).chimera;
        const day = 24 * 60 * 60 * 1000;
        await chimera.invoke('note:save', {
          kind: 'reminder',
          title: 'Chase the Rotterdam invoice',
          body: 'Second reminder. They asked for a PO number.',
          dueAt: new Date(Date.now() - 3 * day).toISOString(),
        });
        await chimera.invoke('note:save', {
          kind: 'reminder',
          title: 'Renew the Stripe restricted key',
          dueAt: new Date(Date.now() + 2 * day).toISOString(),
        });
        await chimera.invoke('note:save', {
          kind: 'note',
          title: 'Design partner call notes',
          body: 'They want per-seat pricing and an audit export.',
        });
      });
      await page.reload();
      await goTo(page, 'notes');
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${SHOTS}/notes.png` });

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
