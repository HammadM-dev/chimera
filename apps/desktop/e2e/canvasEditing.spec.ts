import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

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

    await page
      .locator('[data-testid="node-researcher"] .react-flow__handle-right')
      .dragTo(page.locator('[data-testid="node-summariser"] .react-flow__handle-left'));
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
      await page
        .locator(`[data-testid="${from}"] .react-flow__handle-right`)
        .dragTo(page.locator('[data-testid="node-summariser"] .react-flow__handle-left'));
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
