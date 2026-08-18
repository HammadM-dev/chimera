import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// The whole product, against the real thing.
//
// Every other spec here answers its own questions through a stand-in gateway.
// This one connects to the OmniRoute actually running on this machine, binds
// real models from its real catalogue, attaches a real file, and asks four
// agents to do a job a person would recognise. Nothing is scripted: if the
// answer contains the contract's own numbers, a model read the contract.
//
// Skipped unless CHIMERA_LIVE_OMNIROUTE=1, so CI stays offline per CLAUDE.md.

const LIVE = process.env['CHIMERA_LIVE_OMNIROUTE'] === '1';
const MODEL = process.env['CHIMERA_LIVE_MODEL'] ?? 'ollamacloud/gemma4:31b';

// A supplier agreement with facts that cannot be guessed: a renewal date, a
// notice period, an indexation cap, and two invoices, one of which is wrong.
const CONTRACT = `MASTER SERVICES AGREEMENT
Between: Northgate Logistics Ltd ("Supplier") and Bellweather Foods plc ("Customer")

4.1 TERM. This agreement runs to 28 February 2027 and renews automatically for
successive twelve-month periods unless either party gives written notice not
less than 90 days before the renewal date.

4.2 CHARGES. Charges are indexed annually to RPI, capped at 4% in any single
year. The 2026 baseline charge is GBP 240,000 per annum.

7.3 LIABILITY. The Supplier's aggregate liability is limited to the charges paid
in the preceding twelve months.

9.1 TERMINATION FOR CONVENIENCE. The Customer may terminate on 180 days notice,
subject to an early exit fee of GBP 60,000.

SCHEDULE 2 - OPEN INVOICES
INV-1001  GBP 20,000.00  PO-88213  approved
INV-1044  GBP 24,960.00  (no purchase order)  disputed
`;

test.describe.configure({ timeout: 900_000 });

/** The run's own record and trace, for when the screen does not say enough. */
async function diagnose(page: import('@playwright/test').Page): Promise<string> {
  return await page.evaluate(async () => {
    const chimera = (
      window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
    ).chimera;
    const runs = (await chimera.invoke('run:list', {})) as { runs: Record<string, unknown>[] };
    const run = runs.runs[0];
    const events = (await chimera.invoke('trace:list', { runId: String(run?.['id'] ?? '') })) as {
      events: { eventType: string; payloadJson: string }[];
    };
    return JSON.stringify(
      {
        run,
        events: events.events.map((e) => `${e.eventType}: ${e.payloadJson.slice(0, 400)}`),
      },
      null,
      1,
    );
  });
}

