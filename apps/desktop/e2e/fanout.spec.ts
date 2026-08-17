import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// M5-1 and M5-6: a fan-out built on the real canvas, run by the real executor,
// with a failure report a person can read afterwards.
//
// The item count here is 40 rather than the exit criterion's 1000: the pool's
// behaviour at 1000 is asserted directly in `fanout.test.ts`, against a counter
// on the work itself, which is a stronger check than an E2E could make and
// takes a second rather than ten minutes. What this test proves is the part
// that only exists end to end — that a person can build one, run it, and see
// what failed.

const ITEMS = Array.from({ length: 40 }, (_, index) => `invoice-${String(index + 1)}`);

async function startGateway(): Promise<{
  baseUrl: string;
  peakConcurrent: () => number;
  close: () => Promise<void>;
}> {
  let live = 0;
  let peak = 0;

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
      live += 1;
      peak = Math.max(peak, live);

      const asksForVerdict = body.includes('Has the task been achieved');
      // Two items are scripted to fail, so the run has something real to
      // report. The rest succeed, and the run as a whole finishes.
      const doomed = body.includes('invoice-7') || body.includes('invoice-23');

      const content = asksForVerdict
        ? doomed
          ? '{"verified": false, "evidence": "the invoice is unreadable"}'
          : '{"verified": true, "evidence": "handled"}'
        : doomed
          ? 'I cannot read this invoice.'
          : 'Handled.';

      // A little latency, so the pool has something to overlap. Without it
      // every call finishes before the next starts and concurrency proves
      // nothing.
      setTimeout(() => {
        live -= 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'fan-1',
            model: 'claude-haiku-4-5',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 400, completion_tokens: 60 },
          }),
        );
      }, 15);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    peakConcurrent: () => peak,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test.setTimeout(240_000);

test('a fan-out processes a list, several at a time, and reports what failed', async () => {
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

    // The list, as a reshape rather than a model call: this test is about the
    // fan-out, not about what a stub happened to answer.
    await page.getByTestId('palette-transform').click();
    await page.getByTestId('transform-template').fill(JSON.stringify(ITEMS));

    await page.getByTestId('palette-fanout').click();
    await page.getByTestId('fanout-concurrency').fill('5');
    await page.getByTestId('fanout-max').fill('100');
    await page.getByTestId('fanout-dead-letter').fill('10');

    await page.getByTestId('palette-summariser').click();
    await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await page.getByTestId('node-instruction').fill('Handle this invoice.');

    const join = async (from: string, to: string) => {
      await page
        .locator(`[data-testid="${from}"] .react-flow__handle-bottom`)
        .dragTo(page.locator(`[data-testid="${to}"] .react-flow__handle-top`));
    };
    await join('node-transform', 'node-fanout');
    await join('node-fanout', 'node-summariser');

    await page.getByTestId('brief-input').fill('Handle every invoice in the list.');
    await page.getByTestId('brief-name').fill('Invoice run');

    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();

    // 38 of 40, because two were scripted to fail — and the run finished
    // rather than halting, because the failures stayed under the limit.
    await expect(page.getByTestId('node-fanout')).toContainText('succeeded', { timeout: 180_000 });

    // In flight, not queued: the pool held to the five the user asked for.
    expect(gateway.peakConcurrent()).toBeLessThanOrEqual(5);

    // And afterwards: the failure report names them, with the item and the
    // reason, and the fan-out's own tally is in the trace.
    await goTo(page, 'runs');
    const failures = page.getByTestId('run-failures');
    await expect(failures).toBeVisible({ timeout: 20_000 });
    await expect(failures).toContainText('2 items could not be processed');
    await expect(failures).toContainText('invoice-7');
    await expect(failures).toContainText('invoice-23');

    await page.getByTestId('trace-filter-decision').click();
    await page.getByTestId('trace-events').getByText('fanout:finished').first().click();
    const payload = page.getByTestId('trace-payload');
    await expect(payload).toContainText('"succeeded": 38');
    await expect(payload).toContainText('"failed": 2');
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
