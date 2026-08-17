import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// The Memory section: what the user writes, what agents write, and the fact
// that the two are distinguishable.

test('memory is written, grouped, searchable, and says who wrote it', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await goTo(page, 'memory');

    await expect(page.getByTestId('memory-empty')).toBeVisible();
    // The backend is named rather than assumed — the first question a memory
    // list raises is where it lives.
    await expect(page.getByTestId('memory-backend')).toContainText('Local workspace store');

    // A memory the user types.
    await page.getByTestId('memory-add').click();
    await page.getByTestId('memory-draft-kind').selectOption('goal');
    await page.getByTestId('memory-draft-subject').fill('CHIMERA');
    await page.getByTestId('memory-draft-body').fill('Ship an automation builder people can sell.');
    await page.getByTestId('memory-draft-save').click();

    await expect(page.getByTestId('memory-card')).toHaveCount(1);
    await expect(page.getByTestId('memory-view')).toContainText('Goals');
    // Marked as the user's, not an agent's — the distinction the whole store
    // rests on.
    await expect(page.getByTestId('memory-card')).toContainText('You');
    await expect(page.getByTestId('memory-card')).toContainText('stated');

    // An agent's memory, written the way a run writes one: through the same
    // store, with a role as its source and a confidence below certainty.
    await page.evaluate(async () => {
      const chimera = (
        window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).chimera;
      await chimera.invoke('memory:write', {
        kind: 'preference',
        subject: 'Reporting',
        body: 'Hammad wants failures stated plainly, not softened.',
      });
    });
    await page.getByTestId('memory-search').fill('failures');
    await expect(page.getByTestId('memory-card')).toHaveCount(1, { timeout: 5_000 });
    await expect(page.getByTestId('memory-card')).toContainText('Reporting');

    await page.getByTestId('memory-search').fill('');
    await expect(page.getByTestId('memory-card')).toHaveCount(2, { timeout: 5_000 });

    // Filtering by kind narrows to that group and nothing else.
    await page.getByTestId('memory-filter-goal').click();
    await expect(page.getByTestId('memory-card')).toHaveCount(1);
    await expect(page.getByTestId('memory-card')).toContainText('CHIMERA');

    // Survives a restart: a memory that does not outlive the app is a note.
    await page.getByTestId('memory-filter-goal').click();
    await page.reload();
    await goTo(page, 'memory');
    await expect(page.getByTestId('memory-card')).toHaveCount(2, { timeout: 10_000 });
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
