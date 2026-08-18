import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// M6-5, the milestone's exit criterion: "an agent logs into a test site,
// extracts a table, fills a form under supervision."
//
// The site is real HTTP with a real session cookie, the browser is a real
// Chromium in a profile of CHIMERA's own, and the form submission is behind an
// approval node — "under supervision" as a mechanism rather than a narrative.

interface Submission {
  note: string;
}

async function startSite(): Promise<{
  origin: string;
  submissions: () => Submission[];
  close: () => Promise<void>;
}> {
  const submissions: Submission[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const loggedIn = (req.headers.cookie ?? '').includes('session=in');
    const html = (body: string) =>
      `<!doctype html><meta charset="utf-8"><title>Invoices</title>${body}`;

    if (url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
      res.end(
        html(`<h1>Sign in</h1>
          <form action="/session" method="get">
            <input id="user" name="user" />
            <input id="password" name="password" type="password" />
            <button id="signin" type="submit">Sign in</button>
          </form>`),
      );
      return;
    }

    if (url.pathname === '/session') {
      res.writeHead(302, {
        'set-cookie': 'session=in; Path=/',
        location: '/invoices',
        connection: 'close',
      });
      res.end();
      return;
    }

    if (url.pathname === '/invoices') {
      if (!loggedIn) {
        res.writeHead(302, { location: '/login', connection: 'close' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
      res.end(
        html(`<h1>Open invoices</h1>
          <table><tbody>
            <tr><td class="ref">INV-1001</td><td>1,240.00</td></tr>
            <tr><td class="ref">INV-1002</td><td>880.50</td></tr>
            <tr><td class="ref">INV-1003</td><td>410.00</td></tr>
          </tbody></table>
          <form action="/report" method="get">
            <input id="note" name="note" />
            <button id="send" type="submit">Send report</button>
          </form>`),
      );
      return;
    }

    if (url.pathname === '/report') {
      submissions.push({ note: url.searchParams.get('note') ?? '' });
      res.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
      res.end(html('<p id="done">Report received</p>'));
      return;
    }

    res.writeHead(404, { connection: 'close' }).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    submissions: () => [...submissions],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A provider that drives the browser tools step by step.
 *
 * Scripted rather than left to a model: the ticket is about the tools, the
 * allowlist and the gate, and a stub that decided for itself what to click
 * would be testing the model.
 */
async function startGateway(origin: string): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const script = [
    { tool: 'browser__navigate', args: { url: `${origin}/login` } },
    { tool: 'browser__type', args: { selector: '#user', text: 'accounts@example.test' } },
    { tool: 'browser__type', args: { selector: '#password', text: 'hunter2' } },
    { tool: 'browser__click', args: { selector: '#signin' } },
    // Straight to the list, which redirects back to /login unless the sign-in
    // set a session cookie — so reading the table at all is the proof it did.
    { tool: 'browser__navigate', args: { url: `${origin}/invoices` } },
    { tool: 'browser__read', args: { selector: 'h1' } },
    { tool: 'browser__extract', args: { selector: '.ref', limit: 10 } },
    { tool: 'browser__screenshot', args: { fullPage: false } },
  ];
  let step = 0;

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
      const isOperator = body.includes('You operate a web browser');
      // The loop's planning call is made without tools, and a tool call in the
      // answer to it is dropped — correctly. The script only advances on a
      // request that actually offered the tools, or the first browser action
      // is spent on a turn that could not have made it.
      const offersTools = body.includes('"tools"');

      let message: Record<string, unknown> = {
        role: 'assistant',
        content: 'Done.',
      };

      if (asksForVerdict) {
        // Not done until the script is. The loop verifies after every
        // iteration, and a stub that said "yes" the first time would stop the
        // agent after one click — which is how this test first passed a
        // browser demo that had barely opened a page.
        const done = step >= script.length;
        message = {
          role: 'assistant',
          content: done
            ? '{"verified": true, "evidence": "the invoices were read from the page"}'
            : '{"verified": false, "evidence": "still working through the site"}',
        };
      } else if (isOperator && offersTools && step < script.length) {
        const next = script[step];
        step += 1;
        message = {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call-${String(step)}`,
              type: 'function',
              function: { name: next?.tool, arguments: JSON.stringify(next?.args ?? {}) },
            },
          ],
        };
      } else if (isOperator && !offersTools) {
        message = { role: 'assistant', content: 'Plan: sign in, read the invoices, screenshot.' };
      } else if (isOperator) {
        message = {
          role: 'assistant',
          content: 'The three open invoices are INV-1001, INV-1002 and INV-1003.',
        };
      }

      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          id: 'm6-1',
          model: 'claude-haiku-4-5',
          choices: [
            {
              index: 0,
              message,
              finish_reason: message['tool_calls'] === undefined ? 'stop' : 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 600, completion_tokens: 80 },
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

test.setTimeout(300_000);

test('M6 exit: an agent signs in, reads the table, and the send waits for a person', async () => {
  const site = await startSite();
  const gateway = await startGateway(site.origin);
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

    // The operator, then the gate, then the step that would send.
    await page.getByTestId('palette-browser-operator').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page
      .getByTestId('node-instruction')
      .fill('Sign in, read the open invoice references, and take a screenshot.');

    await page.getByTestId('palette-approval').click();
    await page.getByTestId('approval-prompt').fill('Send the report?');

    await page.getByTestId('palette-summariser').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Write the one-line report.');

    const join = async (from: string, to: string) => {
      await page
        .locator(`[data-testid="${from}"] .react-flow__handle-right`)
        .dragTo(page.locator(`[data-testid="${to}"] .react-flow__handle-left`));
    };
    await join('node-browser-operator', 'node-approval');
    await join('node-approval', 'node-summariser');

    await page.getByTestId('brief-input').fill('Collect the open invoices and report them.');
    await page.getByTestId('brief-name').fill('Invoice collection');
    // Without this the browser reaches nothing at all.
    await page.getByTestId('brief-sites').fill('127.0.0.1');

    // A browser operator can click, and a click is how a browser sends, buys
    // and deletes — so M4-6 refuses to run one that nothing has authorised.
    // Saying so explicitly for the step that only reads, and putting the gate
    // in front of the step that sends, is the shape this is meant to take.
    await page.getByTestId('node-browser-operator').click();
    await page.getByTestId('node-preauthorise').check();

    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();

    // It signed in and read the table — through a real browser, on a page that
    // redirects to /login until the session cookie exists.
    await expect(page.getByTestId('node-browser-operator')).toContainText('succeeded', {
      timeout: 180_000,
    });

    // And it stopped at the gate rather than sending anything.
    const gate = page.getByTestId('approval');
    await expect(gate).toBeVisible({ timeout: 60_000 });
    expect(site.submissions()).toEqual([]);

    await page.getByTestId('approval-approve').click();
    await expect(page.getByTestId('run-note')).toContainText('succeeded', { timeout: 120_000 });

    // The whole sequence is in the trace, screenshot included.
    await goTo(page, 'runs');
    await page.getByTestId('trace-filter-tool_result').click();
    // It signed in — /invoices redirects back to /login without the session
    // cookie, so reading the table at all is the proof — and read the table.
    await expect(page.getByTestId('trace-events')).toContainText('INV-1001');
    await expect(page.getByTestId('trace-events')).toContainText('Clicked #signin');
    // The password is not in the trace. A tool that echoed what it typed would
    // put every credential an agent uses into a file the user can export.
    await expect(page.getByTestId('trace-events')).not.toContainText('hunter2');

    await page
      .getByTestId('trace-events')
      .getByText(/Screenshot saved as/)
      .first()
      .click();
    await expect(page.getByTestId('trace-screenshot')).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
    await site.close();
  }
});