test('an attached file reaches a real model', async () => {
  test.skip(!LIVE, 'set CHIMERA_LIVE_OMNIROUTE=1 to run against the local OmniRoute');

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-live1-'));
  const contract = path.join(workspace, 'northgate-msa.txt');
  fs.writeFileSync(contract, CONTRACT, 'utf8');

  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_E2E_PICK_FILES: contract } });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'providers');
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
      timeout: 60_000,
    });
    await page.getByTestId('omniroute-import').click();
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
      timeout: 60_000,
    });

    await goTo(page, 'build');
    await page.getByTestId('palette-researcher').click();
    await page.getByTestId('node-model').selectOption({ label: `OmniRoute · ${MODEL}` });
    await page
      .getByTestId('node-instruction')
      .fill('State the renewal date and the notice period from the attached agreement.');
    await page.getByTestId('brief-input').fill('Read the attached agreement.');
    await page.getByTestId('brief-attach-files').click();
    await expect(page.getByTestId('brief-files')).toContainText('northgate-msa.txt', {
      timeout: 30_000,
    });

    await expect(page.getByTestId('brief-run')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('brief-run').click();
    await expect(page.getByTestId('run-result')).toBeVisible({ timeout: 600_000 });

    const panel = (await page.getByTestId('run-result').textContent()) ?? '';
    process.stdout.write(
      `\n===== RESULT PANEL =====\n${panel.slice(0, 1200)}\n========================\n`,
    );
    if (!panel.includes('2027')) process.stdout.write(`\nDIAGNOSTIC\n${await diagnose(page)}\n`);

    // The contract's own facts, which cannot be guessed.
    expect(panel).toContain('2027');
    expect(panel).toContain('90');
  } finally {
    await app.close();
    removeProfile(profile);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a real contract, four real agents, one real answer', async () => {
  test.skip(!LIVE, 'set CHIMERA_LIVE_OMNIROUTE=1 to run against the local OmniRoute');

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-live-'));
  const contract = path.join(workspace, 'northgate-msa.txt');
  fs.writeFileSync(contract, CONTRACT, 'utf8');

  const profile = freshProfile();
  // No CHIMERA_OMNIROUTE_BASE_URL override: the app finds OmniRoute where it
  // really lives, on port 20128, exactly as it would on a user's machine.
  const app = await launchApp({ profile, env: { CHIMERA_E2E_PICK_FILES: contract } });

  try {
    const page = await app.firstWindow();

    // 1. Connect, through the guided flow, to the real instance.
    await goTo(page, 'providers');
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
      timeout: 60_000,
    });
    await page.getByTestId('omniroute-import').click();
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
      timeout: 60_000,
    });

    // The catalogue is the real one, not two models a stub invented.
    const row = (await page.getByTestId('connection-row').textContent()) ?? '';
    const catalogued = Number(/(\d+) models/.exec(row)?.[1] ?? '0');
    expect(catalogued).toBeGreaterThan(20);
    process.stdout.write(`\nOmniRoute catalogued ${String(catalogued)} models\n`);

    // 2. Build the automation: two specialists in parallel, then a summariser.
    await goTo(page, 'build');
    const label = `OmniRoute · ${MODEL}`;
    const place = async (id: string, instruction: string): Promise<void> => {
      await page.getByTestId(`palette-${id}`).click();
      await page.getByTestId('node-model').selectOption({ label });
      await page.getByTestId('node-instruction').fill(instruction);
    };

    await place(
      'researcher',
      'From the attached agreement, state the renewal date, the notice period in days, and the cap on annual price increases. Quote the clause number for each.',
    );
    await place(
      'data-extractor',
      'From the attached agreement, list every invoice with its number and amount, and say which one is missing a purchase order.',
    );
    await place(
      'summariser',
      'Write a short note to the finance director covering the renewal deadline, the price cap, and the disputed invoice. Keep every number exactly as given.',
    );

    const join = async (from: string, to: string): Promise<void> => {
      await page
        .locator(`[data-testid="${from}"] .react-flow__handle-right`)
        .dragTo(page.locator(`[data-testid="${to}"] .react-flow__handle-left`));
    };
    await join('node-researcher', 'node-summariser');
    await join('node-data-extractor', 'node-summariser');

    // 3. The brief, and the contract itself.
    await page
      .getByTestId('brief-input')
      .fill('Review the attached supplier agreement before the renewal deadline.');
    await page.getByTestId('brief-name').fill('Northgate renewal review');
    await page.getByTestId('brief-attach-files').click();
    await expect(page.getByTestId('brief-files')).toContainText('northgate-msa.txt', {
      timeout: 30_000,
    });

    // 4. Run it for real.
    await expect(page.getByTestId('brief-run')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('brief-run').click();
    await expect(page.getByTestId('run-result')).toBeVisible({ timeout: 840_000 });

    const panel = (await page.getByTestId('run-result').textContent()) ?? '';
    process.stdout.write(`\n===== RESULT PANEL =====\n${panel.slice(0, 2000)}\n=====\n`);
    const answer =
      (await page
        .getByTestId('run-output')
        .textContent()
        .catch(() => '')) ?? '';
    if (answer.length === 0) process.stdout.write(`\nDIAGNOSTIC\n${await diagnose(page)}\n`);
    process.stdout.write(
      `\n===== WHAT IT PRODUCED =====\n${answer}\n============================\n`,
    );

    // 5. The answer carries the contract's own facts. A model that never saw
    //    the attachment cannot produce these, and a graph that never passed
    //    the specialists' work to the summariser cannot combine them.
    expect(answer.length).toBeGreaterThan(80);
    const facts = ['2027', '90', '4%', 'INV-1044'];
    const found = facts.filter((fact) => answer.includes(fact));
    process.stdout.write(`facts carried through: ${found.join(', ')}\n`);
    expect(found.length).toBeGreaterThanOrEqual(3);

    // 6. Real usage was recorded — real tokens, from the provider.
    await goTo(page, 'runs');
    await page.getByTestId('runs-refresh').click();
    const summary = (await page.getByTestId('run-summary').textContent()) ?? '';
    process.stdout.write(`run summary: ${summary}\n`);
    expect(/[1-9]\d*[,\d]* tokens/.test(summary)).toBe(true);
  } finally {
    await app.close();
    removeProfile(profile);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
