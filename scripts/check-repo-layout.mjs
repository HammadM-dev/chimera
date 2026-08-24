#!/usr/bin/env node
// Fails if a top-level directory outside the kernel's package list is
// added without a corresponding docs update (docs/ARCHITECTURE.md,
// docs/ROADMAP.md M0-1). Extend ALLOWED_DIRS deliberately, not by accident.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');

const ALLOWED_DIRS = new Set([
  'packages',
  'apps',
  'sidecar',
  'templates',
  'evals',
  // Not part of CHIMERA and deliberately not: a Cloudflare Worker that counts
  // installs, deployed separately, sharing no code with the app and depended on
  // by none of it. See stats/README.md and docs/ARCHITECTURE.md section 3.
  'stats',
  'docs',
  'scripts',
  '.github',
  '.git',
  '.claude',
  'node_modules',
]);

const entries = readdirSync(repoRoot, { withFileTypes: true });
const unexpected = entries
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => !ALLOWED_DIRS.has(name));

if (unexpected.length > 0) {
  console.error('Unexpected top-level directory(ies) found, not in the kernel package list:');
  for (const name of unexpected) console.error(`  - ${name}`);
  console.error(
    '\nIf this is deliberate, add it to docs/ARCHITECTURE.md and ALLOWED_DIRS in scripts/check-repo-layout.mjs in the same commit.',
  );
  process.exit(1);
}

console.log('Repo layout OK — no unexpected top-level directories.');
