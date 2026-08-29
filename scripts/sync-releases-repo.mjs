#!/usr/bin/env node
// Copies the public half of this repository into the releases repository.
//
//   node scripts/sync-releases-repo.mjs ../chimera-releases
//
// `chimera-releases` is public and holds three things: the two install scripts
// the one-line installer fetches, the front page people and search engines
// actually reach, and the release assets electron-builder publishes. The source
// stays private.
//
// Copied rather than committed twice: the animations are eight megabytes, and
// storing them in both repositories doubles that in both histories, forever.
// This repository is the source of truth; the releases repository is a
// publication of part of it.
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const target = process.argv[2];

if (!target) {
  console.error('Usage: node scripts/sync-releases-repo.mjs <path-to-chimera-releases>');
  process.exit(1);
}

const to = path.resolve(target);
if (!existsSync(to)) {
  console.error(`${to} does not exist. Clone chimera-releases first.`);
  process.exit(1);
}

const FILES = [
  ['scripts/install.sh', 'install.sh'],
  ['scripts/install.ps1', 'install.ps1'],
  ['docs/releases-repo/README.md', 'README.md'],
];

const ASSETS = 'docs/assets';
// Only what the public README references. The frames the animations were built
// from are hundreds of megabytes and belong nowhere near a public repository.
const ASSET_FILES = ['build.gif', 'swarm.gif', 'governor.svg', 'untrusted.svg', 'mark.png'];

for (const [from, name] of FILES) {
  const source = path.join(repoRoot, from);
  if (!existsSync(source)) {
    console.error(`missing: ${from}`);
    process.exit(1);
  }
  copyFileSync(source, path.join(to, name));
  console.log(`  ${name}`);
}

mkdirSync(path.join(to, 'assets'), { recursive: true });
for (const name of ASSET_FILES) {
  const source = path.join(repoRoot, ASSETS, name);
  if (!existsSync(source)) {
    console.error(`missing asset: ${name} — run scripts/build-readme-assets.mjs first`);
    process.exit(1);
  }
  copyFileSync(source, path.join(to, 'assets', name));
  console.log(`  assets/${name}`);
}

console.log(
  `\nCopied into ${to}. Review, commit and push there — that repository is public.\n` +
    `Its ${String(readdirSync(path.join(to, 'assets')).length)} asset(s) are what the README shows.`,
);
