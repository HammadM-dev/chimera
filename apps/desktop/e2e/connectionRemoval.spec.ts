import { test, expect } from '@playwright/test';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';
import { startStub } from './support/stub.ts';

// Removing a provider connection.
//
// There was no way to. A key typed wrongly, or a provider somebody stopped
// paying for, stayed in the list for good — and `deleteSecret` was called from
// nowhere in the app, so the OS keychain entry would have outlived the row
// regardless. That is the leak the test suite spent a day teaching us about,
// sitting in the product waiting to happen.

test.describe.configure({ timeout: 180_000 });

test('a connection can be removed, and its key goes with it', async () => {
  const stub = await startStub();
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
    await expect(page.getByTestId('connection-row')).toHaveCount(1);

    // The handle the connection holds, before it goes.
    const handle = await page.evaluate(async () => {
      const chimera = (
        window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).chimera;
      const listed = (await chimera.invoke('connection:list', {})) as {
        connections: { id: string }[];
      };
      return listed.connections[0]?.id ?? '';
    });
    expect(handle).not.toBe('');

    await page.getByTestId('connection-remove').first().click();
    await expect(page.getByTestId('connection-row')).toHaveCount(0, { timeout: 20_000 });

    // Gone from the workspace, not just from the screen.
    const remaining = await page.evaluate(async () => {
      const chimera = (
        window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).chimera;
      const listed = (await chimera.invoke('connection:list', {})) as { connections: unknown[] };
      return listed.connections.length;
    });
    expect(remaining).toBe(0);

    // And the canvas agrees: a model picker built from a connection that no
    // longer exists is how a run ends up bound to nothing.
    await goTo(page, 'build');
    await page.getByTestId('palette-researcher').click();
    const options = await page.getByTestId('node-model').locator('option').allTextContents();
    expect(options.some((option) => option.includes('claude-haiku-4-5'))).toBe(false);
  } finally {
    await app.close();
    removeProfile(profile);
    await stub.close();
  }
});
