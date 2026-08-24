import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, joinSteps, launchApp, removeProfile } from './support/app.ts';

// "Show me what it is actually doing."
//
// A run window that says "Working" for four minutes is indistinguishable from a
// run window that is stuck, and the information to tell them apart was already
// being written — to the trace, where nobody watching could see it. This checks
// the whole path: a tool call in the engine becomes a trace event, becomes an
// activity line, crosses IPC, and lands under "Show more" in words a person
// would use.
//
// It also checks the file a run produced is offered back. A run writes into a
// sandbox that gets swept, so a spreadsheet an agent made is, without this,
// something the user watched appear and then lost.

test.describe.configure({ timeout: 240_000 });

/**
 * A gateway that makes the agent fetch a page and write a file.
 *
 * Scripted rather than a real model: this test is about what the window shows,
 * and a real model would choose different tools on different days.
 */
async function startGateway(
  site: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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
      // Driven by what the model can see rather than by a turn counter.
      //
      // A counter was wrong in a way worth recording: turn one is the *plan*,
      // and a plan's tool calls are recorded and never executed. So the fetch
      // was issued during planning, ignored, and the acting turn — turn two —
      // spent itself on the write. The trace had no tool_call events at all and
      // the failure looked like the activity feed being broken.
      const isResearcher = body.includes('You are the Researcher');
      const fetched = body.includes('The rate is 3.75%');
      const wrote = body.includes('summary.csv') && body.includes('"role":"tool"');
      const asksForVerdict = body.includes('Has the task been achieved');

      const toolCall = (name: string, args: unknown): unknown => ({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: `call-${String(Date.now())}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });

      // The researcher reads and the coder writes, because that is what their
      // allowlists permit — the researcher is read-only by construction, and
      // asking it to write got the refusal it should have got.
      const done = isResearcher ? fetched : wrote;

      const message = asksForVerdict
        ? {
            role: 'assistant',
            content: JSON.stringify(
              done
                ? { verified: true, evidence: 'done' }
                : { verified: false, evidence: 'still working' },
            ),
          }
        : isResearcher
          ? fetched
            ? { role: 'assistant', content: 'The rate is 3.75%, read from the page.' }
            : toolCall('http__request', { url: site })
          : wrote
            ? { role: 'assistant', content: 'Wrote summary.csv.' }
            : toolCall('filesystem__writeFile', {
                path: 'summary.csv',
                content: 'name,value\nrate,3.75\n',
              });

      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          id: 'a-1',
          model: 'claude-haiku-4-5',
          choices: [{ index: 0, message, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
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

/** Something for the agent to actually fetch, so the activity line names a real host. */
async function startSite(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
    res.end('<html><body><p>The rate is 3.75%.</p></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}/rates`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('a running step can be opened out to show what it is doing', async () => {
  const site = await startSite();
  const gateway = await startGateway(site.origin);
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

    await goTo(page, 'build');

    // A writer that only writes. The shipped Coder carries `shell.exec` too, and
    // the canvas refuses to run a step that can act irreversibly without an
    // approval node in front of it — correctly, and it is not what this test is
    // about.
    await page.getByTestId('palette-add-agent').click();
    await expect(page.getByTestId('agent-editor')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('agent-name').fill('Filer');
    await page.getByTestId('agent-prompt').fill('You write what you are given into a file.');
    await page.getByTestId('agent-tool-filesystem.writeFile').check();
    await page.getByTestId('agent-iterations').fill('4');
    await page.getByTestId('agent-save').click();
    // Saving lands on the roster, which is where a new agent belongs. Back to
    // the canvas to use it.
    await expect(page.getByTestId('agent-card-filer')).toBeVisible({ timeout: 20_000 });
    await goTo(page, 'build');
    await expect(page.getByTestId('palette-filer')).toBeVisible({ timeout: 20_000 });

    for (const [id, instruction] of [
      ['researcher', 'Read the page and report the rate.'],
      ['filer', 'Write the rate into summary.csv.'],
    ] as const) {
      await page.getByTestId(`palette-${id}`).click();
      await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
      await page.getByTestId('node-instruction').fill(instruction);
    }
    await joinSteps(page, 'node-researcher', 'node-filer');
    await page.getByTestId('brief-input').fill('Find the rate and save it.');
    await page.getByTestId('brief-name').fill('Rate summary');
    // Named, so the fetch is allowed and the activity line has a host to show.
    await page.getByTestId('brief-sites').fill('127.0.0.1');

    await expect(page.getByTestId('brief-run')).toBeEnabled();

    // Starting a run opens a second window, and that window is the subject
    // here. Waiting starts before the click, because the window opens as part
    // of starting and the event is gone by the time the click returns.
    const opened = app.waitForEvent('window');
    await page.getByTestId('brief-run').click();
    const monitor = await opened;
    await monitor.waitForLoadState('domcontentloaded');

    await expect(monitor.getByTestId('run-monitor')).toBeVisible({ timeout: 30_000 });
    await expect(monitor.getByTestId('run-monitor')).toHaveAttribute(
      'data-status',
      /succeeded|failed/,
      { timeout: 180_000 },
    );

    // Each step folds out on its own. Somebody watching a run opens the one
    // they are curious about, and the others carry on.
    const open = async (nodeId: string) => {
      const control = monitor.getByTestId(`moment-more-${nodeId}`);
      await expect(control).toBeVisible({ timeout: 30_000 });
      // It says how much there is to see before it is opened.
      await expect(control).toContainText('Show more');
      await control.click();
      await expect(control).toContainText('Show less');
      return monitor.getByTestId(`moment-activity-${nodeId}`);
    };

    const research = await open('researcher-1');
    // Named by the thing, not the tool. Somebody watching wants to know where
    // their agent has been, and "http.request" tells them nothing checkable.
    await expect(research).toContainText('Opening 127.0.0.1');
    await expect(research).not.toContainText('http.request');

    const filing = await open('filer-2');

    // Photographed when asked for, the same way `shots.spec.ts` does the rest.
    // This is the one surface in the app that is a live feed, and a live feed
    // is worth looking at rather than only asserting about:
    //   CHIMERA_SHOTS=1 npx playwright test e2e/liveActivity.spec.ts
    if (process.env['CHIMERA_SHOTS'] === '1') {
      await monitor.screenshot({ path: 'test-results/shots/run-activity.png' });
    }
    // The file is offered back the moment it exists, with an icon for what it
    // is and the name the agent chose. A run writes into a sandbox that gets
    // swept, so without this it is something you watch appear and then lose.
    await expect(filing).toContainText('Saved summary.csv');
    const save = monitor.getByTestId('artifact-save-summary.csv');
    await expect(save).toBeVisible();
    await expect(save).toHaveText('Save');
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
    await site.close();
  }
});
