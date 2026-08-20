import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';
import { startStub } from './support/stub.ts';

// The run monitor as it really looks after a run that stopped, with a long
// answer in it. Hammad's screenshot showed the result panel drawn over the
// step list — "where it stopped" on top of the step's own name.

test.describe.configure({ timeout: 240_000 });

const LONG = [
  'I was unable to retrieve any public records, directories, or databases that list companies because:',
  '',
  '1. **External HTTP requests are blocked** - Both attempts to reach external hosts returned the error',
  '"<host> is not in this workflow\'s egress allowlist." This prevents access to online business',
  'registries, government filing systems, open-data portals, or any other web-based source.',
  '',
  '2. **The workspace contains no files** - A directory listing of the workspace returned an empty result.',
].join('\n');

test('the monitor, after a run that stopped with a long answer', async () => {
  const stub = await startStub({ answer: () => LONG });
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl } });

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
    for (const id of ['planner', 'researcher']) {
      await page.getByTestId(`palette-${id}`).click();
      await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
      await page.getByTestId('node-instruction').fill('Find the companies.');
    }
    await page
      .locator('[data-testid="node-planner"] .react-flow__handle-right')
      .dragTo(page.locator('[data-testid="node-researcher"] .react-flow__handle-left'));
    await page.getByTestId('brief-input').fill('Find companies without websites.');

    // The monitor opens itself when the run starts.
    const opened = app.waitForEvent('window');
    await page.getByTestId('brief-run').click();
    const monitor = await opened;
    await monitor.waitForLoadState('domcontentloaded');

    try {
      await expect(monitor.getByTestId('monitor-result')).toBeVisible({ timeout: 120_000 });
    } catch (err) {
      process.stdout.write(
        `\nmonitor url: ${monitor.url()}\nmonitor text: ${(
          (await monitor
            .getByTestId('run-monitor')
            .textContent()
            .catch(() => '')) ?? '(no monitor)'
        ).slice(0, 600)}\n`,
      );
      await monitor.screenshot({ path: 'test-results/shots/monitor-stuck.png' });
      const fromMain = await page.evaluate(async () => {
        const chimera = (
          window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
        ).chimera;
        const runs = (await chimera.invoke('run:list', {})) as {
          runs: { id: string; status: string; tokensUsed: number }[];
        };
        return JSON.stringify(runs.runs[0]);
      });
      process.stdout.write(
        `\nmain window says: node=${(await page.getByTestId('node-planner').textContent()) ?? ''} note=${
          (await page
            .getByTestId('run-note')
            .textContent()
            .catch(() => '')) ?? ''
        }\nrun record: ${fromMain}\n`,
      );
      throw err;
    }
    await monitor.screenshot({ path: 'test-results/shots/monitor-done.png' });

    const snap = await page.evaluate(async () => {
      const chimera = (
        window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).chimera;
      const runs = (await chimera.invoke('run:list', {})) as { runs: { id: string }[] };
      return JSON.stringify(
        await chimera.invoke('run:subscribe', { runId: runs.runs[0]?.id ?? '' }),
      );
    });
    process.stdout.write(`\nsnapshot: ${snap}\n`);
    process.stdout.write(
      `monitor steps text: ${(await monitor.getByTestId('monitor-steps').textContent()) ?? ''}\n`,
    );

    // Nothing may sit on top of anything else. The step list and the result
    // are different rows of the same grid and must not share pixels.
    const overlap = await monitor.evaluate(() => {
      const steps = document.querySelector('.monitor__steps')?.getBoundingClientRect();
      const result = document.querySelector('.monitor__result')?.getBoundingClientRect();
      if (!steps || !result) return 'a region is missing';
      return steps.bottom > result.top + 1
        ? `steps end at ${String(Math.round(steps.bottom))} but the result starts at ${String(Math.round(result.top))}`
        : 'clear';
    });
    process.stdout.write(`\nlayout: ${overlap}\n`);
    expect(overlap).toBe('clear');
  } finally {
    await app.close();
    removeProfile(profile);
    await stub.close();
  }
});
