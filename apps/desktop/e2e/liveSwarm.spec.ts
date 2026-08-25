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
