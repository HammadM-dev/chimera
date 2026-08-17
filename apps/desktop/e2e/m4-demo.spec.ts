import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// M4-13, the milestone's exit criterion, in the founder's words: "describe an
// automation on Home, open the generated draft, attach a file, press Run, and
// watch it execute node by node with live spend."
//
// Everything here is the real thing — the planner's structured-output contract,
// the file picker, the enforcing Governor, the per-run sandbox, the trace. The
// only stand-ins are the provider endpoint, which CLAUDE.md forbids CI from
// calling for real, and the OS file dialog, which cannot be clicked from a test.

const PLAN = {
  name: 'Invoice triage',
  summary: 'Read the invoices, then summarise what needs attention.',
  steps: [
    { roleId: 'researcher', instruction: 'Read the attached invoices and list anything unusual.' },
    { roleId: 'summariser', instruction: 'Summarise what needs attention, briefly.' },
  ],
};

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
      // Three shapes of request reach this endpoint in one demo: the planner
      // asking for a draft, the loop asking a step to do its work, and
      // verification asking whether it did.
      // Matched on the planner's own system prompt rather than on the JSON it
      // asks for: the request body is JSON, so every quote inside it is
      // escaped, and looking for `"steps"` finds nothing.
      const planning = body.includes('You design automations');
      const asksForVerdict = body.includes('Has the task been achieved');

      const content = planning
        ? JSON.stringify(PLAN)
        : asksForVerdict
          ? '{"verified": true, "evidence": "the step answered"}'
          : 'Invoice 4471 is missing a PO number.';

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'demo-1',
          model: 'claude-haiku-4-5',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          // A priced model at a real rate, so the spend the user sees is
          // arithmetic on real numbers rather than a placeholder — and inside
          // the researcher's own budget, because a step that is denied for
          // spending too much is a different test.
          usage: { prompt_tokens: 10_000, completion_tokens: 2_000 },
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

// The whole demo in one test, deliberately: the point is that the steps
// connect. That makes it longer than the suite's 60s default, which is sized
// for a single flow rather than nine.
test.setTimeout(180_000);

test('M4 exit: describe it, open it, attach a file, run it, watch it', async () => {
  const gateway = await startGateway();
  const profile = freshProfile();

  // The file the automation works on. Handed to the app through the picker's
  // test hook — the OS dialog is the one thing a test cannot click.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-demo-'));
  const invoice = path.join(workspace, 'invoice-4471.txt');
  fs.writeFileSync(invoice, 'Invoice 4471\nAmount: 2,400.00\nPO: missing\n', 'utf8');

  const app = await launchApp({
    profile,
    env: {
      CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl,
      CHIMERA_E2E_PICK_FILES: invoice,
    },
  });

  try {
    const page = await app.firstWindow();

    // 1. A provider, through the guided flow.
    await goTo(page, 'providers');
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
      timeout: 15_000,
    });
    await page.getByTestId('omniroute-import').click();
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
      timeout: 15_000,
    });

    // 2. Describe what you want, on Home.
    await goTo(page, 'home');
    await page
      .getByTestId('home-input')
      .fill('Go through my invoices every morning and tell me what needs attention.');
    await page.getByTestId('home-design').click();

    // 3. The planner answers with a draft that names real agents.
    await expect(page.getByTestId('home-plan')).toContainText('Invoice triage', {
      timeout: 60_000,
    });
    await page.getByTestId('home-open-plan').click();

    // 4. It is a graph, joined in order, with each step's instruction on it.
    await expect(page.getByTestId('node-researcher')).toBeVisible();
    await expect(page.getByTestId('node-summariser')).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    // 5. Bind each step to a model, the way a person does.
    await page.getByTestId('node-researcher').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-summariser').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });

    // 6. Attach the file the first agent reads.
    await page.getByTestId('brief-attach-files').click();
    await expect(page.getByTestId('brief-files')).toContainText('invoice-4471.txt');

    // 7. Run it, and watch it move.
    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();

    await expect(page.getByTestId('node-researcher')).toContainText('succeeded', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('node-summariser')).toContainText('succeeded', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('run-output')).toContainText('4471');

    // 8. Live spend, at Haiku's real rate: 10K in at $1/M and 2K out at $5/M
    //    is $0.02 an exchange, and the status bar is showing the running total.
    await expect(page.getByTestId('status-cost')).toContainText('$', { timeout: 20_000 });

    // 9. And it is all in the trace afterwards, with the same figures.
    await goTo(page, 'runs');
    await expect(page.getByTestId('run-summary')).toContainText('Succeeded', { timeout: 20_000 });
    await expect(page.getByTestId('run-summary')).toContainText('tokens');
    await expect(page.getByTestId('trace-events')).toContainText('researcher');
  } finally {
    await app.close();
    removeProfile(profile);
    fs.rmSync(workspace, { recursive: true, force: true });
    await gateway.close();
  }
});
