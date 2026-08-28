import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureBrowser, browsersRoot, browserPresent } from './ensureBrowser.ts';

test('a root with no browser in it is reported empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-eb-'));
  try {
    assert.equal(browserPresent(root), false);
    fs.mkdirSync(path.join(root, 'chromium-1234'));
    assert.equal(browserPresent(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a browser already present is not downloaded again', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-eb-'));
  try {
    fs.mkdirSync(path.join(browsersRoot(app), 'chromium-1234'), { recursive: true });

    let installed = false;
    const root = await ensureBrowser({
      root: app,
      spawnInstall: () => {
        installed = true;
        return Promise.resolve();
      },
    });

    assert.equal(root, browsersRoot(app));
    assert.equal(installed, false, 'a second download of a 150MB browser is not free');
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('an empty root triggers exactly one download', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-eb-'));
  try {
    let calls = 0;
    await ensureBrowser({
      root: app,
      spawnInstall: (cli, env) => {
        calls += 1;
        // The two things the child must be told, checked rather than assumed:
        // where to put the browser, and that it is Node it is running as.
        assert.equal(env['PLAYWRIGHT_BROWSERS_PATH'], browsersRoot(app));
        assert.equal(env['ELECTRON_RUN_AS_NODE'], '1');
        assert.match(cli, /playwright[/\\]cli\.js$/);
        fs.mkdirSync(path.join(browsersRoot(app), 'chromium-1234'), { recursive: true });
        return Promise.resolve();
      },
    });
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('a download that leaves no browser behind is an error, not a success', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-eb-'));
  try {
    await assert.rejects(
      () => ensureBrowser({ root: app, spawnInstall: () => Promise.resolve() }),
      /no browser was found/,
    );
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});
