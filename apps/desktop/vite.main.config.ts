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
      entry: 'src/main.ts',
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      // Native modules and Electron itself are resolved at runtime from
      // node_modules, never bundled — they ship compiled .node addons that
      // a JS bundle can't inline. See docs/ARCHITECTURE.md.
      //
      // Playwright is external for a related reason: it drives a browser
      // binary it locates relative to its own package, and its bundle reaches
      // for optional native dependencies (`kerberos`) that are not installed
      // and are not meant to be. Bundling it fails the build outright, which
      // is how this list gained the entry.
      external: [
        ...nodeBuiltins,
        'electron',
        'better-sqlite3',
        '@napi-rs/keyring',
        'playwright',
        'playwright-core',
        // The mail clients, for the same reason: both reach for optional
        // native and dynamically-required pieces at runtime, and neither is
        // ours to inline into a bundle.
        'imapflow',
        'nodemailer',
      ],
    },
  },
});
