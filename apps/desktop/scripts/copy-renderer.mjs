#!/usr/bin/env node
// Copies the built renderer (apps/ui/dist) into the desktop app's own dist as
// dist/renderer, which is where apps/desktop/src/windows.ts loads index.html
// from.
//
// A copy rather than pointing apps/ui's Vite build straight at this directory:
// each workspace stays responsible for its own dist, and electron-builder
// (M0-9) packages a single self-contained apps/desktop/dist without needing to
// reach across into a sibling workspace.
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const rendererSrc = path.resolve(desktopRoot, '../ui/dist');
const rendererDest = path.join(desktopRoot, 'dist', 'renderer');

if (!existsSync(rendererSrc)) {
  console.error(
    `Renderer build not found at ${rendererSrc}.\n` +
      'Run "npm run build --workspace @chimera/ui" first — apps/desktop/package.json\'s ' +
      'build script normally does this for you.',
  );
  process.exit(1);
}

cpSync(rendererSrc, rendererDest, { recursive: true });
console.log(`Copied renderer -> ${path.relative(desktopRoot, rendererDest)}`);
