#!/usr/bin/env node
// One file may register an OS-level global hotkey, and it is the panic key.
//
// Until M8-3 this check forbade the APIs outright: it is easy to reach for
// `globalShortcut` while building a "kill switch" and quietly pull two
// milestones of work forward, and easier still for a half-registered hotkey to
// sit in the codebase doing nothing while looking like a safety feature.
//
// M8-3 registered the real one, so the check narrowed rather than went away.
// The panic key belongs in exactly one place — a second registration is either
// a duplicate that fights the first for the combination, or a feature quietly
// giving itself an OS-wide keyboard hook.

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

// The one file allowed to register it, and its test.
const ALLOWED = [
  'apps/desktop/src/control/panicKey.ts',
  'apps/desktop/src/control/panicKey.test.ts',
];

const findings = [];
for (const root of SEARCH_ROOTS) {
  for (const file of walk(path.join(repoRoot, root))) {
    // This file names the APIs it forbids, and so does the roadmap entry.
    if (file.endsWith('check-no-global-hotkey.mjs')) continue;
    if (ALLOWED.includes(path.relative(repoRoot, file))) continue;
    const contents = readFileSync(file, 'utf8');
    for (const { pattern, what } of FORBIDDEN) {
      if (pattern.test(contents)) {
        findings.push(`${path.relative(repoRoot, file)} — ${what}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('OS-level global hotkey registration outside the panic key:');
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    `\nOnly ${ALLOWED[0]} may register one. See docs/ROADMAP.md M8-3 for why there is exactly one.`,
  );
  process.exit(1);
}

console.log("The panic key is the only OS-level hotkey registration, which is M8-3's rule.");
