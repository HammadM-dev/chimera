import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, launchApp, removeProfile } from './support/app.ts';

// First-launch setup. It is the only screen a person sees before deciding
// whether this app is worth their time, so the tests are about whether it
// actually connects something rather than whether it renders.

async function startOmniRoute(models: string[]): Promise<{
  baseUrl: string;
  start: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404).end();
  });

  // Claimed then released, so the port is genuinely dead until `start`.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    start: () => new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  };
}

test('a new workspace is walked through OmniRoute setup and ends connected', async () => {
  const omniroute = await startOmniRoute(['claude-haiku-4-5', 'llama-3.3-70b', 'gpt-4o-mini']);
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: omniroute.baseUrl } });

  try {
    const page = await app.firstWindow();

    // Shown because the workspace has no connections — not because of a flag
    // that could disagree with reality.
    await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'welcome');

    await page.getByTestId('intro-start').click();
    await page.getByTestId('choose-omniroute').click();
    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'omniroute');

    // OmniRoute is not running yet: the guide says so and offers to look again,
    // rather than failing or pretending.
    await expect(page.getByTestId('intro-detect-result')).toContainText('Nothing answering yet', {
      timeout: 10_000,
    });

    // The user follows the steps and starts it.
    await omniroute.start();
    await page.getByTestId('intro-check').click();
    await expect(page.getByTestId('intro-detect-result')).toContainText('3 models', {
      timeout: 10_000,
    });

    await page.getByTestId('intro-import').click();
    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'done', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('intro-connected')).toContainText('3 models');

    await page.getByTestId('intro-finish').click();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);

    // Connected for real: the row is in the workspace, with its catalogue.
    const connections = await page.evaluate(async () => {
      const chimera = (
        window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).chimera;
      return (await chimera.invoke('connection:list', {})) as {
        connections: { kind: string; models: string[] }[];
      };
    });
    expect(connections.connections).toHaveLength(1);
    expect(connections.connections[0]?.kind).toBe('omniroute');
    expect(connections.connections[0]?.models).toHaveLength(3);
  } finally {
    await app.close();
    removeProfile(profile);
    await omniroute.close();
  }
});

test('an API key entered during setup reaches the vault, not the database', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  let mainOutput = '';
  app.process().stdout?.on('data', (chunk: Buffer) => {
    mainOutput += chunk.toString();
  });

  const canary = 'sk-onboarding-canary-must-not-be-logged';

  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('intro-start').click();

    // Real logos, not the monogram fallback: the marks render as images, and
    // the one on the API-key card leans out of its badge rather than sitting
    // squarely inside it.
    const marks = page.locator('.intro__choice .mark--logo img');
    await expect(marks.first()).toBeVisible();
    expect(await marks.count()).toBeGreaterThanOrEqual(3);
    const transform = await marks.first().evaluate((node) => getComputedStyle(node).transform);
    expect(transform).not.toBe('none');

    await page.getByTestId('choose-cloud').click();
    // Ollama Cloud is offered alongside the other key-based providers, and is
    // its own kind rather than local Ollama pointed elsewhere.
    const offered = await page.getByTestId('intro-kind').locator('option').allTextContents();
    expect(offered).toContain('Ollama Cloud');
    expect(offered).toContain('Anthropic');

    await page.getByTestId('intro-kind').selectOption('anthropic');
    await page.getByTestId('intro-key').fill(canary);
    await page.getByTestId('intro-connect').click();

    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'done', {
      timeout: 15_000,
    });
    await page.getByTestId('intro-finish').click();

    const listed = await page.evaluate(async () => {
      const chimera = (
        window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).chimera;
      return (await chimera.invoke('connection:list', {})) as {
        connections: { kind: string }[];
      };
    });
    expect(listed.connections[0]?.kind).toBe('anthropic');

    // The one thing that must not go wrong on this screen: the key is typed
    // here and must not appear in a log line on its way to the keychain.
    expect(mainOutput).toContain('connection:create');
    expect(mainOutput, 'a credential typed during setup reached the log').not.toContain(canary);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('the whole intro replays on demand, splash included', async () => {
  // The bug this exists for, in the founder's words: "the intro showed up when
  // I first did it, then I stopped it and retried and now neither the splash
  // nor the welcome shows". Both were correct — the splash plays once per
  // workspace, the guide only when nothing is connected — and both were
  // therefore unwatchable the moment the app was working, including by the
  // person who built them.
  const profile = freshProfile();
  const app = await launchApp({ profile, splash: true });

  try {
    const page = await app.firstWindow();

    // First launch: splash, then the guide. Skip it and connect nothing.
    await page.waitForSelector('.splash');
    await page.waitForSelector('.splash', { state: 'detached', timeout: 15_000 });
    await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('intro-skip').click();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);

    // On demand, both come back — in order, and from the beginning.
    await page.getByTestId('nav-setup').click();
    await page.waitForSelector('.splash');
    await page.waitForSelector('.splash', { state: 'detached', timeout: 15_000 });
    await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'welcome');
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('the intro replays even on a workspace that is already set up', async () => {
  // The state the founder was actually in: splash seen, a provider connected.
  // Neither gate would fire again, which is correct and is exactly why the
  // replay has to be independent of both.
  const profile = freshProfile();
  const app = await launchApp({ profile, splash: true });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.splash', { state: 'detached', timeout: 15_000 });
    await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 15_000 });

    // Connect something, so both gates are now closed.
    await page.getByTestId('intro-start').click();

    // Real logos, not the monogram fallback: the marks render as images, and
    // the one on the API-key card leans out of its badge rather than sitting
    // squarely inside it.
    const marks = page.locator('.intro__choice .mark--logo img');
    await expect(marks.first()).toBeVisible();
    expect(await marks.count()).toBeGreaterThanOrEqual(3);
    const transform = await marks.first().evaluate((node) => getComputedStyle(node).transform);
    expect(transform).not.toBe('none');

    await page.getByTestId('choose-cloud').click();
    await page.getByTestId('intro-key').fill('sk-a-real-looking-key');
    await page.getByTestId('intro-connect').click();
    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'done', {
      timeout: 15_000,
    });
    await page.getByTestId('intro-finish').click();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);

    await page.getByTestId('nav-setup').click();
    await page.waitForSelector('.splash');
    await page.waitForSelector('.splash', { state: 'detached', timeout: 15_000 });
    await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('the setup guide is reachable again after it has been dismissed', async () => {
  // The bug this exists for: the guide was reachable exactly once, on a
  // workspace that happened to have no connections, and the only way back to
  // it was deleting a directory. A first-run screen nobody can re-open is one
  // nobody can check either.
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('intro-skip').click();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);

    await page.getByTestId('nav-setup').click();
    await page.waitForSelector('.splash', { state: 'detached', timeout: 15_000 });
    await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 15_000 });
    // Back at the beginning, not resumed halfway through.
    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'welcome');
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('setup can be skipped, and does not block the app', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('intro-skip').click();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);

    // Straight into the app, with the canvas reachable — an unconfigured
    // workspace is allowed to be explored, it just cannot run anything.
    await page.getByTestId('nav-build').click();
    await expect(page.getByTestId('canvas-view')).toBeVisible();
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
