#!/usr/bin/env node
// Launches CHIMERA as a brand-new user: empty workspace, splash, setup guide.
//
// It wipes and uses a throwaway profile beside the app rather than the real
// one, so running it can never cost you the providers you have set up. That is
// the whole reason this exists as a command instead of an instruction to
// delete a directory — an instruction that was wrong the first time it was
// given, and destructive when it was right.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = path.join(desktopRoot, '.dev-profile');

fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });

console.log(`Fresh workspace: ${profile}`);
console.log('Splash plays, setup guide opens, no providers connected.\n');

const electron = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron', '.', `--user-data-dir=${profile}`],
  { cwd: desktopRoot, stdio: 'inherit' },
);

electron.on('exit', (code) => {
  process.exit(code ?? 0);
});
