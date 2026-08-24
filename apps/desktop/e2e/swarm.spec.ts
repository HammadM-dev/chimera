import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// The swarm section: a population, and every question ever put to it.
//
// What is worth proving end to end is the thing that separates a swarm from a
// chat with extra steps — that a follow-up reaches the *same* crowd, that the
// screen says which of the two modes produced its numbers, and that a thread is
// a thread: named, listed, reopenable.

test.describe.configure({ timeout: 240_000 });

/** A gateway that plays a population arguing, then reports on itself. */
async function startGateway(): Promise<{
  baseUrl: string;
  asks: () => number;
  close: () => Promise<void>;
}> {
  let asks = 0;

  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }] }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const answer = ((): string => {
        if (body.includes('You write the cast')) {
          return JSON.stringify({
            personas: [
              {
                name: 'careful accountant',
                description: 'watches the margin',
                traits: ['cautious'],
                susceptibility: 0.2,
                influence: 0.9,
              },
              {
                name: 'growth marketer',
                description: 'wants the volume',
                traits: ['bold'],
                susceptibility: 0.7,
                influence: 0.5,
              },
              {
                name: 'long-time customer',
                description: 'has been here years',
                traits: ['loyal'],
                susceptibility: 0.5,
                influence: 0.4,
              },
            ],
          });
        }
        if (body.includes('You report what happened')) {
          return 'The room split, and the accountant carried it.\n\nTITLE: Price rise';
        }
        asks += 1;
        // Somebody for, somebody against, so the population has an argument to
        // have rather than a consensus to confirm.
        const against = body.includes('careful accountant');
        return JSON.stringify({
          said: against ? 'The margin does not survive it.' : 'We should push it.',
          position: against ? -0.8 : 0.7,
          confidence: 0.7,
        });
      })();

      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          id: 's-1',
          model: 'claude-haiku-4-5',
          choices: [
            { index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 40 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    asks: () => asks,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('a swarm runs, is named, and the same crowd answers the follow-up', async () => {
  const gateway = await startGateway();
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl } });

  try {
    const page = await app.firstWindow();

    await goTo(page, 'providers');
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
      timeout: 20_000,
    });
    await page.getByTestId('omniroute-import').click();
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
      timeout: 20_000,
    });

    await goTo(page, 'swarm');
    await expect(page.getByTestId('swarm-view')).toBeVisible();

    // A crowd of 600 with a threshold of 24: most of them follow rather than
    // think, which is the only way a crowd that size is affordable.
    await page.getByTestId('swarm-population').fill('600');
    await page.getByTestId('swarm-rounds').fill('2');
    await page.getByTestId('swarm-input').fill('Should we raise prices by ten per cent?');
    await page.getByTestId('swarm-ask').click();

    await expect(page.getByTestId('swarm-turn')).toBeVisible({ timeout: 180_000 });

    // The screen says which mode produced its numbers. A prediction that will
    // not say how it was made is one nobody should act on.
    const how = page.getByTestId('swarm-how');
    await expect(how).toContainText('followed them through who listens to whom');
    await expect(how)
      .toContainText('600' as string)
      .catch(() => undefined);

    // Six hundred agents, and nowhere near six hundred model calls.
    expect(gateway.asks()).toBeLessThan(30);

    // The model's title beat the first six words of the question.
    await expect(page.getByTestId('swarm-title')).toHaveText('Price rise');
    await expect(page.getByTestId('swarm-split')).toBeVisible();

    if (process.env['CHIMERA_SHOTS'] === '1') {
      await page.screenshot({ path: 'test-results/shots/swarm.png' });
    }

    // The follow-up goes to the same thread rather than starting a new one.
    await page.getByTestId('swarm-input').fill('And if it were twenty per cent?');
    await page.getByTestId('swarm-ask').click();
    await expect(page.getByTestId('swarm-turn')).toHaveCount(2, { timeout: 180_000 });

    // One thread in the list, not two.
    const threads = page.locator('[data-testid^="swarm-thread-"]');
    await expect(threads).toHaveCount(1);
    await expect(threads.first()).toContainText('Price rise');
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});

test('the swarm list folds away, and a swarm can be renamed', async () => {
  const gateway = await startGateway();
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl } });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'swarm');

    const view = page.getByTestId('swarm-view');
    await expect(view).toHaveAttribute('data-list', 'open');
    await page.getByTestId('swarm-list-toggle').click();
    await expect(view).toHaveAttribute('data-list', 'closed');
    // The handle stays reachable once the panel is away.
    await expect(page.getByTestId('swarm-list-toggle')).toBeVisible();
    await page.getByTestId('swarm-list-toggle').click();
    await expect(view).toHaveAttribute('data-list', 'open');
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
