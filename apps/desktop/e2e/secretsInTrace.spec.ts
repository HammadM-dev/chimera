import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { desktopRoot, freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// CLAUDE.md: "Secrets never leave the vault. Not into SQLite, not into logs,
// not into run traces, not into error messages."
//
// The trace sink has always had a redaction hook and has always been handed an
// empty list, on the reasoning that nothing in the runtime holds a plaintext
// credential. Plugins broke that reasoning: a plugin's key is resolved from the
// vault into a real environment variable for a server this build has never
// seen, and whatever that server says comes back as a tool result and is
// written to the trace verbatim.

const SECRET = 'sk-live-DO-NOT-LEAK-8f3a91';

test.describe.configure({ timeout: 240_000 });

/** Answers with one tool call, then a plain answer. */
async function startGateway(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let called = false;
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
      const verdict = body.includes('Has the task been achieved');
      const answer = (): unknown => {
        if (verdict) return { role: 'assistant', content: '{"verified": true, "evidence": "ok"}' };
        // Only when the tool is genuinely on offer. Keyed off a counter, the
        // one tool call went to the first request that arrived — which was a
        // call with no tools offered, so nothing ran and the test proved
        // nothing while passing.
        if (!called && body.includes('mailer__whoami')) {
          called = true;
          return {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'mailer__whoami', arguments: '{}' },
              },
            ],
          };
        }
        return { role: 'assistant', content: 'Checked who the mailer is signed in as.' };
      };
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          id: 'g-1',
          model: 'claude-haiku-4-5',
          choices: [{ index: 0, message: answer(), finish_reason: 'stop' }],
          usage: { prompt_tokens: 80, completion_tokens: 12 },
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

test("a plugin's key does not reach the trace, even when the plugin says it out loud", async () => {
  const gateway = await startGateway();
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl } });

  try {
    const page = await app.firstWindow();

    await goTo(page, 'providers');
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
      timeout: 20_000,
    });
    await page.getByTestId('omniroute-import').click();
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
      timeout: 20_000,
    });

    const fixture = path.join(desktopRoot, 'e2e', 'fixtures', 'mcp-plugin.mjs');
    await page.getByTestId('plugin-add').click();
    await page.getByTestId('plugin-name').fill('mailer');
    await page.getByTestId('plugin-command').fill(process.execPath);
    await page.getByTestId('plugin-args').fill(fixture);
    await page.getByTestId('plugin-secrets').fill(`PLUGIN_TOKEN=${SECRET}`);
    await page.getByTestId('plugin-save').click();
    await expect(page.getByTestId('plugins-panel')).toContainText('mailer', { timeout: 25_000 });
    await page.locator('[data-testid^="plugin-test-"]').first().click();
    // A concrete count. Waiting for the word "tools" matched the panel's own
    // description and let this carry on before the plugin had connected.
    await expect(page.getByTestId('plugins-panel')).toContainText('2 tools', { timeout: 30_000 });

    await goTo(page, 'agents');
    await page.getByTestId('agent-add').click();
    await page.getByTestId('agent-name').fill('Checker');
    await page.getByTestId('agent-prompt').fill('You check who the mailer is signed in as.');
    await page.getByTestId('agent-tool-mailer.whoami').check();
    await page.getByTestId('agent-save').click();
    await expect(page.getByTestId('agent-card-checker')).toBeVisible({ timeout: 20_000 });

    await goTo(page, 'build');
    await page.getByTestId('palette-checker').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Ask the mailer who it is.');
    await page.getByTestId('node-preauthorise').check();
    await page.getByTestId('brief-input').fill('Check the mailer.');
    await page.getByTestId('brief-name').fill('Who is the mailer');
    await expect(page.getByTestId('brief-run')).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId('brief-run').click();
    await expect(page.getByTestId('run-result')).toBeVisible({ timeout: 180_000 });

    // The whole trace, as stored — every event, every payload.
    const trace = await page.evaluate(async () => {
      const chimera = (
        window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).chimera;
      const runs = (await chimera.invoke('run:list', {})) as { runs: { id: string }[] };
      const runId = runs.runs[0]?.id ?? '';
      const events = (await chimera.invoke('trace:list', { runId })) as { events: unknown[] };
      return JSON.stringify(events);
    });

    // The tool really did run and really did say it, so this is a live check
    // rather than a test that passes because nothing happened.
    // The tool really ran and really said it: without this the assertion below
    // passes on a run where nothing was called.
    expect(trace).toContain('tool_result');
    expect(trace).toContain('Signed in with token');
    expect(trace).not.toContain(SECRET);
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
