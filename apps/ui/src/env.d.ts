// Vite resolves a CSS import to a side effect (the stylesheet is extracted
// into renderer.css at build time) and exports nothing. Declared by hand
// rather than by referencing vite/client, which also declares a pile of
// asset and import.meta.env types this renderer does not use.
declare module '*.css';

// `import.meta.glob` only. Declared by hand for the same reason the CSS module
// is: referencing vite/client wholesale drags in a pile of asset and env types
// this renderer does not use, and one of them (`process.env`) is a global this
// codebase deliberately does not have in the renderer.
interface ImportMeta {
  glob: <T>(
    pattern: string,
    options: { eager: true; query: string; import: string },
  ) => Record<string, T>;
}
