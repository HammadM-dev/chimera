import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// M9-1. An automation that starts itself.
//
// The folder-drop trigger is the one worth driving end to end: it is fast, it
// is deterministic, and it exercises the whole path — a saved automation, a
// watcher armed at save time, a file appearing, a run starting with nobody
// looking at the app, and the dropped file reaching the first agent as data.

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
      // The dropped file's contents reach the model, or this answers with the
      // wrong thing and the assertion below fails.
      const sawTheFile = body.includes('ORDER-77');
      const content = asksForVerdict
        ? '{"verified": true, "evidence": "the order was read"}'
        : sawTheFile
          ? 'Read the drop: ORDER-77.'
          : 'I was given nothing to read.';

      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          id: 'trig-1',
          model: 'claude-haiku-4-5',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 400, completion_tokens: 40 },
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

test.setTimeout(180_000);

test('a file landing in a watched folder starts the automation by itself', async () => {
  const gateway = await startGateway();
  const profile = freshProfile();
  const dropFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-drop-'));

  const app = await launchApp({
    profile,
    env: {
      CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl,
      // The folder picker is an OS dialog; the suite hands the path in.
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

    await goTo(page, 'build');
    await page.getByTestId('palette-summariser').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Read the dropped order and summarise it.');
    await page.getByTestId('brief-input').fill('Handle whatever lands in the folder.');
    await page.getByTestId('brief-name').fill('Order intake');

    // The trigger, then the save that arms it.
    await page.getByTestId('trigger-add').selectOption('folderDrop');
    await expect(page.getByTestId('brief-triggers')).toContainText(dropFolder);
    await page.getByTestId('brief-save').click();
    await expect(page.getByTestId('run-note')).toContainText('Saved as version 1');

    // Nobody presses anything. A file simply appears.
    fs.writeFileSync(path.join(dropFolder, 'order.txt'), 'ORDER-77\nTwo widgets\n', 'utf8');

    // Polled from the workspace rather than from the screen: the run happens
    // in the main process with nobody looking, and the Runs list is only a
    // reader of it.
    await expect
      .poll(
        async () =>
          await page.evaluate(async () => {
            const chimera = (
              window as unknown as {
                chimera: { invoke: (c: string, p: unknown) => Promise<unknown> };
              }
            ).chimera;
            const result = (await chimera.invoke('run:list', {})) as {
              runs: { name: string; triggerType: string; status: string }[];
            };
            return result.runs.map((run) => `${run.name}:${run.triggerType}:${run.status}`);
          }),
        { timeout: 90_000, intervals: [1000] },
      )
      .toContain('Order intake:folderDrop:succeeded');

    await goTo(page, 'runs');
    await page.getByTestId('runs-refresh').click();
    // It ran, it says what started it, and the dropped file reached the model.
    await expect(page.getByTestId('run-summary')).toContainText('Succeeded', { timeout: 60_000 });
    await expect(page.getByTestId('trace-events')).toContainText('ORDER-77');
  } finally {
    await app.close();
    removeProfile(profile);
    fs.rmSync(dropFolder, { recursive: true, force: true });
    await gateway.close();
  }
});

test('the run history can be searched, and the costs add up by automation, agent and model', async () => {
  const gateway = await startGateway();
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl } });

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

    // Two runs with different names, so search has something to tell apart.
    for (const name of ['Invoice sweep', 'Weekly digest']) {
      await goTo(page, 'build');
      await page.getByTestId('nav-new').click();
      await page.getByTestId('palette-summariser').click();
      await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
      await page.getByTestId('node-instruction').fill(`Do the ${name.toLowerCase()}.`);
      await page.getByTestId('brief-input').fill(`Do the ${name.toLowerCase()}.`);
      await page.getByTestId('brief-name').fill(name);
      await page.getByTestId('brief-run').click();
      await expect(page.getByTestId('run-note')).toContainText('succeeded', { timeout: 120_000 });
    }

    await goTo(page, 'runs');
    await page.getByTestId('runs-refresh').click();

    // Search narrows the history to the one you meant.
    // Asserted against the list rather than the whole screen: the run that is
    // already open stays open, which is what you want when you search for the
    // next one to compare it with.
    await page.getByTestId('runs-search').fill('invoice');
    await expect(page.getByTestId('runs-list')).toContainText('Invoice sweep');
    await expect(page.getByTestId('runs-list')).not.toContainText('Weekly digest');
    await page.getByTestId('runs-search').fill('');

    // A filter that matches nothing says so rather than showing everything.
    await page.getByTestId('runs-status').selectOption('failed');
    await expect(page.getByTestId('runs-list')).toContainText('No run matches that');
    await page.getByTestId('runs-status').selectOption('all');

    // And the bill, sliced the three ways a person asks about it.
    await page.getByTestId('runs-costs-toggle').click();
    const costs = page.getByTestId('run-costs');
    await expect(costs).toBeVisible();
    await expect(page.getByTestId('costs-total')).toContainText('$', { timeout: 20_000 });
    await expect(page.getByTestId('costs-by-automation')).toContainText('Invoice sweep');
    await expect(page.getByTestId('costs-by-agent')).toContainText('summariser');
    await expect(page.getByTestId('costs-by-model')).toContainText('claude-haiku-4-5');
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});

test('a check runs against a stand-in model, and a failing one blocks the trusted tag', async () => {
  const gateway = await startGateway();
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl } });

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

    await goTo(page, 'build');
    await page.getByTestId('palette-summariser').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Summarise the order.');
    await page.getByTestId('brief-input').fill('Summarise the order.');
    await page.getByTestId('brief-name').fill('Order summary');

    // A check that cannot pass: the stand-in answers one thing and the check
    // demands another.
    await page.getByTestId('check-add').click();
    await page.getByTestId('check-name-0').fill('Says the order number');
    await page.getByTestId('check-input-0').fill('Summarise order 812.');
    await page.getByTestId('check-answer-0').fill('I could not read the order.');
    await page.getByTestId('check-contains-0').fill('812');

    await page.getByTestId('brief-save').click();
    await expect(page.getByTestId('run-note')).toContainText('Saved as version 1');

    await page.getByTestId('check-run').click();
    await expect(page.getByTestId('check-result-0')).toContainText('failed', { timeout: 60_000 });

    // No real provider was touched: the check ran against the mock, so this
    // works on a machine with no keys at all.
    await page.getByTestId('check-tag').click();
    await expect(page.getByTestId('run-note')).toContainText('not all passed');

    // Make it pass, save again, re-check, and the tag is allowed.
    await page.getByTestId('check-answer-0').fill('Order 812 is for two widgets.');
    await page.getByTestId('brief-save').click();
    await page.getByTestId('check-run').click();
    await expect(page.getByTestId('check-result-0')).toContainText('passed', { timeout: 60_000 });

    await page.getByTestId('check-tag').click();
    await expect(page.getByTestId('run-note')).toContainText('trusted one');
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
