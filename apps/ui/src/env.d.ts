// Vite resolves a CSS import to a side effect (the stylesheet is extracted
// into renderer.css at build time) and exports nothing. Declared by hand
// rather than by referencing vite/client, which also declares a pile of
// asset and import.meta.env types this renderer does not use.
declare module '*.css';
