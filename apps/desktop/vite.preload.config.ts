import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    lib: {
      entry: 'src/preload.ts',
      // .cjs forces CommonJS regardless of this package's "type": "module" —
      // deliberate: preload scripts are the one place we don't trust ESM
      // support across Electron versions, this is the one guaranteed-safe
      // format everywhere. Source stays ESM (Rollup transpiles on output).
      formats: ['cjs'],
      fileName: () => 'preload.cjs',
    },
    rollupOptions: {
      external: [...nodeBuiltins, 'electron'],
    },
  },
});
