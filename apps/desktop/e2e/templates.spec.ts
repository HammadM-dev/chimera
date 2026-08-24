import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';
import { startStub } from './support/stub.ts';

// The shipped automations, on the canvas, running.
//
// `src/templates/templates.test.ts` checks every template is well-formed —
// real agents, real node kinds, edges that join things that exist, a gate in
// front of anything that sends. That is a check on the JSON. This is the check
// on the path: that a person can see them, pick one, and get an automation that
// builds and runs rather than a canvas with holes where the steps should be.
//
// The two failures this catches are both silent. A template naming an agent
// this build does not ship is skipped when the canvas builds it, so the graph
// simply arrives short a step. And a loader that never runs — the templates
// directory not copied into the bundle, the channel not registered — shows an
// empty gallery, which looks exactly like a build with no templates in it.

test.describe.configure({ timeout: 240_000 });

test('the shipped templates are offered, and one builds into a runnable automation', async () => {
  const stub = await startStub();
  const profile = freshProfile();
  const app = await launchApp({
    profile,
    env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl },
  });

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

    await goTo(page, 'home');

    // Loaded from disk, through the channel, into the gallery. An empty gallery
    // here is the whole feature missing and looks like nothing at all.
    const gallery = page.getByTestId('home-templates');
    await expect(gallery).toBeVisible({ timeout: 20_000 });
    const cards = gallery.locator('.gallery__card');
    await expect(cards).toHaveCount(11);

    // Each says what it is and who it is for, which is what makes a gallery
    // choosable rather than a wall.
    await expect(page.getByTestId('template-invoice-to-spreadsheet')).toContainText('invoices');
    await expect(page.getByTestId('template-invoice-to-spreadsheet')).toContainText('Needs:');

    // Everything on the home screen is reachable at the size the app opens at.
    //
    // The gallery is what made this worth asserting: `.home` centred its
    // children with no overflow, so the moment the content grew past the window
    // it overflowed in both directions and the browser would not scroll above
    // the start of the flow. "Design it for me" — the button the whole screen
    // exists to lead to — sat off the bottom of a 710px window, unclickable,
    // and the only symptom was a click that timed out.
    for (const id of ['home-input', 'home-design', 'home-blank']) {
      const control = page.getByTestId(id);
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
    }
    // And the gallery itself is reachable by scrolling rather than clipped.
    await page.getByTestId('template-code-review').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('template-code-review')).toBeInViewport();

    // The contract reviewer, because it is three agents and no fan-out — the
    // shape most likely to run to completion against a stub in reasonable time.
    await page.getByTestId('template-contract-review').click();

    // It arrives as real nodes with its instructions already written.
    await expect(page.getByTestId('node-researcher')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('node-reviewer')).toBeVisible();
    await expect(page.getByTestId('node-summariser')).toBeVisible();
    // Three steps, joined — not three islands.
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);

    // And the brief came with it, so there is something to run against.
    await expect(page.getByTestId('brief-input')).not.toHaveValue('');

    // Every step needs a model; the template cannot know what this workspace has.
    for (const id of ['node-researcher', 'node-reviewer', 'node-summariser']) {
      await page.getByTestId(id).click();
      await page.getByTestId('node-model').selectOption({ index: 1 });
    }

    await page.getByTestId('brief-name').fill('Contract review');
    await expect(page.getByTestId('brief-blocked')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();

    await expect(
      page.getByTestId('run-result').or(page.getByTestId('run-note')).first(),
    ).toBeVisible({ timeout: 180_000 });
    const note =
      (await page
        .getByTestId('run-note')
        .textContent()
        .catch(() => '')) ?? '';
    expect(note, `the run reported: ${note}`).not.toMatch(
      /no tools|not registered|could not read/i,
    );
  } finally {
    await app.close();
    removeProfile(profile);
    await stub.close();
  }
});
