#!/usr/bin/env node
// M3-6's third criterion: no OS-level global hotkey registration exists yet.
//
// The master plan's global panic hotkey (F6.0) is an M8-3 feature — it only
// becomes meaningful once there is native input to interrupt. This check keeps
// that boundary honest: it is easy to reach for `globalShortcut` while building
// a "kill switch" and quietly pull two milestones of work forward, and easier
// still for a half-registered hotkey to sit in the codebase doing nothing while
// looking like a safety feature.
//
// Delete this check at M8-3, in the commit that registers the real hotkey.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_ROOTS = ['apps', 'packages', 'sidecar'];
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'test-results']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.rs']);

// Electron's own API, plus the two OS-level primitives a sidecar might reach
// for directly on Windows and X11.
const FORBIDDEN = [
  { pattern: /\bglobalShortcut\b/, what: "Electron's globalShortcut" },
  { pattern: /\bRegisterHotKey\b/, what: "Windows' RegisterHotKey" },
  { pattern: /\bXGrabKey\b/, what: "X11's XGrabKey" },
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(path.extname(full))) yield full;
  }
}

const findings = [];
for (const root of SEARCH_ROOTS) {
  for (const file of walk(path.join(repoRoot, root))) {
    // This file names the APIs it forbids, and so does the roadmap entry.
    if (file.endsWith('check-no-global-hotkey.mjs')) continue;
    const contents = readFileSync(file, 'utf8');
    for (const { pattern, what } of FORBIDDEN) {
      if (pattern.test(contents)) {
        findings.push(`${path.relative(repoRoot, file)} — ${what}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('OS-level global hotkey registration found, which is M8-3 work:');
  for (const finding of findings) console.error(`  ${finding}`);
  console.error('\nM3-6 defines the kill switch as run-level. See docs/ROADMAP.md M3-6.');
  process.exit(1);
}

console.log('No OS-level global hotkey registration — correct until M8-3.');
