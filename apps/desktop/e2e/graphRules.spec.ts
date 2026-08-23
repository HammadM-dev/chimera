import { test, expect, type Page } from '@playwright/test';
import {
  freshProfile,
  goTo,
  joinAllInto,
  joinSteps,
  launchApp,
  removeProfile,
} from './support/app.ts';
import { startStub } from './support/stub.ts';

// The rules that decide whether a graph is allowed to exist.
//
// Everything here is a way somebody can build something the engine should
// refuse, or should quietly cope with. None of it was covered: the suite knew
// how to build a correct automation and had never once built a wrong one.

test.describe.configure({ timeout: 180_000 });

async function connect(page: Page, baseUrl: string): Promise<void> {
  await goTo(page, 'providers');
  await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
    timeout: 20_000,
  });
  await page.getByTestId('omniroute-import').click();
  await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  });
  expect(baseUrl).not.toBe('');
}

async function place(page: Page, id: string, instruction = 'Do the thing.'): Promise<void> {
  await page.getByTestId(`palette-${id}`).click();
  await page.getByTestId('node-model').selectOption({ label: 'OmniRoute · claude-haiku-4-5' });
  await page.getByTestId('node-instruction').fill(instruction);
}

async function join(page: Page, from: string, to: string): Promise<void> {
  await joinSteps(page, from, to);
}

test('a fourth copy of the same agent into one step is refused, and a combiner is not', async () => {
  const stub = await startStub();
  const profile = freshProfile();
  const app = await launchApp({
    profile,
    env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl },
  });

  try {
    const page = await app.firstWindow();
    await connect(page, stub.baseUrl);
    await goTo(page, 'build');

    // Four researchers into one data extractor. The extractor is not a
    // combiner — the reviewer, the QA, the planner and the summariser all are,
    // and picking one of those is how this test first failed to fail.
    for (let i = 0; i < 4; i += 1) await place(page, 'researcher', `Research angle ${String(i)}.`);
    await place(page, 'data-extractor', 'Pull the numbers out of all of it.');

    const researchers = page.locator('[data-testid^="node-researcher"]');
    await expect(researchers).toHaveCount(4);
    await joinAllInto(page, 'node-researcher', 'node-data-extractor');

    // All four landed, which is what makes the rule below the thing under test.
    await expect(page.locator('.react-flow__edge')).toHaveCount(4);
    await page.getByTestId('brief-input').fill('Research it four ways and review the lot.');
    await page.getByTestId('brief-name').fill('Four researchers');

    // Refused, and the message says what to do instead. The canvas checks as
    // you build, so this appears without pressing anything.
    const problem = page.getByTestId('brief-blocked');
    await expect(problem).toBeVisible({ timeout: 20_000 });
    await expect(problem).toContainText('Researcher');
    await expect(problem).toContainText('Combine');
    await expect(page.getByTestId('brief-run')).toBeDisabled();
  } finally {
    await app.close();
    removeProfile(profile);
    await stub.close();
  }
});

test('four into a summariser is allowed, because it is built to take many', async () => {
  const stub = await startStub();
  const profile = freshProfile();
  const app = await launchApp({
    profile,
    env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl },
  });

  try {
    const page = await app.firstWindow();
    await connect(page, stub.baseUrl);
    await goTo(page, 'build');

    for (let i = 0; i < 4; i += 1) await place(page, 'researcher', `Angle ${String(i)}.`);
    await place(page, 'summariser', 'Pull it together.');

    await joinAllInto(page, 'node-researcher', 'node-summariser');

    await page.getByTestId('brief-input').fill('Four angles, one summary.');
    await page.getByTestId('brief-name').fill('Four into one');
    await page.getByTestId('brief-save').click();

    await expect(page.getByTestId('brief-blocked')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('brief-run')).toBeEnabled();
  } finally {
    await app.close();
    removeProfile(profile);
    await stub.close();
  }
});

test('a loop with no way out cannot be saved', async () => {
  const stub = await startStub();
  const profile = freshProfile();
  const app = await launchApp({
    profile,
    env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl },
  });

  try {
    const page = await app.firstWindow();
    await connect(page, stub.baseUrl);
    await goTo(page, 'build');

    await page.getByTestId('palette-loop').click();
    // Zero iterations, no exit condition: an unbounded loop by any reading.
    await page.getByTestId('loop-max').fill('0');

    await place(page, 'researcher', 'Go round again.');
    await join(page, 'node-loop', 'node-researcher');

    await page.getByTestId('brief-input').fill('Loop forever.');
    await page.getByTestId('brief-name').fill('Endless');

    await expect(page.getByTestId('brief-blocked')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('brief-run')).toBeDisabled();
  } finally {
    await app.close();
    removeProfile(profile);
    await stub.close();
  }
});

test('a step joined to itself does not hang the run', async () => {
  const stub = await startStub();
  const profile = freshProfile();
  const app = await launchApp({
    profile,
    env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl },
  });

  try {
    const page = await app.firstWindow();
    await connect(page, stub.baseUrl);
    await goTo(page, 'build');

    await place(page, 'researcher', 'Answer it.');
    await place(page, 'summariser', 'Summarise it.');
    await join(page, 'node-researcher', 'node-summariser');
    // And back again: a cycle.
    await join(page, 'node-summariser', 'node-researcher');

    await page.getByTestId('brief-input').fill('Go round in a circle.');
    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();

    // Either it refuses or it finishes. What it must not do is run forever.
    await expect(page.getByTestId('run-result').or(page.getByTestId('brief-blocked'))).toBeVisible({
      timeout: 90_000,
    });
  } finally {
    await app.close();
    removeProfile(profile);
    await stub.close();
  }
});
