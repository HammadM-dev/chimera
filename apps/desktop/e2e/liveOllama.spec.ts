import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// Against the Ollama running on this machine — a real inference engine with a
// real model catalogue, not a stub written to agree with us.
//
// `live.spec.ts` covers hosted Ollama Cloud and needs a key. This one needs
// nothing but a local install, so it is the live check that can run on any
// developer machine. Skipped when nothing is listening, so CI stays offline.

const BASE = process.env['CHIMERA_OLLAMA_URL'] ?? 'http://127.0.0.1:11434/v1';

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/models`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

test.describe.configure({ timeout: 300_000 });

test('a local model catalogue is read, bound, and actually run', async () => {
  test.skip(!(await reachable()), `no Ollama at ${BASE}`);

  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'providers');

    await page.getByTestId('connection-label').fill('Ollama');
    await page.getByTestId('connection-kind').selectOption('ollama');
    await page.getByTestId('connection-base-url').fill(BASE);
    await page.getByTestId('connection-create').click();

    // Catalogued on creation, with the models this machine really has.
    await expect(page.getByTestId('connection-row')).toContainText('models', { timeout: 30_000 });
    const row = (await page.getByTestId('connection-row').textContent()) ?? '';
    expect(row).not.toContain('no catalogue');

    await goTo(page, 'build');
    await page.getByTestId('palette-researcher').click();

    const models = page.getByTestId('node-model');
    const options = await models.locator('option').allTextContents();
    // A small one: this test is about the path, not the answer's quality.
    const pick =
      options.find((option) => option.includes('llama3.2:3b')) ??
      options.find((option) => option.includes('qwen2.5-coder:1.5b')) ??
      options[1] ??
      '';
    expect(pick).not.toBe('');
    await models.selectOption({ label: pick });

    await page
      .getByTestId('node-instruction')
      .fill('Reply with exactly the word: ready. No other text.');
    await page.getByTestId('brief-input').fill('Say ready and stop.');

    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();

    // A real model answered, and the answer reached the screen.
    try {
      await expect(page.getByTestId('run-result')).toBeVisible({ timeout: 120_000 });
    } catch (err) {
      const say = async (id: string) => {
        const found = page.getByTestId(id);
        return (await found.count()) === 0 ? '(absent)' : ((await found.textContent()) ?? '');
      };
      process.stdout.write(
        [
          `\nrun-note: ${await say('run-note')}`,
          `brief-blocked: ${await say('brief-blocked')}`,
          `node: ${await say('node-researcher')}`,
          `approval: ${await say('approval')}`,
          `trace: ${JSON.stringify(
            await page.evaluate(async () => {
              const chimera = (
                window as unknown as {
                  chimera: { invoke: (c: string, p: unknown) => Promise<unknown> };
                }
              ).chimera;
              const runs = (await chimera.invoke('run:list', {})) as { runs: unknown[] };
              const first = runs.runs[0] as { id?: string } | undefined;
              if (first?.id === undefined) return { runs: runs.runs };
              const events = (await chimera.invoke('trace:list', { runId: first.id })) as {
                events: { eventType: string; payloadJson: string }[];
              };
              return {
                run: first,
                events: events.events.map((e) => `${e.eventType}: ${e.payloadJson.slice(0, 300)}`),
              };
            }),
            null,
            1,
          )}`,
        ].join('\n') + '\n',
      );
      throw err;
    }
    const produced = (await page.getByTestId('run-output').textContent()) ?? '';
    expect(produced.trim().length).toBeGreaterThan(0);
    process.stdout.write(`\nOllama said: ${produced.slice(0, 200)}\n`);

    // And it is in the history with a trace and a token count that came from
    // the provider rather than from us.
    await goTo(page, 'runs');
    await page.getByTestId('runs-refresh').click();
    await expect(page.getByTestId('run-summary')).toContainText('tokens', { timeout: 20_000 });
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
