import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// M4-3 and M4-4: the node types that are not agents, built on the real canvas
// and run by the real executor. A branch that sends the run one way, and a gate
// that stops it until a person answers.
//
// The only stand-in is the provider endpoint.

async function startGateway(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }] }));
      return;
    }
    if (req.url?.startsWith('/v1/chat/completions') !== true) {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const asksForVerdict = body.includes('Has the task been achieved');
      const content = asksForVerdict
        ? '{"verified": true, "evidence": "the step produced its answer"}'
        : 'The report is ready to send.';

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'run-1',
          model: 'claude-haiku-4-5',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 12 },
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

/** Imports OmniRoute's catalogue so the model picker has something in it. */
async function connectProvider(page: Page): Promise<void> {
  await goTo(page, 'providers');
  await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
    timeout: 15_000,
  });
  await page.getByTestId('omniroute-import').click();
  await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
    timeout: 15_000,
  });
}

async function join(page: Page, from: string, to: string, handle?: 'true' | 'false'): Promise<void> {
  const source =
    handle === undefined
      ? page.locator(`[data-testid="${from}"] .react-flow__handle-bottom`)
      : page.locator(`[data-testid="${from}"] [data-handleid="${handle}"]`);
  await source.dragTo(page.locator(`[data-testid="${to}"] .react-flow__handle-top`));
}

test('a branch sends the run down one path and leaves the other alone', async () => {
  const gateway = await startGateway();
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl } });

  try {
    const page = await app.firstWindow();
    await connectProvider(page);
    await goTo(page, 'build');

    await page.getByTestId('palette-researcher').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Write the report.');

    // The branch. Its test is a declared comparison, chosen from a list —
    // there is no expression to type, and nothing here evaluates code.
    await page.getByTestId('palette-condition').click();
    await expect(page.getByTestId('brief-blocked')).toContainText('branch needs somewhere to go');
    await page.getByTestId('condition-test').selectOption('contains');
    await page.getByTestId('condition-value').fill('ready to send');

    await page.getByTestId('palette-summariser').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Summarise the report.');

    await page.getByTestId('palette-coder').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Fix the report.');

    await join(page, 'node-researcher', 'node-condition');
    await join(page, 'node-condition', 'node-summariser', 'true');
    await join(page, 'node-condition', 'node-coder', 'false');

    await page.getByTestId('brief-input').fill('Write a report, then check it.');
    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();

    await expect(page.getByTestId('run-note')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('node-researcher')).toContainText('succeeded');
    await expect(page.getByTestId('node-condition')).toContainText('succeeded');
    // The model's answer contains "ready to send", so the yes path runs…
    await expect(page.getByTestId('node-summariser')).toContainText('succeeded');
    // …and the no path is not merely unfinished, it never started. A status of
    // any kind here would mean the branch decided nothing.
    await expect(page.getByTestId('node-coder')).not.toContainText('succeeded');
    await expect(page.getByTestId('node-coder')).not.toContainText('running');
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});

test('an approval gate stops the run until a person answers it', async () => {
  const gateway = await startGateway();
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl } });

  try {
    const page = await app.firstWindow();
    await connectProvider(page);
    await goTo(page, 'build');

    await page.getByTestId('palette-researcher').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Draft the report.');

    await page.getByTestId('palette-approval').click();
    await expect(page.getByTestId('brief-blocked')).toContainText('needs a question');
    await page.getByTestId('approval-prompt').fill('Send this report?');

    await page.getByTestId('palette-summariser').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Send the report.');

    await join(page, 'node-researcher', 'node-approval');
    await join(page, 'node-approval', 'node-summariser');

    await page.getByTestId('brief-input').fill('Draft a report and send it.');
    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();

    // The run stops here. The question is the one the builder wrote, and what
    // is being approved is shown alongside it — approving something you cannot
    // see is not approval.
    const gate = page.getByTestId('approval');
    await expect(gate).toBeVisible({ timeout: 60_000 });
    await expect(gate).toContainText('Send this report?');
    await expect(page.getByTestId('approval-context')).toContainText('ready to send');

    // Nothing past the gate has moved while it waits.
    await expect(page.getByTestId('node-summariser')).not.toContainText('succeeded');

    await page.getByTestId('approval-note').fill('Looks right.');
    await page.getByTestId('approval-approve').click();

    await expect(gate).toHaveCount(0);
    await expect(page.getByTestId('node-summariser')).toContainText('succeeded', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('run-note')).toBeVisible();
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
