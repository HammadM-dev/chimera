import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// A swarm against a real provider, on a free model with real rate limits.
//
// This exists because the stand-in gateway answers instantly and never says no,
// which is precisely the condition under which the swarm worked. Against
// OpenRouter it did not: a round opened one connection per thinking persona at
// once, met a 429, and reported "rate limit reached" on a workspace whose models
// answered a single test call perfectly well. A 503 mid-run ended the whole
// thing outright, because nothing in the product retried a 5xx.
//
// Ox Alpha is free and rate-limited accordingly, which makes it the right model
// to prove this on rather than the wrong one.
//
// Skipped unless OPENROUTER_API_KEY is set, so CI stays offline per CLAUDE.md.
// The key is read from the environment and never written to the repo.

const KEY = process.env['OPENROUTER_API_KEY'] ?? '';
const MODEL = process.env['CHIMERA_LIVE_OPENROUTER_MODEL'] ?? 'stealth/ox-alpha';

test.describe.configure({ timeout: 900_000 });

test.describe('a swarm on a real provider', () => {
  test.skip(KEY === '', 'Set OPENROUTER_API_KEY to run this.');

  test('a population answers, and a rate limit slows it down rather than failing it', async () => {
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await goTo(page, 'providers');

      await page.getByTestId('connection-label').fill('OpenRouter');
      await page.getByTestId('connection-kind').selectOption('openrouter');
      await page.getByTestId('connection-key').fill(KEY);
      await page.getByTestId('connection-create').click();

      // The catalogue lands, with prices, which is what makes the model
      // bindable and the run budgetable.
      await expect(page.getByTestId('connection-row')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('connection-models')).not.toContainText('No catalogue', {
        timeout: 120_000,
      });

      await goTo(page, 'swarm');

      // The Swarms section picks its own model rather than borrowing a tier.
      await page.getByTestId('swarm-model').selectOption(`${await connectionId(page)}::${MODEL}`);

      await page
        .getByTestId('swarm-input')
        .fill('Should a small coffee shop raise its prices by ten per cent?');

      // Enough people that a round is many calls — the condition that broke.
      await page.getByTestId('swarm-population').fill('60');
      await page.getByTestId('swarm-rounds').fill('2');
      await page.getByTestId('swarm-ask').click();

      // The crowd appears, and then it says what it is doing. This is the
      // difference between a picture and a progress indicator: the caption
      // counts real model calls going out and coming back, so a run that has
      // been going ten minutes can be told apart from one that has hung.
      await expect(page.getByTestId('swarm-graph')).toBeVisible({ timeout: 300_000 });
      await expect(page.getByTestId('swarm-graph-caption')).toContainText(/answered|thinking/, {
        timeout: 300_000,
      });

      // The controls the picture is worth having: names on the agents, and a
      // way to fill the window with them.
      await expect(page.getByTestId('swarm-graph-full')).toBeVisible();
      await page.getByTestId('swarm-graph-full').click();
      await expect(page.getByTestId('swarm-graph')).toHaveAttribute('data-full', 'yes');
      await page.getByTestId('swarm-graph-full').click();
      await expect(page.getByTestId('swarm-graph')).toHaveAttribute('data-full', 'no');

      // The whole point: it finishes. Generously timed, because slowing down
      // under a rate limit is the correct behaviour and it takes longer.
      await expect(page.getByTestId('swarm-turn')).toBeVisible({ timeout: 780_000 });

      // Nothing landed in the error slot on the way. This is where "rate limit
      // reached" and the 503 both appeared.
      await expect(page.getByTestId('swarm-error')).toHaveCount(0);

      const answer = (await page.getByTestId('swarm-turn').textContent()) ?? '';
      expect(answer.length).toBeGreaterThan(120);
      expect(answer).not.toMatch(/rate limit reached|returned 50\d|could not read/i);
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });

  test('a swarm can read up before it reacts', async () => {
    // The briefing stage, against a real provider and the real web.
    //
    // Small on purpose: eight people and one round, because what is being
    // proved here is that the Researcher runs first and that what it found
    // reaches the population — not anything about how a crowd converges, which
    // the test above already covers at size.
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await goTo(page, 'providers');

      await page.getByTestId('connection-label').fill('OpenRouter');
      await page.getByTestId('connection-kind').selectOption('openrouter');
      await page.getByTestId('connection-key').fill(KEY);
      await page.getByTestId('connection-create').click();
      await expect(page.getByTestId('connection-row')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('connection-models')).not.toContainText('No catalogue', {
        timeout: 120_000,
      });

      await goTo(page, 'swarm');
      await page.getByTestId('swarm-model').selectOption(`${await connectionId(page)}::${MODEL}`);

      // A question that cannot be answered from the sentence alone. If the
      // briefing does not run, the crowd is reacting to the words "the current
      // price" and nothing else.
      await page
        .getByTestId('swarm-input')
        .fill(
          'Would people switch away from a music streaming service that raised its price to £15 a month, given what the main services charge now?',
        );
      await page.getByTestId('swarm-population').fill('8');
      await page.getByTestId('swarm-rounds').fill('1');
      await page.getByTestId('swarm-research').check();

      // The cost line says what the extra call is for, before it is paid.
      await expect(page.getByTestId('swarm-view')).toContainText('read around it first');

      await page.getByTestId('swarm-ask').click();

      // It says it is reading, which is the whole of the progress story for a
      // stage that can take a minute on its own.
      await expect(page.getByTestId('swarm-progress')).toContainText(/[Rr]eading up on it/, {
        timeout: 240_000,
      });

      await expect(page.getByTestId('swarm-turn')).toBeVisible({ timeout: 600_000 });
      await expect(page.getByTestId('swarm-error')).toHaveCount(0);
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });
});

/** The id of the one connection, for building a tier option value. */
async function connectionId(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    const chimera = (
      window as unknown as {
        chimera: { invoke: (channel: string, payload: unknown) => Promise<unknown> };
      }
    ).chimera;
    const listed = (await chimera.invoke('connection:list', {})) as {
      connections: { id: string }[];
    };
    return listed.connections[0]?.id ?? '';
  });
}
