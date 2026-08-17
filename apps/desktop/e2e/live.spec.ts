import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// Against a real hosted provider, not a stub.
//
// Every other E2E here talks to a local `node:http` server that answers exactly
// what the adapter expects. That proved the plumbing and hid two real defects:
// a gateway that streams a request which asked not to be streamed, and a
// connection created with no model catalogue. Both only appear against
// something that was not written to agree with us.
//
// Skipped unless CHIMERA_LIVE_KEY is set, so CI stays offline per CLAUDE.md.

const KEY = process.env['CHIMERA_LIVE_KEY'] ?? '';

test.skip(KEY === '', 'set CHIMERA_LIVE_KEY to run against Ollama Cloud');
test.describe.configure({ timeout: 180_000 });

test('a real provider is connected, catalogued, and runs an automation', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'providers');

    await page.getByTestId('connection-label').fill('Ollama Cloud');
    await page.getByTestId('connection-kind').selectOption('ollama-cloud');
    await page.getByTestId('connection-key').fill(KEY);
    await page.getByTestId('connection-create').click();

    // Catalogued on creation. This is the defect Hammad hit: the connection
    // existed and had no models, so nothing could be bound to it.
    await expect(page.getByTestId('connection-row')).toContainText('models', { timeout: 30_000 });
    const row = await page.getByTestId('connection-row').textContent();
    expect(row).not.toContain('no catalogue');

    await goTo(page, 'build');
    await page.getByTestId('palette-summariser').click();

    const models = page.getByTestId('node-model');
    await expect(models).toBeVisible();
    const options = await models.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(1);

    // A small, fast model from the real catalogue.
    const pick = options.find((option) => option.includes('gpt-oss:20b')) ?? options[1] ?? '';
    await models.selectOption({ label: pick });

    await page.getByTestId('node-instruction').fill('Reply with exactly: ready');
    await page.getByTestId('brief-input').fill('Say the word ready and stop.');

    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();

    // A real model, a real completion, through the Governor and the sandbox.
    await expect(page.getByTestId('run-note')).toBeVisible({ timeout: 150_000 });
    const note = (await page.getByTestId('run-note').textContent()) ?? '';
    expect(note, `the run reported: ${note}`).not.toMatch(/could not read|not valid JSON|502/i);
    await expect(page.getByTestId('node-summariser')).toContainText(/succeeded|denied|exhausted/);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
