#!/usr/bin/env node
// The two install scripts are the first thing a user runs and the one part of
// the product that never goes through a compiler, a bundler, or a test that
// launches it. A typo in either is discovered by a stranger, on their machine,
// as the very first impression of the software.
//
// So both get parsed on every push. `sh -n` and PowerShell's parser only prove
// the syntax is valid — they do not run anything and cannot tell whether the
// logic is right — but a syntax error is exactly the failure that would
// otherwise ship, because neither file is exercised by any other check.
//
// PowerShell Core is preinstalled on GitHub's ubuntu runners, so this costs
// nothing extra there. Locally it is usually absent, and a developer without
// pwsh should not be blocked by a check that CI will run anyway.
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const sh = path.join(repoRoot, 'scripts', 'install.sh');
const ps1 = path.join(repoRoot, 'scripts', 'install.ps1');

try {
  execFileSync('sh', ['-n', sh], { stdio: 'pipe' });
  console.log('install.sh — syntax valid');
} catch (error) {
  console.error('install.sh failed to parse:\n');
  console.error(String(error.stderr ?? error.message));
  process.exit(1);
}

const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
  stdio: 'pipe',
});

if (pwsh.status !== 0) {
  console.log('install.ps1 — skipped, PowerShell not installed here (CI checks it)');
  process.exit(0);
}

// Parse rather than execute: running it would download and install CHIMERA.
const parse = spawnSync(
  'pwsh',
  [
    '-NoProfile',
    '-Command',
    `$errors = $null
     [void][System.Management.Automation.Language.Parser]::ParseFile(
       '${ps1.replaceAll("'", "''")}', [ref]$null, [ref]$errors)
     if ($errors) { $errors | ForEach-Object { $_.ToString() }; exit 1 }`,
  ],
  { stdio: 'pipe' },
);

if (parse.status !== 0) {
  console.error('install.ps1 failed to parse:\n');
  console.error(String(parse.stdout ?? '') + String(parse.stderr ?? ''));
  process.exit(1);
}

console.log('install.ps1 — syntax valid');
