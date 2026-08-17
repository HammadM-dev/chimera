import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrowserProfileManager } from './profileManager.ts';

// M6-1. A real browser, launched twice, kept apart.
//
// Against the real Chromium rather than a fake: the whole ticket is about
// process and profile isolation, and a fake profile manager isolates nothing.
// Skipped rather than failed where the browser has not been downloaded — CI
// installs it, a fresh clone may not have yet.

let available = true;
try {
  const { chromium } = await import('playwright');
  available = fs.existsSync(chromium.executablePath());
} catch {
  available = false;
}

const options = { skip: available ? false : 'the Playwright browser is not installed' };

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-browser-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a profile lives under the workspace root, not the user own browser profile', () => {
  const { root, cleanup } = workspace();
  try {
    const manager = createBrowserProfileManager({ root });
    const dir = manager.profileDirFor('workspace-a');

    assert.ok(dir.startsWith(root), 'the profile escaped the root it was given');
    assert.match(dir, /browser-profiles/);
    // Not the machine's own Chrome/Chromium profile, on any platform.
    assert.doesNotMatch(dir, /Google\/Chrome|Application Support\/Chromium|\.config\/chromium/i);
  } finally {
    cleanup();
  }
});

test('an id that tries to leave its directory does not', () => {
  const { root, cleanup } = workspace();
  try {
    const manager = createBrowserProfileManager({ root });
    const dir = manager.profileDirFor('../../etc');
    assert.ok(dir.startsWith(path.join(root, 'browser-profiles')));
    assert.doesNotMatch(dir, /\.\./);
  } finally {
    cleanup();
  }
});

test('two workspaces do not see each other cookies', options, async () => {
  const { root, cleanup } = workspace();
  const manager = createBrowserProfileManager({ root, headless: true });

  try {
    const a = await manager.getOrCreate('workspace-a');
    await a.page.goto('data:text/html,<title>a</title>');
    // A cookie on a data: URL has no host, so this is set through the context,
    // which is what a real login would populate.
    await a.context.addCookies([
      { name: 'session', value: 'a-secret', domain: 'example.test', path: '/' },
    ]);

    const b = await manager.getOrCreate('workspace-b');
    const cookies = await b.context.cookies('http://example.test/');

    assert.equal(cookies.length, 0, "workspace B could read workspace A's session");
    assert.notEqual(a.profileDir, b.profileDir);
  } finally {
    await manager.closeAll();
    cleanup();
  }
});

test('asking twice at once gets one browser, not two', options, async () => {
  const { root, cleanup } = workspace();
  const manager = createBrowserProfileManager({ root, headless: true });

  try {
    // Chromium locks a profile directory, so a second launch on the same one
    // fails. A fan-out's first parallel items ask at exactly the same moment.
    const [first, second] = await Promise.all([
      manager.getOrCreate('workspace-a'),
      manager.getOrCreate('workspace-a'),
    ]);
    assert.equal(first.context, second.context);
  } finally {
    await manager.closeAll();
    cleanup();
  }
});

test('closing releases the browser rather than leaving it running', options, async () => {
  const { root, cleanup } = workspace();
  const manager = createBrowserProfileManager({ root, headless: true });

  try {
    const session = await manager.getOrCreate('workspace-a');
    assert.ok(manager.peek('workspace-a'));

    await manager.closeAll();

    assert.equal(manager.peek('workspace-a'), undefined);
    // The context is really gone: an orphaned headless browser is invisible
    // and immortal, and the user's machine keeps it after the app quits.
    await assert.rejects(() => session.page.goto('data:text/html,<title>gone</title>'));
  } finally {
    cleanup();
  }
});
