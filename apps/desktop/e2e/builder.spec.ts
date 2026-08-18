import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopRoot, freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// The builder as a person uses it: several agents feeding one, an agent the
// user wrote themselves, and a result they can actually read afterwards.
//
// Written after the founder ran the first version and reported "it says
// succeeded and there is no output" — which was true: the output was the last
// element of a scrolling panel, under the settings.

async function startGateway(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let sentAlready = false;
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
      // Each shipped role declares its own output contract, and answering
      // prose to a role that demands JSON fails the contract rather than the
      // test's subject. A stub that answered prose everywhere would be testing
      // a laxer product than the one that ships.
      const asksForReview = body.includes('You review work against the task');
      // The notifier agent, mid-plugin test: it is offered the plugin's tool
      // and calls it once, then reports.
      const isNotifier = body.includes('You send one short message');
      const offersTools = body.includes('"tools"');
      const asksForExtraction = body.includes('You pull structured records');
      // Answers differently depending on which agent is asking, so the joined
      // step has three distinguishable things to combine.
      const who = body.includes('the legal view')
        ? 'LEGAL: the contract auto-renews.'
        : body.includes('the money view')
          ? 'MONEY: it is 40k a year.'
          : body.includes('the risk view')
            ? 'RISK: there is no exit clause.'
            : body.includes('Combine')
              ? 'Combined: auto-renewing, 40k a year, no exit clause.'
              : 'Noted.';

      if (isNotifier && offersTools && !asksForVerdict && !sentAlready) {
        sentAlready = true;
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(
          JSON.stringify({
            id: 'b-tool',
            model: 'claude-haiku-4-5',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: {
                        name: 'mailer__send',
                        arguments: JSON.stringify({
                          to: 'finance@example.test',
                          subject: 'Contract renewal',
                          body: 'It renews automatically.',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 300, completion_tokens: 40 },
          }),
        );
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          id: 'b-1',
          model: 'claude-haiku-4-5',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: asksForVerdict
                  ? '{"verified": true, "evidence": "answered"}'
                  : asksForReview
                    ? '{"findings":[{"file":"contract.md","summary":"RISK: there is no exit clause."}]}'
                    : asksForExtraction
                      ? '{"records":[{"field":"annual","value":"MONEY: it is 40k a year."}]}'
                      : who,
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 300, completion_tokens: 40 },
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

test.setTimeout(240_000);

test('three agents feed one, and the run shows what every step produced', async () => {
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

    const place = async (paletteId: string, instruction: string) => {
      await page.getByTestId(`palette-${paletteId}`).click();
      await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
      await page.getByTestId('node-instruction').fill(instruction);
    };

    await place('researcher', 'Give me the legal view.');
    // A data extractor rather than a coder: a coder may run shell commands, and
    // M4-6 refuses to run one that nothing has authorised. That rule has its
    // own test; this one is about the shape of the graph.
    await place('data-extractor', 'Give me the money view.');
    // Reviewer rather than QA for the same reason as above: QA runs commands.
    await place('reviewer', 'Give me the risk view.');
    await place('summariser', 'Combine what the others found into one answer.');

    // Three into one — the shape the old one-in-one-out canvas could not draw.
    const join = async (from: string, to: string) => {
      await page
        .locator(`[data-testid="${from}"] .react-flow__handle-right`)
        .dragTo(page.locator(`[data-testid="${to}"] .react-flow__handle-left`));
    };
    await join('node-researcher', 'node-summariser');
    await join('node-data-extractor', 'node-summariser');
    await join('node-reviewer', 'node-summariser');
    await expect(page.locator('.react-flow__edge')).toHaveCount(3);

    await page.getByTestId('brief-input').fill('Look at the contract three ways and combine them.');
    await page.getByTestId('brief-name').fill('Contract review');
    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();

    // The result opens by itself, with the answer in it.
    const result = page.getByTestId('run-result');
    await expect(result).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('run-output')).toContainText('Combined', { timeout: 30_000 });

    // And every step's own output is there, not just the last.
    await expect(page.getByTestId('result-steps')).toContainText('Researcher');
    await expect(page.getByTestId('result-steps')).toContainText('Summariser');
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});

test('an agent the user writes can be built and used in the same session', async () => {
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

    // Built from the palette, where somebody realises they need one.
    await goTo(page, 'build');
    await page.getByTestId('palette-add-agent').click();

    await expect(page.getByTestId('agent-editor')).toBeVisible();
    await page.getByTestId('agent-name').fill('Contract checker');
    await page
      .getByTestId('agent-prompt')
      .fill('You read contracts and report every clause that renews automatically.');
    await page.getByTestId('agent-tool-memory.recall').check();
    await page.getByTestId('agent-iterations').fill('4');
    await page.getByTestId('agent-save').click();

    // It is on the roster…
    await expect(page.getByTestId('agent-card-contract-checker')).toBeVisible({ timeout: 20_000 });

    // …and in the palette, immediately, without a restart.
    await goTo(page, 'build');
    await page.getByTestId('palette-contract-checker').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Check this contract.');
    await page.getByTestId('brief-input').fill('Check the attached contract.');
    await page.getByTestId('brief-name').fill('Contract check');

    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();
    await expect(page.getByTestId('run-result')).toBeVisible({ timeout: 180_000 });
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});

test('a plugin brings tools an agent can be granted, and they really run', async () => {
  const gateway = await startGateway();
  const profile = freshProfile();
  const outbox = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-plugin-')),
    'outbox.jsonl',
  );
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

    // A real MCP server, added the way somebody would add a community one.
    const fixture = path.join(desktopRoot, 'e2e', 'fixtures', 'mcp-plugin.mjs');
    await page.getByTestId('plugin-add').click();
    await page.getByTestId('plugin-name').fill('mailer');
    await page.getByTestId('plugin-command').fill(process.execPath);
    await page.getByTestId('plugin-args').fill(fixture);
    // A key it needs, typed here and never stored in the workspace file.
    await page
      .getByTestId('plugin-secrets')
      .fill(`PLUGIN_TOKEN=secret-token\nPLUGIN_OUTBOX=${outbox}`);
    await page.getByTestId('plugin-save').click();

    // It connects and says what it brings.
    const row = page.locator('[data-testid^="plugin-"][data-testid$="-mailer"]');
    await expect(page.getByTestId('plugins-panel')).toContainText('mailer', { timeout: 20_000 });
    await page.locator('[data-testid^="plugin-test-"]').first().click();
    // A count, not a bare "tools" — that word is in the panel's own
    // description and matches before the plugin has connected at all. Not the
    // exact number, so adding a tool to the fixture does not break this test.
    await expect(page.getByTestId('plugins-panel')).toContainText(/[1-9]\d* tools?:/, {
      timeout: 30_000,
    });
    expect(row).toBeDefined();

    // An agent built around that tool.
    await goTo(page, 'agents');
    await page.getByTestId('agent-add').click();
    await page.getByTestId('agent-name').fill('Notifier');
    await page.getByTestId('agent-prompt').fill('You send one short message and then stop.');
    await page.getByTestId('agent-tool-mailer.send').check();
    await page.getByTestId('agent-save').click();
    await expect(page.getByTestId('agent-card-notifier')).toBeVisible({ timeout: 20_000 });

    // And an automation that uses it. Pre-authorised because a plugin's tools
    // come from a server this build has never seen, so they need a person to
    // say yes — which is the rule working, not a workaround.
    await goTo(page, 'build');
    await page.getByTestId('palette-notifier').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Send the note.');
    await page.getByTestId('node-preauthorise').check();
    await page.getByTestId('brief-input').fill('Tell finance the contract renews.');
    await page.getByTestId('brief-name').fill('Notify finance');

    await expect(page.getByTestId('brief-run')).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId('brief-run').click();
    await expect(page.getByTestId('run-result')).toBeVisible({ timeout: 180_000 });

    // The plugin's own process wrote what it was asked to send, and it had the
    // key it was given — proof the tool ran rather than being described.
    await expect
      .poll(() => (fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8') : ''), {
        timeout: 30_000,
        intervals: [500],
      })
      .toContain('finance@example.test');
    expect(fs.readFileSync(outbox, 'utf8')).toContain('"tokenSeen":true');
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
