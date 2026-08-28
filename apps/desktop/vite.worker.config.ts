import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

// The document reader's child process, built beside `main.js`.
//
// Its own entry point rather than part of the main bundle, because it is not
// imported — it is spawned, by path, as a separate process. That is the whole
// point of it: a parser reading a stranger's file gets its own process, its own
// wall-clock limit and no environment. Rollup cannot see a `execFile` call, so
// nothing here would end up in `dist` without saying so.
//
// It was missing for exactly that reason, and every document read in the built
// app failed on a path that did not exist. The unit tests inject `spawn` and
// never spawn anything, so they were green throughout.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    lib: {
      entry: '../../packages/tools/src/documentWorker.ts',
      formats: ['es'],
      fileName: () => 'documentWorker.js',
    },
    rollupOptions: {
      // Same reasoning as the main bundle: builtins stay external, and so do
      // the parsers that ship native or dynamically-required pieces.
      external: [...nodeBuiltins],
    },
  },
});
