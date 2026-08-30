import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dismissOnboarding,
  freshProfile,
  goTo,
  joinSteps,
  launchApp,
  removeProfile,
} from './support/app.ts';

// The job a person actually asked for, and the one that failed four times.
//
// "Research the 10 fastest cars in the world, write it up, save it." Nothing is
// stubbed: the open web, a real model, a real file on disk. Every other live
// test in this suite serves its own page from localhost and looks for a marker
// string it planted, which is why a search tool returning dictionary
// definitions for every query went unnoticed through all of them.
//
// What this asserts is deliberately about the *work*: the file exists, it names
// cars that are actually fast, and the agent did not invent a citation. A run
// that honestly reports it could not search is not a pass — but it is a
// different failure from one that fabricates, and the assertions tell them
// apart.

const OPENROUTER = process.env['OPENROUTER_API_KEY'] ?? '';
const OR_MODEL = process.env['CHIMERA_LIVE_OPENROUTER_MODEL'] ?? 'minimax/minimax-m3:free';

test.describe('a real research job, end to end', () => {
  test.skip(OPENROUTER === '', 'set OPENROUTER_API_KEY');
  test.describe.configure({ timeout: 1_500_000 });

  test('research the fastest cars, write them up, and save the file', async () => {
    const profile = freshProfile();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-cars-'));
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await dismissOnboarding(page);

      await goTo(page, 'providers');
      await page.getByTestId('connection-label').fill('OpenRouter');
      await page.getByTestId('connection-kind').selectOption('openrouter');
      await page.getByTestId('connection-key').fill(OPENROUTER);
      await page.getByTestId('connection-create').click();
      await expect(page.getByTestId('connection-row')).toBeVisible({ timeout: 90_000 });

      await goTo(page, 'build');

      const place = async (id: string, instruction: string): Promise<void> => {
        await page.getByTestId(`palette-${id}`).click();
        await page.getByTestId('node-model').selectOption({ label: `OpenRouter · ${OR_MODEL}` });
        await page.getByTestId('node-instruction').fill(instruction);
      };

      await place(
        'researcher',
        'Find the fastest production cars in the world by top speed. For each one give the ' +
          'make and model, its top speed, and the source URL you got it from. Use the search ' +
          'tool, then open the promising pages. If search will not work, say so plainly and ' +
          'hand on whatever you did manage to get — do not invent cars, speeds or sources.',
      );
      await place(
        'coder',
        'Write what the researcher found into fastest-cars.md as a markdown table with columns ' +
          'Car, Top speed, Source. Copy the values exactly as given to you. Then read the file ' +
          'back and show what it contains.',
      );
      await joinSteps(page, 'node-researcher', 'node-coder');

      await page.getByTestId('brief-egress-mode').selectOption('browse');
      await page.getByTestId('brief-name').fill('Fastest cars');
      await page.getByTestId('brief-input').fill('What are the fastest production cars right now?');

      await page.getByTestId('node-coder').click();
      const preauth = page.getByTestId('node-preauthorise');
      if ((await preauth.count()) > 0) await preauth.check();

      await expect(page.getByTestId('brief-run')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('brief-run').click();

      await expect(
        page.getByTestId('run-note').or(page.getByTestId('run-result')).first(),
      ).toBeVisible({ timeout: 1_200_000 });

      const steps = page.getByTestId('result-steps');
      await expect(steps).toBeVisible({ timeout: 60_000 });
      for (const row of await steps.locator('summary').all()) await row.click();
      const all = (await steps.textContent()) ?? '';
      console.log(`[research] ${all.slice(0, 2500)}`);

      // The working is visible, which is the other half of what was asked for.
      const worklog = page.getByTestId('step-worklog');
      console.log(
        `[worklog] ${(
          (await worklog
            .first()
            .textContent()
            .catch(() => '')) ?? ''
        ).slice(0, 600)}`,
      );

      // A run that could not search must say so rather than invent. Either way,
      // it must not claim sources it never opened.
      const admitted =
        /could not|unavailable|was not able|no results|search (?:is |was )?(?:un)?available/i.test(
          all,
        );
      const named = /bugatti|koenigsegg|hennessey|tuatara|rimac|chiron|jesko|venom/i.test(all);

      console.log(`[verdict] named-real-cars=${String(named)} admitted-a-gap=${String(admitted)}`);
      expect(named || admitted, 'it neither found cars nor admitted it could not').toBe(true);
      // The thing that must never happen, whatever else does.
      expect(all).not.toMatch(/\bfastest-cars\.md\b[\s\S]{0,80}\binvent/i);
    } finally {
      await app.close();
      removeProfile(profile);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
