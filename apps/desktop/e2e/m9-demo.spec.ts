import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// M9-6, the milestone's exit criterion as the roadmap defines it: an automation
// fires from a schedule and from a file drop with nobody starting it; one with a
// failing check cannot be marked trusted; and the cost view attributes the
// spend those runs actually made.

async function startGateway(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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
      const asksForVerdict = body.includes('Has the task been achieved');
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          id: 'm9-1',
          model: 'claude-haiku-4-5',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: asksForVerdict
                  ? '{"verified": true, "evidence": "it answered"}'
                  : 'Handled the overnight batch.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 800, completion_tokens: 120 },
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

/** Runs in the workspace, read the way the app reads them. */
async function runsIn(page: import('@playwright/test').Page) {
  return await page.evaluate(async () => {
    const chimera = (
      window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
    ).chimera;
    const result = (await chimera.invoke('run:list', {})) as {
      runs: { name: string; status: string; triggerType: string }[];
    };
    return result.runs.map((run) => `${run.name}:${run.triggerType}:${run.status}`);
  });
}

test.setTimeout(300_000);

test('M9 exit: it starts itself, refuses a bad tag, and the bill adds up', async () => {
  const gateway = await startGateway();
  const profile = freshProfile();
  const dropFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-m9-'));

  const app = await launchApp({
    profile,
    env: {
      CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl,
      CHIMERA_E2E_PICK_DIRECTORY: dropFolder,
    },
  });

  try {
    const page = await app.firstWindow();

    await goTo(page, 'providers');
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
      timeout: 15_000,
    });
    await page.getByTestId('omniroute-import').click();
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
      timeout: 15_000,
    });

    // 1. An automation on a schedule, saved and left alone.
    await goTo(page, 'build');
    await page.getByTestId('palette-summariser').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Handle the overnight batch.');
    await page.getByTestId('brief-input').fill('Handle the overnight batch.');
    await page.getByTestId('brief-name').fill('Overnight batch');

    await page.getByTestId('trigger-add').selectOption('schedule');
    // Every minute, so the demo does not take until nine in the morning.
    await page.getByTestId('trigger-cron-0').fill('* * * * *');

    // A check that cannot pass, so the trusted tag has something to refuse.
    await page.getByTestId('check-add').click();
    await page.getByTestId('check-name-0').fill('Mentions the invoice total');
    await page.getByTestId('check-input-0').fill('Handle the overnight batch.');
    await page.getByTestId('check-answer-0').fill('Handled the overnight batch.');
    await page.getByTestId('check-contains-0').fill('total was');

    await page.getByTestId('brief-save').click();
    await expect(page.getByTestId('run-note')).toContainText('Saved as version 1');

    // 2. A second automation, on a file drop.
    await page.getByTestId('nav-new').click();
    await page.getByTestId('palette-summariser').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Read whatever landed.');
    await page.getByTestId('brief-input').fill('Read whatever landed.');
    await page.getByTestId('brief-name').fill('Drop watcher');
    await page.getByTestId('trigger-add').selectOption('folderDrop');
    await page.getByTestId('brief-save').click();
    await expect(page.getByTestId('run-note')).toContainText('Saved as version 1');

    fs.writeFileSync(path.join(dropFolder, 'batch.txt'), 'Two orders, both paid.\n', 'utf8');

    // Nobody presses Run. Both of them start on their own — the schedule inside
    // the minute, the drop as soon as the file settles.
    await expect
      .poll(async () => await runsIn(page), { timeout: 180_000, intervals: [2000] })
      .toEqual(
        expect.arrayContaining([
          'Overnight batch:schedule:succeeded',
          'Drop watcher:folderDrop:succeeded',
        ]),
      );

    // 3. The failing check blocks the trusted tag.
    await goTo(page, 'build');
    await page.getByTestId('saved-list').getByText('Overnight batch').click();
    await expect(page.getByTestId('check-name-0')).toHaveValue('Mentions the invoice total');
    await page.getByTestId('check-run').click();
    await expect(page.getByTestId('check-result-0')).toContainText('failed', { timeout: 60_000 });
    await page.getByTestId('check-tag').click();
    await expect(page.getByTestId('run-note')).toContainText('not all passed');

    // 4. And the bill is attributed, over a window covering these runs.
    await goTo(page, 'runs');
    await page.getByTestId('runs-refresh').click();
    await page.getByTestId('runs-costs-toggle').click();
    await expect(page.getByTestId('costs-by-automation')).toContainText('Overnight batch', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('costs-by-automation')).toContainText('Drop watcher');
    await expect(page.getByTestId('costs-by-agent')).toContainText('summariser');
    await expect(page.getByTestId('costs-by-model')).toContainText('claude-haiku-4-5');
  } finally {
    await app.close();
    removeProfile(profile);
    fs.rmSync(dropFolder, { recursive: true, force: true });
    await gateway.close();
  }
});
