import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// Pinning a model, and the two things that make it worth having.
//
// A workspace that connects a router gets several hundred models in a dropdown
// and the two anybody uses are somewhere in the middle. So: the pin has to
// survive a restart, and it has to apply to *every* picker rather than the one
// you happened to be looking at when you set it. The second is the one a
// plausible implementation gets wrong — five pickers each holding their own
// copy of the list looks finished and is wrong everywhere except the control
// under your cursor.

test.describe.configure({ timeout: 240_000 });

const MODELS = ['aardvark-1', 'basilisk-2', 'chimera-3', 'dromedary-4'];

/** A gateway serving several models, so ordering is a question worth asking. */
async function startGateway(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(
      JSON.stringify({
        id: 'r-1',
        model: MODELS[0],
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
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

test('a pinned model goes to the top of every picker, and stays pinned across a restart', async () => {
  const gateway = await startGateway();
  const profile = freshProfile();
  let app = await launchApp({ profile });

  try {
    let page = await app.firstWindow();

    await goTo(page, 'providers');
    await page.getByTestId('connection-label').fill('Router');
    await page.getByTestId('connection-kind').selectOption('openai-compatible');
    await page.getByTestId('connection-base-url').fill(gateway.baseUrl);
    await page.getByTestId('connection-key').fill('test-key');
    await page.getByTestId('connection-create').click();
    await expect(page.getByTestId('connection-row')).toBeVisible({ timeout: 60_000 });

    // The canvas picker, before anything is pinned: the provider's own order.
    await goTo(page, 'build');
    await page.getByTestId('palette-researcher').click();
    const picker = page.getByTestId('node-model');
    await expect(picker).toBeVisible({ timeout: 20_000 });

    // Takes the page rather than closing over it: the restart below replaces
    // the window, and a locator bound to the old one is bound to something
    // that no longer exists.
    const modelsInOrder = async (on: typeof page): Promise<string[]> =>
      (await on.getByTestId('node-model').locator('option').allTextContents())
        .filter((label) => label.includes('·'))
        .map((label) => label.split('·')[1]?.trim() ?? '');

    expect(await modelsInOrder(page)).toEqual(MODELS);

    // Pin the last one — the one that would need the most scrolling.
    const last = MODELS[MODELS.length - 1] ?? '';
    await picker.selectOption({ label: `Router · ${last}` });
    await page.getByTestId('model-pin').click();
    await expect(page.getByTestId('model-pin')).toHaveAttribute('aria-pressed', 'true');

    // It moves to the front, and it is labelled as pinned rather than merely
    // being first — otherwise it is indistinguishable from the provider
    // happening to return it first.
    await expect.poll(async () => (await modelsInOrder(page))[0], { timeout: 10_000 }).toBe(last);
    await expect(picker.locator('optgroup[label="Pinned"]')).toHaveCount(1);

    // Every picker, not just this one. The swarm has its own, in a different
    // section, mounted separately — and with per-hook state it would still be
    // showing the old order.
    await goTo(page, 'swarm');
    const swarmPicker = page.getByTestId('swarm-model');
    await expect(swarmPicker).toBeVisible({ timeout: 20_000 });
    const swarmFirst = ((await swarmPicker.locator('option').allTextContents())[0] ?? '').trim();
    expect(swarmFirst, 'the swarm picker did not see the pin').toContain(last);

    // And it survives the app closing.
    await app.close();
    app = await launchApp({ profile });
    page = await app.firstWindow();

    await goTo(page, 'build');
    await page.getByTestId('palette-researcher').click();
    await expect(page.getByTestId('node-model')).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await modelsInOrder(page))[0], { timeout: 20_000 }).toBe(last);
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
