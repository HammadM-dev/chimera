import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// M1-11, the milestone's exit criterion: "connect three providers including
// OmniRoute, chat through each, see live health and cost."
//
// Every connection is created through the real UI form, every message goes
// through the real adapter, and the status bar figures come from a real health
// sweep and the real capability matrix. The only stand-in is the HTTP endpoint
// — CLAUDE.md forbids CI touching a real provider.

interface ChimeraBridge {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
}

/**
 * An OpenAI-shaped gateway.
 *
 * Serves the two endpoints every adapter in this test needs: `/v1/models` for
 * OmniRoute's catalogue import and the health probe's fallback, and
 * `/v1/chat/completions` in both streaming and non-streaming form — the health
 * probe sends a non-streaming ping, the chat panel streams.
 */
async function startGateway(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          // A priced model and an unpriced one, so the picker offers both and
          // the meter has both cases to report.
          data: [{ id: 'claude-haiku-4-5', name: 'claude-haiku-4-5' }, { id: 'omni/local' }],
        }),
      );
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
      const streaming = body.includes('"stream":true');

      if (!streaming) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'probe-1',
            model: 'probe',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(
        `data: ${JSON.stringify({
          id: 'demo-1',
          model: 'demo',
          choices: [{ index: 0, delta: { content: 'ack' }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: 'demo-1',
          model: 'demo',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100_000, completion_tokens: 50_000 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function addConnection(
  page: Page,
  fields: { label: string; kind: string; baseUrl: string; key?: string },
): Promise<void> {
  await goTo(page, 'providers');
  await page.getByTestId('connection-label').fill(fields.label);
  await page.getByTestId('connection-kind').selectOption(fields.kind);
  await page.getByTestId('connection-base-url').fill(fields.baseUrl);
  await page.getByTestId('connection-key').fill(fields.key ?? '');
  await page.getByTestId('connection-create').click();
  await expect(page.getByTestId('connection-error')).toHaveCount(0);
}

async function chatThrough(page: Page, label: string, model: string): Promise<void> {
  await goTo(page, 'chat');
  await expect(page.getByTestId('connection-select')).toContainText(label);
  // Selected by the option's value (the connection id) rather than its label,
  // because the label carries a live health state that changes under the test.
  const value = await page
    .locator('[data-testid="connection-select"] option')
    .filter({ hasText: label })
    .first()
    .getAttribute('value');
  await page.getByTestId('connection-select').selectOption(value);
  // The model control is a picker when the connection has an imported
  // catalogue and a text box when it does not — OmniRoute imports 200+ models,
  // and typing one from memory is not a thing anyone can do.
  const control = page.getByTestId('model-input');
  if ((await control.evaluate((node) => node.tagName)) === 'SELECT') {
    await control.selectOption(model);
  } else {
    await control.fill(model);
  }
  await page.getByTestId('prompt-input').fill(`hello from ${label}`);
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-phase', 'done', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('chat-answer')).toHaveText('ack');
}

test.describe('M1-11 provider layer exit criteria', () => {
  test('three connections including OmniRoute, a chat through each, live health and cost', async () => {
    const gateway = await startGateway();
    const profile = freshProfile();
    const app = await launchApp({
      profile,
      env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl },
    });

    try {
      const page = await app.firstWindow();
      await page.waitForSelector('[data-testid="app-shell"]');

      // 1. A cloud adapter, created through the form.
      await addConnection(page, {
        label: 'OpenAI',
        kind: 'openai',
        baseUrl: gateway.baseUrl,
        key: 'sk-demo-key',
      });

      // 2. OmniRoute, through M1-7's guided flow rather than the form.
      await goTo(page, 'providers');
      await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
        timeout: 15_000,
      });
      await page.getByTestId('omniroute-import').click();
      await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
        timeout: 15_000,
      });

      // 3. A local provider.
      await addConnection(page, { label: 'Ollama', kind: 'ollama', baseUrl: gateway.baseUrl });

      // The OmniRoute row was created by the import, not by the form, so the
      // panel has to have picked it up too.
      await page.reload();
      await page.waitForSelector('[data-testid="app-shell"]');
      const kinds = await page.evaluate(async () => {
        const chimera = (window as unknown as { chimera: ChimeraBridge }).chimera;
        const result = (await chimera.invoke('connection:list', {})) as {
          connections: { kind: string }[];
        };
        return result.connections.map((connection) => connection.kind).sort();
      });
      expect(kinds).toEqual(['ollama', 'omniroute', 'openai']);

      // A streamed response through each of the three. Two run against a model
      // the matrix has a verified price for and one against a model it does
      // not, so the meter has both cases to report.
      await chatThrough(page, 'OpenAI', 'claude-haiku-4-5');
      // Chosen from OmniRoute's imported catalogue through the real picker.
      await chatThrough(page, 'OmniRoute', 'claude-haiku-4-5');
      await chatThrough(page, 'Ollama', 'omni/local');

      // Live health: the bar's states come from a real sweep that probed all
      // three connections, not from the value written at creation time.
      const health = page.getByTestId('status-health');
      await expect(health).toContainText('OpenAI: healthy', { timeout: 20_000 });
      await expect(health).toContainText('OmniRoute: healthy');
      await expect(health).toContainText('Ollama: healthy');

      // Live cost: two priced exchanges at Haiku's rate — 100K in at $1/M and
      // 50K out at $5/M is $0.35 each — plus one that is honestly unpriced.
      await expect(page.getByTestId('status-cost')).toHaveText('$0.7000 this session · 1 unpriced');
    } finally {
      await app.close();
      removeProfile(profile);
      await gateway.close();
    }
  });
});
