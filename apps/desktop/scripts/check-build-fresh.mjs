import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Refuses to run the E2E suite against a bundle older than the code.
//
// This existed because it happened: a whole session's worth of fixes was
// verified against yesterday's build. The suite passed, the live runs passed,
// and none of it was evidence about the code that had just been written — the
// runs were exercising a bundle from the night before. A green suite that is
// not testing your changes is worse than a red one, because it is believed.

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const entry = path.join(desktopRoot, 'dist', 'main.js');

let builtAt;
try {
  builtAt = statSync(entry).mtimeMs;
} catch {
  console.error(
    'No build at apps/desktop/dist/main.js. Run: npm run build --workspace @chimera/desktop',
  );
  process.exit(1);
}

/** Every source file the bundle is built from. Not node_modules, not dist, not the tests. */
function newestSource(dir) {
  let newest = { path: '', at: 0 };
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name === 'dist' || item.name.startsWith('.')) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      // e2e is not bundled — a test file changing is not a stale build.
      if (item.name === 'e2e' || item.name === 'test-results') continue;
      const found = newestSource(full);
      if (found.at > newest.at) newest = found;
      continue;
    }
    if (!/\.(ts|tsx|css|sql|html)$/.test(item.name)) continue;
    const at = statSync(full).mtimeMs;
    if (at > newest.at) newest = { path: full, at };
  }
  return newest;
}

const roots = ['apps/desktop/src', 'apps/ui/src', 'packages'].map((dir) =>
  path.join(repoRoot, dir),
);
let newest = { path: '', at: 0 };
for (const root of roots) {
  const found = newestSource(root);
  if (found.at > newest.at) newest = found;
}

if (newest.at > builtAt) {
  const behind = Math.round((newest.at - builtAt) / 1000);
  console.error(
    `The build is ${String(behind)}s older than ${path.relative(repoRoot, newest.path)}.\n` +
      'Whatever you are about to test, the app will not contain it.\n' +
      'Run: npm run build --workspace @chimera/desktop',
  );
  process.exit(1);
}

console.log('Build is newer than every source file it is built from.');
