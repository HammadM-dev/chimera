import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {
  dismissOnboarding,
  freshProfile,
  goTo,
  joinSteps,
  launchApp,
  removeProfile,
} from './support/app.ts';

// Frames for the README's demonstrations.
//
// Not a test — a recorder. It drives the real application through the two
// things worth showing and writes numbered PNGs, which `scripts/build-readme-
// assets.mjs` turns into animations. Kept here rather than in `scripts/`
// because driving the app is what this directory already knows how to do, and
// a second copy of the launch, onboarding and canvas helpers would drift from
// the ones the suite maintains.
//
// Skipped unless asked for, the same way the live suite is: recording takes
// minutes, writes megabytes, and has nothing to assert.
//
//   CHIMERA_RECORD=1 npx playwright test e2e/assets.spec.ts
//
// A stub gateway rather than a real provider, deliberately. A demonstration
// should show the same thing every time it is recorded, and a screenshot of a
// live model's prose is a screenshot of one sentence it happened to produce.

const RECORDING = process.env['CHIMERA_RECORD'] !== undefined;

const MODELS = ['chimera-standard', 'chimera-fast', 'chimera-deep'];

/**
 * A gateway that answers in the shape each caller expects.
 *
 * Not one canned reply for everything: the swarm asks for a cast of personas
 * and then for each one's position as JSON, and a stub that returns prose to
 * those produces a crowd of nobody — which is exactly what the first recording
 * showed, a swarm that ran correctly and had nothing to draw.
 */
async function startGateway(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const NAMES = [
    'Priya, operations lead',
    'Tom, warehouse shift',
    'Aoife, finance',
    'Marcus, sales',
    'Lena, engineering',
    'Sam, customer support',
    'Ruth, HR',
    'Dev, logistics',
    'Nora, night shift',
    'Ben, procurement',
  ];
  const VOICES = [
    'Four days would cost us Friday cover, and Friday is when everything breaks.',
    'Every study I have read says output holds. Our own numbers would too.',
    'It is a pay rise dressed as a schedule. I am not against it, but call it that.',
    'The people who benefit least are the ones already covering weekends.',
    'We could trial it for a quarter and actually measure rather than argue.',
    'Customers do not care what days we work. They care that someone answers.',
  ];

  let asked = 0;

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });

      if (req.url?.startsWith('/v1/models') === true) {
        res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
        return;
      }

      let content: string;
      // Matched without the quotes. The instruction reaches here inside a JSON
      // string, so the body holds `\\"personas\\"` and a search for
      // `"personas"` finds nothing — which is how the first two recordings
      // produced a swarm of nobody while the app was working perfectly.
      if (body.includes('personas')) {
        content = JSON.stringify({
          personas: NAMES.map((name, index) => ({
            name,
            description: `Speaks from ${name.split(', ')[1] ?? 'the floor'}.`,
            traits: ['practical', index % 2 === 0 ? 'cautious' : 'impatient'],
          })),
        });
      } else if (
        body.includes('said') &&
        body.includes('position') &&
        body.includes('confidence')
      ) {
        // Spread across the range and drifting as rounds go on, so the graph
        // has something to show rather than one solid block.
        const step = asked;
        asked += 1;
        const position = Math.round(Math.sin(step * 1.7) * 100) / 100;
        content = JSON.stringify({
          said: VOICES[step % VOICES.length],
          position,
          confidence: Math.round((0.5 + Math.abs(position) * 0.4) * 100) / 100,
        });
      } else if (body.includes('four-day')) {
        // The crowd's written summary. Keyed to the demonstration's own
        // question, because a stub that answers every prompt the same way put
        // a paragraph about suppliers under a graph about working hours — and
        // it looked exactly like a bug in the product.
        content =
          'The population split 4 for and 6 against, and the split is not about the ' +
          'evidence. Those closest to Friday cover — the warehouse shift, support, ' +
          'logistics — moved against it as soon as cover was raised. Finance and ' +
          'engineering held for it throughout on output grounds, and nobody argued ' +
          'output was the problem. Two changed their minds after the trial-period ' +
          'proposal, which suggests the disagreement is about who absorbs the risk ' +
          'rather than whether it works.';
      } else {
        content =
          'Checked the three suppliers listed in the brief. Two confirmed stock for ' +
          'Tuesday delivery; the third quoted a fortnight. Full comparison written to ' +
          'suppliers.md, with the quotes beside each other.';
      }

      res.end(
        JSON.stringify({
          id: 'demo',
          model: MODELS[0],
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 412, completion_tokens: 96 },
        }),
      );
    });
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

/**
 * Where the recordings land, one directory per demonstration.
 *
 * Video rather than a screenshot loop. The loop shared one connection with the
 * actions it was filming, so every frame queued behind whatever the test was
 * doing — a seventy-second run produced five frames. The browser records
 * itself at a steady rate and costs the test nothing.
 */
