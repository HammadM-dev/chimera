import { test, expect } from '@playwright/test';
import { freshProfile, goTo, joinSteps, launchApp, removeProfile } from './support/app.ts';

// Taking things off the canvas.
//
// There was no way to. A join could be drawn and never cut, a step placed and
// never removed, so the only way out of a mistaken drag was to start the
// automation again.
//
// Deliberately no provider: arranging a graph is not something that should
// need a model connection, and a test that needs one cannot run when the OS
// keychain is unavailable.

test.describe.configure({ timeout: 120_000 });

test('a join can be cut and a step can be removed', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'build');

    await page.getByTestId('palette-researcher').click();
    await page.getByTestId('palette-summariser').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);

    await joinSteps(page, 'node-researcher', 'node-summariser');
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    // Cut the join. The button lives on the edge itself.
    await page.locator('[data-testid^="edge-remove-"]').first().click({ force: true });
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
    // Cutting a join removes the join, not the work either side of it.
    await expect(page.locator('.react-flow__node')).toHaveCount(2);

    // Remove a step from the inspector.
    await page.locator('[data-testid="node-summariser"]').click();
    await page.getByTestId('node-remove').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
    await expect(page.locator('[data-testid="node-summariser"]')).toHaveCount(0);

    // And by keyboard, which is the gesture most people try first.
    await page.locator('[data-testid="node-researcher"]').click();
    await page.keyboard.press('Delete');
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await expect(page.getByTestId('canvas-empty')).toBeVisible();
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('removing a step takes its joins with it', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'build');

    for (const id of ['researcher', 'data-extractor', 'summariser']) {
      await page.getByTestId(`palette-${id}`).click();
    }
    for (const from of ['node-researcher', 'node-data-extractor']) {
      await joinSteps(page, from, 'node-summariser');
    }
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);

    // The step both branches fed into. Its joins go with it, rather than being
    // left pointing at a step that is no longer there.
    await page.locator('[data-testid="node-summariser"]').click();
    await page.getByTestId('node-remove').click();

    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('a saved automation can be removed from the list it fills up', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'build');
    await page.getByTestId('palette-summariser').click();
    await page.getByTestId('brief-input').fill('Summarise the week.');
    await page.getByTestId('brief-name').fill('Weekly summary');
    await page.getByTestId('brief-save').click();
    await expect(page.getByTestId('saved-list')).toContainText('Weekly summary', {
      timeout: 20_000,
    });

    // There was no way to take one back out, so the list of things you work on
    // became a list of everything you had ever tried.
    await page.locator('[data-testid^="forget-"]').first().click();
    // It asks first; confirmAndHelp.spec covers the asking itself.
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('saved-list')).toHaveCount(0, { timeout: 20_000 });

    // Gone from the workspace, not just from the sidebar.
    const remaining = await page.evaluate(async () => {
      const chimera = (
        window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).chimera;
      const listed = (await chimera.invoke('workflow:list', {})) as { workflows: unknown[] };
      return listed.workflows.length;
    });
    expect(remaining).toBe(0);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
