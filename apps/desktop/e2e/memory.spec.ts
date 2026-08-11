import { test, expect } from '@playwright/test';
import { freshProfile, launchApp, removeProfile } from './support/app.ts';

// M2-10's third acceptance criterion: workspace facts are editable by a person,
// not only writable by an agent. This drives the real preload bridge against a
// real app, which is what "editable through an IPC call" has to mean to be
// worth anything.

interface Bridge {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
}

interface Fact {
  key: string;
  value: string;
  source: string;
}

test('workspace facts round-trip through the preload bridge and survive a restart', async () => {
  const profile = freshProfile();
  let app = await launchApp({ profile });

  try {
    let page = await app.firstWindow();
    await page.waitForSelector('[data-testid="app-shell"]');

    const written = await page.evaluate(async () => {
      const chimera = (window as unknown as { chimera: Bridge }).chimera;
      await chimera.invoke('memory:setFact', {
        key: 'billing.contact',
        value: 'finance@acme.example',
      });
      return (await chimera.invoke('memory:listFacts', {})) as { facts: Fact[] };
    });

    expect(written.facts).toHaveLength(1);
    expect(written.facts[0]?.value).toBe('finance@acme.example');
    // Written through the UI path, so the source is the person — an agent's
    // assertion and a user's statement must stay distinguishable.
    expect(written.facts[0]?.source).toBe('user');

    // A fact is meant to outlive the run that wrote it, and outliving the app
    // is the honest version of that claim.
    await app.close();
    app = await launchApp({ profile });
    page = await app.firstWindow();
    await page.waitForSelector('[data-testid="app-shell"]');

    const afterRestart = await page.evaluate(async () => {
      const chimera = (window as unknown as { chimera: Bridge }).chimera;
      const listed = (await chimera.invoke('memory:listFacts', {})) as { facts: Fact[] };
      const removed = (await chimera.invoke('memory:deleteFact', {
        key: 'billing.contact',
      })) as { removed: boolean };
      const after = (await chimera.invoke('memory:listFacts', {})) as { facts: Fact[] };
      return { listed, removed, after };
    });

    expect(afterRestart.listed.facts[0]?.value).toBe('finance@acme.example');
    expect(afterRestart.removed.removed).toBe(true);
    expect(afterRestart.after.facts).toHaveLength(0);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
