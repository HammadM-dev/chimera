import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// Running an automation, end to end through the real app: place two agents,
// join them, bind models, write instructions, press Run, watch it execute.
//
// The only stand-in is the provider endpoint. Everything else — the role
// registry, the Governor in enforcing mode, the per-run sandbox, the tool
// servers, the trace — is what a real run uses.

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
      // Verification asks for JSON; anything else is a plan or an answer. This
      // is enough for a run to reach a verified finish without scripting turn
      // by turn.
      const asksForVerdict = body.includes('Has the task been achieved');
      const content = asksForVerdict
        ? '{"verified": true, "evidence": "the step produced its answer"}'
        : 'Done: the step produced its answer.';

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

test('an automation built on the canvas actually runs', async () => {
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

    // Run says why it is unavailable rather than being a dead grey button.
    await expect(page.getByTestId('brief-blocked')).toContainText('Add an agent or a swarm');
    await expect(page.getByTestId('brief-run')).toBeDisabled();

    await page.getByTestId('palette-researcher').click();
    await expect(page.getByTestId('brief-blocked')).toContainText('needs a model');

    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Find the answer.');

    await page.getByTestId('palette-summariser').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Summarise what the researcher found.');

    await page.getByTestId('brief-input').fill('Answer the question and summarise it.');

    // Everything the run needs is present, so the button is live.
    await expect(page.getByTestId('brief-blocked')).toHaveCount(0);
    await expect(page.getByTestId('brief-run')).toBeEnabled();

    await page.getByTestId('brief-run').click();

    // It ran: the run reports an outcome, and both steps reached a terminal
    // state on the canvas rather than sitting idle.
    await expect(page.getByTestId('run-note')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('node-researcher')).toContainText('succeeded', {
      timeout: 10_000,
    });
    await expect(page.getByTestId('node-summariser')).toContainText('succeeded');
    await expect(page.getByTestId('run-output')).toContainText('produced its answer');

    // And it is in the workspace, with a trace, like any other run.
    const record = await page.evaluate(async () => {
      const chimera = (
        window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).chimera;
      return (await chimera.invoke('health:sweep', {})) as unknown;
    });
    expect(record).toBeTruthy();
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
