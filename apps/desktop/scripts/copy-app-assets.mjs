#!/usr/bin/env node
// Copies the build outputs that Vite does not produce into apps/desktop/dist,
// which is the directory electron-builder packages.
//
//   dist/renderer/   the built React renderer (apps/ui/dist)
//   dist/migrations/ the .sql migration files from packages/store
//
// The migrations need copying because `packages/store` is *bundled* into
// dist/main.js by Vite — its TypeScript comes along, but the .sql files it
// reads at runtime do not. openDatabase() takes the directory as an explicit
// argument for exactly this reason (see the comment on OpenDatabaseOptions):
// resolving it internally would give the bundle's own location, not the
// package's.
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const repoRoot = path.resolve(desktopRoot, '../..');

const copies = [
  {
    label: 'renderer',
    from: path.resolve(repoRoot, 'apps', 'ui', 'dist'),
    to: path.join(desktopRoot, 'dist', 'renderer'),
    hint: 'Run "npm run build --workspace @chimera/ui" first — apps/desktop\'s build script normally does this for you.',
  },
  {
    label: 'migrations',
    from: path.resolve(repoRoot, 'packages', 'store', 'src', 'migrations'),
    to: path.join(desktopRoot, 'dist', 'migrations'),
    hint: 'packages/store/src/migrations is missing from the working tree.',
  },
  {
    label: 'templates',
    from: path.resolve(repoRoot, 'templates'),
    to: path.join(desktopRoot, 'dist', 'templates'),
    hint: 'The templates/ directory is missing from the working tree.',
  },
];

for (const { label, from, to, hint } of copies) {
  if (!existsSync(from)) {
    console.error(`Cannot copy ${label}: ${from} does not exist.\n${hint}`);
    process.exit(1);
  }
  cpSync(from, to, { recursive: true });
  console.log(`Copied ${label} -> ${path.relative(desktopRoot, to)}`);
}
