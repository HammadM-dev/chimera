import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// The guided tour.
//
// Onboarding stops at one connected provider on purpose — nobody reads a manual
// before they have seen the thing work once. This is the manual, and what is
// worth testing is that it walks the whole app, that skipping is a decision
// somebody makes rather than a click they slip on, and that it does not come
// back once answered either way.

test.describe.configure({ timeout: 240_000 });

/**
 * Gets to the tour, dismissing only what is in front of it.
 *
 * Deliberately not `dismissOnboarding`, which now skips the tour as well —
 * every other test in this suite needs that, and this one needs the opposite.
 */
async function openTour(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('[data-testid="app-shell"]');
  await page.waitForSelector('.splash', { state: 'detached', timeout: 20_000 });
  const skip = page.getByTestId('intro-skip').first();
  if ((await skip.count()) > 0) await skip.click();
}

/** A catalogue to pin from. Only the models endpoint matters here. */
const MODELS = ['alpha-one', 'beta-two', 'gamma-three'];

async function startGateway(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test('the tour walks every section, and each step opens the one it is about', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await openTour(page);

    const tour = page.getByTestId('tour');
    await expect(tour).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tour-progress')).toContainText('1 of');

    // Walked to the end, checking each step says something. The point of the
    // assertion is that no step is blank and no step gets stuck: a tour that
    // silently stops in the middle is worse than none, because the person
    // believes they have seen everything.
    const seen: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const title = (await page.getByTestId('tour-card').locator('h2').textContent()) ?? '';
      expect(title.trim().length, `step ${String(step + 1)} had no title`).toBeGreaterThan(0);
      seen.push(title.trim());

      const next = page.getByTestId('tour-next');
      const label = (await next.textContent()) ?? '';
      await next.click();
      if (label.trim() === 'Finish') break;
    }

    // Every step distinct — a loop that repeats a step is a loop that never
    // ends, and the counter alone would not show it.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(10);

    // It is gone, and it does not come back on the next launch.
    await expect(tour).toHaveCount(0);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('skipping asks first, and the warning says what is being skipped', async () => {
  const profile = freshProfile();
  let app = await launchApp({ profile });

  try {
    let page = await app.firstWindow();
    await openTour(page);
    await expect(page.getByTestId('tour')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('tour-skip').click();

    const confirm = page.getByTestId('tour-skip-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Sure?');
    // The warning has to say what they are giving up, not just ask twice.
    await expect(confirm).toContainText('not obvious');
    await expect(confirm).toContainText('start it again from Home');

    // Backing out returns to the tour rather than ending it.
    await page.getByTestId('tour-keep-going').click();
    await expect(page.getByTestId('tour-card')).toBeVisible();

    await page.getByTestId('tour-skip').click();
    await page.getByTestId('tour-skip-confirmed').click();
    await expect(page.getByTestId('tour')).toHaveCount(0);

    // Declined is an answer. Being asked again next launch is the behaviour
    // people mean when they call something nagging.
    await app.close();
    app = await launchApp({ profile });
    page = await app.firstWindow();
    await openTour(page);
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('tour')).toHaveCount(0);

    // And it is still reachable, because a tutorial you cannot return to is
    // one you had to finish first time.
    await page.getByTestId('home-tour').click();
    await expect(page.getByTestId('tour')).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('the last step waits for a pin when there is one to give, and never traps', async () => {
  // Two halves of one rule. The tour is meant to end with a model pinned —
  // that is the single setting that most improves the next hour — so when
  // there is a catalogue to pin from, Finish stays disabled until they do it.
  //
  // And when there is not, it must not. Somebody who skipped setup reaches
  // this step with no connection, so no catalogue, so no Pin button anywhere
  // on the screen the step points at: a requirement nobody can satisfy is a
  // trap rather than a requirement. That case is the first test above, which
  // walks the tour on an unconnected workspace and finishes it.
  const gateway = await startGateway();
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    // Past the intro and past the tour it offers: this test starts the tour
    // itself, from Home, once there is a catalogue for the last step to ask
    // about. Which is also the path somebody takes when they connect a
    // provider first and read the manual afterwards.
    await openTour(page);
    const offered = page.getByTestId('tour-skip');
    if ((await offered.count()) > 0) {
      await offered.click();
      await page.getByTestId('tour-skip-confirmed').click();
    }

    // A connection, so the last step has something to ask for.
    await goTo(page, 'providers');
    await page.getByTestId('connection-label').fill('Router');
    await page.getByTestId('connection-kind').selectOption('openai-compatible');
    await page.getByTestId('connection-base-url').fill(gateway.baseUrl);
    await page.getByTestId('connection-key').fill('test-key');
    await page.getByTestId('connection-create').click();
    await expect(page.getByTestId('connection-row')).toBeVisible({ timeout: 60_000 });

    await goTo(page, 'home');
    await page.getByTestId('home-tour').click();
    const tour = page.getByTestId('tour');
    await expect(tour).toBeVisible({ timeout: 30_000 });

    // Walk to the last step.
    for (let step = 0; step < 40; step += 1) {
      const next = page.getByTestId('tour-next');
      if (((await next.textContent()) ?? '').trim() === 'Finish') break;
      await next.click();
    }

    // It is asking, not merely suggesting.
    await expect(page.getByTestId('tour-next')).toBeDisabled();
    await expect(page.getByTestId('tour-waiting')).toBeVisible();

    // Pin one, and it unlocks without a refresh.
    // The catalogue is behind the connection's own toggle, which is where the
    // step's text sends them: "Open a connection below and press Pin".
    await page.getByTestId('connection-models').first().click();
    await expect(page.getByTestId('model-catalogue')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('model-pin').first().click();
    await expect(page.getByTestId('tour-next')).toBeEnabled({ timeout: 20_000 });

    await page.getByTestId('tour-next').click();
    await expect(tour).toHaveCount(0);
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
