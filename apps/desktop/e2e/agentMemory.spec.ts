import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// An agent writing memory during a real run, and that memory appearing in the
// Memory section attributed to the agent rather than to the user.
//
// Scripted rather than left to a model's judgement: whether a given model
// decides something is worth remembering is not what this test is about. What
// it is about is that when an agent does decide, the tool call reaches the
// store, survives the run, and is distinguishable from something a person
// typed.

async function startGateway(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let calls = 0;

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
      calls += 1;
      const asksForVerdict = body.includes('Has the task been achieved');

      // Second call is the act step: remember something. Everything else is
      // prose, and the verify step confirms.
      const message =
        !asksForVerdict && calls === 2
          ? {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'memory__remember',
                    arguments: JSON.stringify({
                      kind: 'preference',
                      subject: 'Reporting style',
                      body: 'Hammad wants failures stated plainly, not softened.',
                      confidence: 0.8,
                      tags: ['communication'],
                    }),
                  },
                },
              ],
            }
          : {
              role: 'assistant',
              content: asksForVerdict
                ? '{"verified": true, "evidence": "the preference was recorded"}'
                : 'Noted it.',
            };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'run-1',
          model: 'claude-haiku-4-5',
          choices: [{ index: 0, message, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 10 },
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

test('an agent remembers something mid-run, and it lands in the Memory section', async () => {
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
    // The researcher can write memory; the reviewer, deliberately, cannot.
    await page.getByTestId('palette-researcher').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Note how Hammad wants reporting done.');
    await page.getByTestId('brief-input').fill('Record the preference.');
    await page.getByTestId('brief-run').click();
    await expect(page.getByTestId('run-note')).toBeVisible({ timeout: 60_000 });

    await goTo(page, 'memory');
    await expect(page.getByTestId('memory-card')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId('memory-card')).toContainText('Reporting style');
    await expect(page.getByTestId('memory-card')).toContainText('stated plainly');

    // Attributed to the agent, and not at the certainty a person's own
    // statement carries.
    await expect(page.getByTestId('memory-card')).toContainText('agent');
    await expect(page.getByTestId('memory-card')).toContainText('confident');
    await expect(page.getByTestId('memory-view')).toContainText('Preferences');
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
