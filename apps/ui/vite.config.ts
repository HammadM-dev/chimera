import { defineConfig } from 'vite';

// Library mode with an `iife` output rather than Vite's default HTML entry —
// deliberate, and load-bearing for two separate reasons:
//
//  1. The built renderer is loaded over file:// (apps/desktop/src/windows.ts,
//     `loadFile`). ES module scripts are blocked over file:// by Chromium's
//     module loader; a classic script tag is not. An `iife` bundle is the one
//     format that loads with no custom protocol handler and no relaxation of
//     the M0-3 security posture.
//  2. Vite's HTML entry emits `<script type="module" crossorigin>`, which
//     fails on both counts above. Hand-writing public/index.html keeps the
//     script tag under our control and under `script-src 'self'` with no
//     inline script (docs/SECURITY.md section 7 — the CSP has no
//     'unsafe-inline' for scripts and never will).
//
// No @vitejs/plugin-react: its value is Fast Refresh in a dev server, which
// this app does not run. esbuild's automatic JSX transform is all that's
// needed to build, and it is already part of Vite. One fewer dependency.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  // React's published bundles branch on `process.env.NODE_ENV`. Vite substitutes
  // that automatically for an HTML-entry app build but not in library mode, so
  // without this the bundle reaches `process` in a renderer that has no Node
  // globals at all and dies with "process is not defined" before first paint —
  // observed, not hypothesised. Stated explicitly here rather than relying on
  // any bundler default.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Electron 43 ships a far newer Chromium than this; chrome120 is a
    // deliberately conservative floor so the bundle never depends on syntax
    // an older Electron in a bisect couldn't parse.
    target: 'chrome120',
    // Minified, unlike apps/desktop's main and preload bundles, which stay
    // readable because they are debugged from stack traces in a terminal.
    // This one is parsed by the renderer on every cold start and its size is
    // startup latency the user waits through before the window appears.
    minify: 'esbuild',
    cssCodeSplit: false,
    lib: {
      entry: 'src/main.tsx',
      formats: ['iife'],
      name: 'ChimeraRenderer',
      fileName: () => 'renderer.js',
      cssFileName: 'renderer',
    },
  },
});
