#!/usr/bin/env node
// docs/ROADMAP.md M0-9: "it builds and launches". Building an artifact proves
// electron-builder ran; it does not prove the thing it produced starts. This
// launches the packaged binary for the current platform against a throwaway
// profile and waits for two files to appear in it:
//
//   local-settings.json  written once the main process is ready, the window
//                        exists, and the splash decision has been consumed
//                        (apps/desktop/src/windows.ts)
//   chimera.sqlite       written once better-sqlite3 has loaded and applied
//                        migrations (apps/desktop/src/store/lifecycle.ts)
//
// The second is the one that earns the matrix its keep. Native modules ship as
// prebuilt .node binaries unpacked out of the asar, and whether the right one
// exists and loads is exactly the per-platform question a Linux-only developer
// cannot answer locally. A build that packages a broken or missing binary
// still produces an artifact; it just fails the moment it opens a database.
//
// Runs on all three matrix platforms. On Linux it needs a display server, so
// the workflow wraps it in xvfb-run exactly as it does the e2e job.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const releaseDir = path.join(repoRoot, 'apps', 'desktop', 'release');

const TIMEOUT_MS = 90_000;
const POLL_MS = 500;

function locateBinary() {
  if (process.platform === 'linux') {
    return path.join(releaseDir, 'linux-unpacked', 'chimera');
  }
  if (process.platform === 'win32') {
    return path.join(releaseDir, 'win-unpacked', 'chimera.exe');
  }
  if (process.platform === 'darwin') {
    // mac-unpacked on x64, mac-arm64 on Apple silicon — resolve whichever the
    // runner produced rather than hardcoding an arch.
    const candidates = readdirSync(releaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
      .map((entry) =>
        path.join(releaseDir, entry.name, 'CHIMERA.app', 'Contents', 'MacOS', 'chimera'),
      );
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  }
  throw new Error(`unsupported platform for the packaged smoke check: ${process.platform}`);
}

const binary = locateBinary();
if (!binary || !existsSync(binary)) {
  console.error(`Packaged binary not found at ${binary ?? '(none)'}.`);
  console.error('Run "npm run package --workspace @chimera/desktop" first.');
  process.exit(1);
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'chimera-smoke-'));
const settingsFile = path.join(profile, 'local-settings.json');
const databaseFile = path.join(profile, 'chimera.sqlite');

console.log(`Launching ${path.relative(repoRoot, binary)} against a throwaway profile...`);

const child = spawn(binary, [`--user-data-dir=${profile}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stdout.on('data', (chunk) => process.stdout.write(`  [app] ${chunk}`));
child.stderr.on('data', (chunk) => {
  stderr += chunk;
  process.stdout.write(`  [app:err] ${chunk}`);
});

let exitedEarly = null;
child.on('exit', (code, signal) => {
  exitedEarly = { code, signal };
});

const startedAt = Date.now();

function cleanUp() {
  if (exitedEarly === null) child.kill();
  rmSync(profile, { recursive: true, force: true });
}

async function waitForLaunch() {
  for (;;) {
    if (existsSync(settingsFile) && existsSync(databaseFile)) {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
      if (settings.hasSeenSplash === true) return;
    }
    if (exitedEarly !== null) {
      throw new Error(
        `the app exited before it finished starting (code ${exitedEarly.code}, signal ${exitedEarly.signal}).\n${stderr}`,
      );
    }
    if (Date.now() - startedAt > TIMEOUT_MS) {
      const missing = [
        existsSync(settingsFile) ? null : 'local-settings.json',
        existsSync(databaseFile) ? null : 'chimera.sqlite (better-sqlite3 may have failed to load)',
      ].filter(Boolean);
      throw new Error(
        `the app did not finish starting within ${TIMEOUT_MS}ms; never wrote: ${missing.join(', ')}.\n${stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

try {
  await waitForLaunch();
  console.log(
    `Packaged app launched, opened its database, and initialised in ${Date.now() - startedAt}ms.`,
  );
} catch (err) {
  console.error(`Packaged app smoke check failed: ${err.message}`);
  cleanUp();
  process.exit(1);
}

cleanUp();
