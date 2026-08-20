import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { freshProfile, goTo, joinSteps, launchApp, removeProfile } from './support/app.ts';

// Not a test: a way to look at the product.
//
// It asserts almost nothing — it walks every view and photographs it, so a
// design pass can be reviewed against what the app actually renders rather
// than against what the CSS was meant to do. That review is worth two minutes
// of somebody's attention and is worth nothing in CI, so it is opt-in:
//
//   CHIMERA_SHOTS=1 npx playwright test e2e/shots.spec.ts
//
// The window is deliberately left at whatever size the app opens at. Taking
// these at a roomier 1440x900 is how a brief panel that covered the Run button
// at the real default size got through a review.

const SHOTS = process.env.CHIMERA_SHOT_DIR ?? 'test-results/shots';

async function startGateway(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }, { id: 'claude-sonnet-4-6' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const verdict = body.includes('Has the task been achieved');
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          id: 's-1',
          model: 'claude-haiku-4-5',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: verdict
                  ? '{"verified": true, "evidence": "answered"}'
                  : 'The agreement renews automatically on 1 March unless notice is given 90 days beforehand. Two invoices are missing purchase-order numbers: INV-1001 and INV-1044.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1200, completion_tokens: 180 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('every view, photographed', async () => {
  test.skip(process.env.CHIMERA_SHOTS !== '1', 'Set CHIMERA_SHOTS=1 to take screenshots.');
  test.setTimeout(300_000);
  const gateway = await startGateway();
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl } });

  try {
    const page = await app.firstWindow();
    const shot = async (name: string) => {
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    };
    process.stdout.write(`Screenshots: ${path.resolve(SHOTS)}\n`);

    await goTo(page, 'providers');
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
      timeout: 15_000,
    });
    await page.getByTestId('omniroute-import').click();
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
      timeout: 15_000,
    });
    await shot('providers');

    await goTo(page, 'home');
    await shot('home');

    await goTo(page, 'agents');
    await shot('agents');
    await page.getByTestId('agent-add').click();
    await shot('agent-editor');
    await page.getByTestId('agent-cancel').click();

    await goTo(page, 'build');
    const place = async (id: string, instruction: string) => {
      await page.getByTestId(`palette-${id}`).click();
      await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
      await page.getByTestId('node-instruction').fill(instruction);
    };
    await place('researcher', 'Read the agreement and report the renewal terms.');
    await place('data-extractor', 'Pull every invoice number and amount.');
    await place('summariser', 'Write the note for the finance director.');
    const join = async (from: string, to: string) => {
      await joinSteps(page, from, to);
    };
    await join('node-researcher', 'node-summariser');
    await join('node-data-extractor', 'node-summariser');
    await page.getByTestId('brief-input').fill('Review the supplier agreement and the invoices.');
    await page.getByTestId('brief-name').fill('Supplier review');
    await shot('canvas');

    await page.getByTestId('brief-run').click();
    await expect(page.getByTestId('run-result')).toBeVisible({ timeout: 120_000 });
    await shot('result');

    await goTo(page, 'runs');
    await page.getByTestId('runs-refresh').click();
    await shot('runs');
    await page.getByTestId('runs-costs-toggle').click();
    await shot('costs');

    await goTo(page, 'memory');
    await shot('memory');

    // The panels added since: mailboxes, granted folders, plugins, and the
    // remove control on a connection.
    await goTo(page, 'providers');
    await page.getByTestId('email-add').click();
    await shot('providers-email');
    await page.getByTestId('email-cancel').click();

    // A saved automation in the sidebar, with its remove control showing.
    await goTo(page, 'build');
    await page.getByTestId('palette-summariser').click();
    await page.getByTestId('brief-input').fill('Summarise the week.');
    await page.getByTestId('brief-name').fill('Weekly summary');
    await page.getByTestId('brief-save').click();
    await page.locator('.sidebar__saved').first().hover();
    await shot('sidebar-saved');
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
