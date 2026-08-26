import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// The notes board, and the thing that makes it worth having: two kinds of
// author write to it.
//
// A person adding a note is the easy half. The half worth an end-to-end test is
// that a note an *agent* left shows up here, says an agent left it, and can be
// edited and ticked off by the person like any other — because a board where
// you cannot tell your own handwriting from your software's, or cannot change
// what your software wrote, is a worse thing than no board.

test.describe.configure({ timeout: 180_000 });

/**
 * Puts a note on the board without typing it, to set a test up.
 *
 * Not the agent path: this goes through `note:save`, which credits the person —
 * an agent's notes arrive through the notebook tool server and carry its name
 * instead. That path is covered by the server's own tests and by
 * `describeSource`; what is worth an end-to-end test here is the board, and
 * this is the shortest way to get something onto one.
 */
async function writeNote(
  page: import('@playwright/test').Page,
  note: { kind: 'note' | 'reminder'; title: string; dueAt?: string },
): Promise<void> {
  await page.evaluate(async (input) => {
    const chimera = (
      window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
    ).chimera;
    await chimera.invoke('note:save', input);
  }, note);
}

test('a person writes a note, and it survives a restart', async () => {
  const profile = freshProfile();
  let app = await launchApp({ profile });

  try {
    let page = await app.firstWindow();
    await goTo(page, 'notes');

    await expect(page.getByTestId('notes-empty')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('note-title').fill('Send the pricing sheet');
    await page.getByTestId('note-body').fill('The one with the per-seat tier.');
    // No date, so it is a note — and the button says so, which is how somebody
    // learns the difference without being taught it.
    await expect(page.getByTestId('note-save')).toHaveText('Add note');
    await page.getByTestId('note-save').click();

    await expect(page.getByTestId('notes-group-notes')).toContainText('Send the pricing sheet', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('notes-count')).toHaveText('1 outstanding');

    await app.close();
    app = await launchApp({ profile });
    page = await app.firstWindow();
    await goTo(page, 'notes');
    await expect(page.getByTestId('notes-group-notes')).toContainText('Send the pricing sheet', {
      timeout: 20_000,
    });
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('a date makes it a reminder, and an overdue one is called overdue', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'notes');

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await writeNote(page, { kind: 'reminder', title: 'Chase the invoice', dueAt: threeDaysAgo });
    await page.reload();
    await goTo(page, 'notes');

    // Its own group, above everything else, because "what needs doing" is the
    // question a board like this is opened with.
    const overdue = page.getByTestId('notes-group-late');
    await expect(overdue).toBeVisible({ timeout: 20_000 });
    await expect(overdue).toContainText('Chase the invoice');
    await expect(overdue).toContainText('3 days late');
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('ticking something off moves it out of the way without losing it', async () => {
  // Completed things sink rather than vanishing: a reminder you ticked off
  // yesterday is the evidence that you did.
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'notes');

    await writeNote(page, { kind: 'note', title: 'Read the contract' });
    await page.reload();
    await goTo(page, 'notes');

    await expect(page.getByTestId('notes-group-notes')).toContainText('Read the contract', {
      timeout: 20_000,
    });
    await page.getByTestId('note-tick').first().click();

    await expect(page.getByTestId('notes-count')).toHaveText('nothing outstanding', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('notes-group-notes')).toHaveCount(0);

    // Still there, and reachable.
    await page.getByTestId('notes-show-done').click();
    await expect(page.getByTestId('notes-group-done')).toContainText('Read the contract');
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
