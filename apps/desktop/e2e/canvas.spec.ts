import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dragHandle, freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// The automation canvas: place agents, join them, choose a model for each.
// Driven through the real app — the palette is fed by the real role registry
// and the model list by the real connection catalogue, so a break in either
// shows up here rather than in a screenshot nobody looks at.

async function startGateway(
  models: string[],
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Places four steps, joins them and binds each to a model — more separate
// interactions than the 60s default was sized for once joins began verifying
// themselves.
test.setTimeout(150_000);

test('agents are placed on the canvas, joined, and bound to a model', async () => {
  const gateway = await startGateway(['claude-haiku-4-5', 'llama-3.3-70b']);
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl } });

  try {
    const page = await app.firstWindow();

    // A provider first, so the step inspector has real models to offer.
    await goTo(page, 'providers');
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
      timeout: 15_000,
    });
    await page.getByTestId('omniroute-import').click();
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
      timeout: 15_000,
    });

    await goTo(page, 'build');
    await expect(page.getByTestId('canvas-empty')).toBeVisible();

    // The palette is the real roster: eight starter roles from the registry.
    await expect(page.getByTestId('palette-planner')).toBeVisible();
    await expect(page.getByTestId('palette-coder')).toBeVisible();

    // Every node type the engine can run has a button. Twice now, a type has
    // been added to the union, given a label, wired into the brief and left off
    // the palette — placeable by nobody, and nothing failed.
    for (const kind of [
      'condition',
      'loop',
      'fanout',
      'aggregate',
      'swarm',
      'transform',
      'approval',
      'subworkflow',
    ]) {
      await expect(page.getByTestId(`palette-${kind}`)).toBeVisible();
    }

    // Place two agents.
    await page.getByTestId('palette-planner').click();
    await page.getByTestId('palette-coder').click();
    await expect(page.getByTestId('node-planner')).toBeVisible();
    await expect(page.getByTestId('node-coder')).toBeVisible();
    await expect(page.getByTestId('canvas-empty')).toHaveCount(0);

    // A newly placed step is unbound, and says so rather than looking finished.
    await expect(page.getByTestId('node-coder')).toContainText('No model chosen');

    // Choose a model for the selected step — the coder, which was placed last.
    const picker = page.getByTestId('node-model');
    await expect(picker).toBeVisible();
    const offered = await picker.locator('option').allTextContents();
    expect(offered.some((option) => option.includes('claude-haiku-4-5'))).toBe(true);
    expect(offered.some((option) => option.includes('llama-3.3-70b'))).toBe(true);

    await picker.selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
    await expect(page.getByTestId('node-coder')).toContainText('claude-haiku-4-5');

    // The binding belongs to that step alone: selecting the other one shows it
    // still unbound, rather than the choice leaking across the graph.
    await page.getByTestId('node-planner').click();
    await expect(page.getByTestId('node-model')).toHaveValue('');
    await expect(page.getByTestId('node-planner')).toContainText('No model chosen');

    // The inspector shows what that agent may actually touch.
    await page.getByTestId('node-coder').click();
    await expect(page.getByTestId('canvas-view')).toContainText('filesystem.*');
    await expect(page.getByTestId('canvas-view')).toContainText('shell.exec');

    // The brief: one instruction for the whole automation, collapsible, and
    // its own instruction per step.
    await expect(page.getByTestId('brief-input')).toBeVisible();
    await page.getByTestId('brief-input').fill('Summarise every invoice in the folder.');
    await page.getByTestId('brief-toggle').click();
    await expect(page.getByTestId('brief-input')).toHaveCount(0);
    await expect(page.getByTestId('brief')).toContainText('Summarise every invoice');
    await page.getByTestId('brief-toggle').click();
    await expect(page.getByTestId('brief-input')).toHaveValue(
      'Summarise every invoice in the folder.',
    );

    // A step's own instruction is separate from the role, and separate per
    // step: the coder is still the coder in the next automation.
    await page.getByTestId('node-coder').click();
    await page.getByTestId('node-instruction').fill('Write the summary to report.md.');
    await page.getByTestId('node-planner').click();
    await expect(page.getByTestId('node-instruction')).toHaveValue('');
    await page.getByTestId('node-coder').click();
    await expect(page.getByTestId('node-instruction')).toHaveValue(
      'Write the summary to report.md.',
    );

    // Joining two steps: dragging the source port onto the target's.
    const source = page.locator('[data-testid="node-planner"] .react-flow__handle-right');
    const target = page.locator('[data-testid="node-coder"] .react-flow__handle-left');
    await dragHandle(page, source, target);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    // The coder may run shell commands, and M4-6 will not save a file that
    // could do something irreversible with nothing gating it. Saying so
    // explicitly is one of the two ways past that, and the one a graph this
    // small wants.
    await page.getByTestId('node-preauthorise').check();

    // Saved, and still there after a restart — the whole point of saving.
    await page.getByTestId('brief-name').fill('Invoice summariser');
    await page.getByTestId('brief-save').click();
    await expect(page.getByTestId('run-note')).toContainText('Saved as version 1');
    await expect(page.getByTestId('saved-list')).toContainText('Invoice summariser');

    await page.reload();
    await page.waitForSelector('[data-testid="app-shell"]');
    // By position in the list rather than by its text: the sidebar's provider
    // count and Recent list both settle after their own fetches, so the row
    // moves for a moment and a text locator catches it mid-shift.
    const savedRow = page.getByTestId('saved-list').locator('button').first();
    await expect(savedRow).toHaveText('Invoice summariser');
    await savedRow.click();

    // The graph comes back with its steps, its instructions and its brief —
    // not just a name in a list.
    await expect(page.getByTestId('node-coder')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('node-planner')).toBeVisible();
    await expect(page.getByTestId('brief-input')).toHaveValue(
      'Summarise every invoice in the folder.',
    );
    await page.getByTestId('node-coder').click();
    await expect(page.getByTestId('node-instruction')).toHaveValue(
      'Write the summary to report.md.',
    );
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
