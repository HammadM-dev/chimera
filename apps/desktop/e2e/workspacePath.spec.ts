import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshProfile, launchApp, removeProfile } from './support/app.ts';

// One workspace path, in development and packaged alike.
//
// Electron derives `userData` from the app name. Unpackaged that came from
// package.json — the scoped npm name `@chimera/desktop` — while the packaged
// build used electron-builder's `productName`, `CHIMERA`. The two read
// different workspaces, so a connection added in one was invisible in the
// other, and "delete your workspace to start fresh" was wrong for half the
// people who followed it. It was wrong for the founder, which is how it was
// found.

test('the app reports one workspace name, matching the packaged identity', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    // Wait for the window before asking main anything. Evaluating into a main
    // process that is still starting up intermittently came back "resulting
    // promise was garbage collected" — the harness losing its context rather
    // than the app answering wrongly, and the last test in the suite failing
    // for a reason that has nothing to do with what it checks.
    await app.firstWindow();

    const identity = await app.evaluate(({ app: electronApp }) => ({
      name: electronApp.getName(),
      userData: electronApp.getPath('userData'),
    }));

    // The same name electron-builder ships under, so a support answer about
    // where the workspace lives is true for both builds.
    expect(identity.name).toBe('CHIMERA');
    expect(identity.userData).not.toContain('@chimera');

    // `--user-data-dir` still wins, which is what keeps every test isolated.
    expect(identity.userData).toBe(profile);

    const builderConfig = fs.readFileSync(
      path.join(import.meta.dirname, '..', 'electron-builder.yml'),
      'utf8',
    );
    expect(builderConfig).toContain(`productName: ${identity.name}`);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
