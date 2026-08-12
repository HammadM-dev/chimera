import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// M1-10 end to end: a real Electron app, the real preload bridge, the real
// adapter, and a real SSE stream from a local server. No provider is mocked at
// the adapter layer — the only stand-in is the HTTP endpoint itself, which is
// what makes this exercise the whole path rather than a slice of it.

interface ChimeraBridge {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
  parseError: (err: unknown) => { code: string; message: string } | null;
}

interface StubOptions {
  /** Status for the completions call. 401 drives the auth-failure case. */
  status?: number;
  /** Text chunks streamed one at a time. */
  chunks?: string[];
  /** Delay between chunks, so incremental rendering is observable. */
  delayMs?: number;
}

async function startStub(
  options: StubOptions,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { status = 200, chunks = ['Hello', ' from', ' the', ' stub'], delayMs = 120 } = options;

  const server: Server = createServer((req, res) => {
    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    let index = 0;
    const pump = (): void => {
      if (index < chunks.length) {
        res.write(
          `data: ${JSON.stringify({
            id: 'stub-1',
            model: 'stub-model',
            choices: [{ index: 0, delta: { content: chunks[index] }, finish_reason: null }],
          })}\n\n`,
        );
        index += 1;
        setTimeout(pump, delayMs);
        return;
      }
      res.write(
        `data: ${JSON.stringify({
          id: 'stub-1',
          model: 'stub-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    };
    setTimeout(pump, delayMs);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function createConnection(page: Page, baseUrl: string, inlineKey: string): Promise<string> {
  return page.evaluate(
    async ({ baseUrl: url, inlineKey: key }) => {
      const chimera = (window as unknown as { chimera: ChimeraBridge }).chimera;
      const created = (await chimera.invoke('connection:create', {
        label: 'Local stub',
        kind: 'openai-compatible',
        baseUrl: url,
        inlineKey: key,
      })) as { id: string };
      return created.id;
    },
    { baseUrl, inlineKey },
  );
}

test.describe('M1-10 streaming chat panel', () => {
  test('a streamed answer renders incrementally, not as one final blob', async () => {
    const stub = await startStub({});
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await goTo(page, 'chat');
      await page.waitForSelector('[data-testid="chat-panel"]');

      await createConnection(page, stub.baseUrl, 'sk-stub-key');
      // The panel loads its connections on mount; reloading is the simplest
      // honest way to pick up a row created after that.
      await page.reload();
      await goTo(page, 'chat');
      await page.waitForSelector('[data-testid="chat-panel"]');

      await page.getByTestId('model-input').fill('stub-model');
      await page.getByTestId('prompt-input').fill('say hello');

      // Sample the answer element while the stream is in flight. A panel that
      // rendered one blob at the end would only ever be observed empty and
      // then complete — never partial.
      const observed = new Set<string>();
      const sampler = setInterval(() => {
        void page
          .getByTestId('chat-answer')
          // A short timeout, deliberately. The transcript only creates an agent
          // turn once a message is sent, so before the click this element does
          // not exist — and `textContent()` auto-waits 30s for a missing
          // element. At 40ms a sample that is a hundred pending waits deep
          // starves the click that follows it, and the test times out having
          // measured nothing. A miss must be cheap.
          .textContent({ timeout: 250 })
          .then((text) => {
            if (text !== null) observed.add(text);
          })
          .catch(() => undefined);
      }, 40);

      await page.getByTestId('send-button').click();
      await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-phase', 'done', {
        timeout: 15_000,
      });
      clearInterval(sampler);

      const final = (await page.getByTestId('chat-answer').textContent()) ?? '';
      expect(final).toBe('Hello from the stub');

      const partials = [...observed].filter((text) => text !== '' && text !== final);
      expect(
        partials.length,
        `expected to observe partial renders, saw only: ${JSON.stringify([...observed])}`,
      ).toBeGreaterThan(0);
      // Every partial must be a prefix of the final answer — otherwise the
      // panel is re-rendering rather than accumulating.
      for (const partial of partials) expect(final.startsWith(partial)).toBe(true);
    } finally {
      await app.close();
      removeProfile(profile);
      await stub.close();
    }
  });

  test('the panel reports token counts and a cost figure once the stream finishes', async () => {
    const stub = await startStub({ delayMs: 20 });
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await goTo(page, 'chat');
      await page.waitForSelector('[data-testid="chat-panel"]');
      await createConnection(page, stub.baseUrl, 'sk-stub-key');
      await page.reload();
      await goTo(page, 'chat');
      await page.waitForSelector('[data-testid="chat-panel"]');

      // A model the capability matrix has a verified price for, so the figure
      // is a real number rather than "not priced".
      await page.getByTestId('model-input').fill('claude-haiku-4-5');
      await page.getByTestId('prompt-input').fill('hello');
      await page.getByTestId('send-button').click();

      await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-phase', 'done', {
        timeout: 15_000,
      });

      // The counts come from the provider's own usage block, not from counting
      // characters in the UI.
      await expect(page.getByTestId('token-count')).toHaveText('11 in · 7 out');
      const cost = (await page.getByTestId('cost-estimate').textContent()) ?? '';
      expect(cost).toMatch(/^\$0\.0000/);
    } finally {
      await app.close();
      removeProfile(profile);
      await stub.close();
    }
  });

  test('an unpriced model shows "Not priced" rather than a misleading $0.00', async () => {
    const stub = await startStub({ delayMs: 20 });
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await goTo(page, 'chat');
      await page.waitForSelector('[data-testid="chat-panel"]');
      await createConnection(page, stub.baseUrl, 'sk-stub-key');
      await page.reload();
      await goTo(page, 'chat');
      await page.waitForSelector('[data-testid="chat-panel"]');

      await page.getByTestId('model-input').fill('some-unknown-model');
      await page.getByTestId('prompt-input').fill('hello');
      await page.getByTestId('send-button').click();

      await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-phase', 'done', {
        timeout: 15_000,
      });
      // Reading "free" off a model nobody has a rate for is the one wrong
      // answer here that costs money.
      await expect(page.getByTestId('cost-estimate')).toHaveText('Not priced');
    } finally {
      await app.close();
      removeProfile(profile);
      await stub.close();
    }
  });

  test('an invalid key surfaces as an inline error, not a crash or unhandled rejection', async () => {
    const stub = await startStub({ status: 401 });
    const profile = freshProfile();
    const app = await launchApp({ profile });

    const pageErrors: string[] = [];

    try {
      const page = await app.firstWindow();
      page.on('pageerror', (err) => pageErrors.push(err.message));
      await goTo(page, 'chat');
      await page.waitForSelector('[data-testid="chat-panel"]');

      await createConnection(page, stub.baseUrl, 'sk-wrong-key');
      await page.reload();
      await goTo(page, 'chat');
      await page.waitForSelector('[data-testid="chat-panel"]');
      page.on('pageerror', (err) => pageErrors.push(err.message));

      await page.getByTestId('model-input').fill('stub-model');
      await page.getByTestId('prompt-input').fill('hello');
      await page.getByTestId('send-button').click();

      await expect(page.getByTestId('chat-error')).toBeVisible({ timeout: 15_000 });
      const message = (await page.getByTestId('chat-error').textContent()) ?? '';
      expect(message.toLowerCase()).toContain('credential');

      // The panel is still alive and usable — an unhandled rejection would
      // have taken the React tree out and told the user nothing.
      await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-phase', 'failed');
      await expect(page.getByTestId('send-button')).toBeEnabled();
      expect(pageErrors, `renderer threw: ${pageErrors.join('; ')}`).toEqual([]);

      // The key must not reach the error surfaced to the user.
      expect(message).not.toContain('sk-wrong-key');
    } finally {
      await app.close();
      removeProfile(profile);
      await stub.close();
    }
  });

  test('connection:create and vault:setSecret log their channel but never their payload', async () => {
    const stub = await startStub({ delayMs: 10 });
    const profile = freshProfile();
    const app = await launchApp({ profile });

    let mainOutput = '';
    app.process().stdout?.on('data', (chunk: Buffer) => {
      mainOutput += chunk.toString();
    });

    const canary = 'sk-canary-must-not-be-logged-1234567890';

    try {
      const page = await app.firstWindow();
      await goTo(page, 'chat');
      await page.waitForSelector('[data-testid="chat-panel"]');

      await createConnection(page, stub.baseUrl, canary);
      await page.evaluate(async (secret) => {
        const chimera = (window as unknown as { chimera: ChimeraBridge }).chimera;
        await chimera.invoke('vault:setSecret', { scope: 'connection', value: secret });
      }, canary);

      // Both channels are flagged sensitive in the registry. This is the first
      // time that flag meets a real payload rather than a unit-test fixture —
      // M0-4 proved the redaction middleware works, this proves it is wired to
      // the channels that actually carry a credential.
      expect(mainOutput).toContain('connection:create');
      expect(mainOutput).toContain('vault:setSecret');
      expect(mainOutput, 'a credential reached the main-process log').not.toContain(canary);
    } finally {
      await app.close();
      removeProfile(profile);
      await stub.close();
    }
  });
});