const videoRoot = path.resolve(import.meta.dirname, '..', '..', '..', 'docs', 'assets', 'frames');

/**
 * Saves a recording under a predictable name.
 *
 * Called after the application has closed, not before: the file is finalised
 * when the context goes away, and `saveAs` waits for that — asking while the
 * window is still open waits for something that has not happened yet.
 */
async function keepVideo(
  video: ReturnType<import('@playwright/test').Page['video']>,
  name: string,
): Promise<void> {
  if (!video) return;
  fs.mkdirSync(videoRoot, { recursive: true });
  await video.saveAs(path.join(videoRoot, `${name}.webm`));
}

test.describe('README assets', () => {
  test.skip(!RECORDING, 'set CHIMERA_RECORD=1 to record');
  test.describe.configure({ timeout: 600_000 });

  test('building an automation, and running it', async () => {
    const gateway = await startGateway();
    const profile = freshProfile();
    const app = await launchApp({
      profile,
      recordVideo: { dir: path.join(videoRoot, 'raw'), size: { width: 1280, height: 800 } },
    });

    const page = await app.firstWindow();

    try {
      await page.waitForSelector('[data-testid="app-shell"]');
      await page.waitForSelector('.splash', { state: 'detached', timeout: 20_000 });
      await dismissOnboarding(page);

      await goTo(page, 'providers');
      await page.getByTestId('connection-label').fill('Router');
      await page.getByTestId('connection-kind').selectOption('openai-compatible');
      await page.getByTestId('connection-base-url').fill(gateway.baseUrl);
      await page.getByTestId('connection-key').fill('demo-key');
      await page.getByTestId('connection-create').click();
      await expect(page.getByTestId('connection-row')).toBeVisible({ timeout: 60_000 });

      await goTo(page, 'build');

      {
        // Placed one at a time with a beat between, because the point of the
        // recording is that a person assembles this rather than configures it.
        await page.getByTestId('palette-researcher').click();
        await page.getByTestId('node-model').selectOption({ label: `Router · ${MODELS[0]}` });
        await page.getByTestId('node-instruction').fill('Find three suppliers and compare them.');
        await page.waitForTimeout(2000);

        await page.getByTestId('palette-coder').click();
        await page.getByTestId('node-model').selectOption({ label: `Router · ${MODELS[0]}` });
        await page
          .getByTestId('node-instruction')
          .fill('Write the comparison into suppliers.md and read it back.');
        await page.waitForTimeout(2000);

        await joinSteps(page, 'node-researcher', 'node-coder');
        await page.waitForTimeout(2200);

        await page.getByTestId('brief-name').fill('Supplier comparison');
        await page.getByTestId('brief-input').fill('Which supplier can deliver by Tuesday?');
        await page.waitForTimeout(1800);

        const preauth = page.getByTestId('node-preauthorise');
        if ((await preauth.count()) > 0) await preauth.check();

        await page.getByTestId('brief-run').click();
        await expect(
          page.getByTestId('run-result').or(page.getByTestId('run-note')).first(),
        ).toBeVisible({ timeout: 180_000 });
        await page.waitForTimeout(5000);
      }
    } finally {
      const video = page.video();
      await app.close();
      await keepVideo(video, 'build');
      removeProfile(profile);
      await gateway.close();
    }
  });

  test('a crowd of agents arguing', async () => {
    const gateway = await startGateway();
    const profile = freshProfile();
    const app = await launchApp({
      profile,
      recordVideo: { dir: path.join(videoRoot, 'raw'), size: { width: 1280, height: 800 } },
    });

    const page = await app.firstWindow();

    try {
      await page.waitForSelector('[data-testid="app-shell"]');
      await page.waitForSelector('.splash', { state: 'detached', timeout: 20_000 });
      await dismissOnboarding(page);

      await goTo(page, 'providers');
      await page.getByTestId('connection-label').fill('Router');
      await page.getByTestId('connection-kind').selectOption('openai-compatible');
      await page.getByTestId('connection-base-url').fill(gateway.baseUrl);
      await page.getByTestId('connection-key').fill('demo-key');
      await page.getByTestId('connection-create').click();
      await expect(page.getByTestId('connection-row')).toBeVisible({ timeout: 60_000 });

      await goTo(page, 'swarm');

      {
        await page.getByTestId('swarm-population').fill('120');
        await page.getByTestId('swarm-rounds').fill('2');
        await page
          .getByTestId('swarm-input')
          .fill('Should we move the whole team onto a four-day week?');
        await page.waitForTimeout(900);
        await page.getByTestId('swarm-ask').click();
        await expect(page.getByTestId('swarm-graph')).toBeVisible({ timeout: 180_000 });
        await page.waitForTimeout(20_000);
      }
    } finally {
      const video = page.video();
      await app.close();
      await keepVideo(video, 'swarm');
      removeProfile(profile);
      await gateway.close();
    }
  });
});
