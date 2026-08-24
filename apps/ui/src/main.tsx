import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design-tokens/tokens.css';
// Imported before the app, for its side effect: it sets `data-theme` from the
// remembered value synchronously, so the first paint is the right colour rather
// than dark-then-flip on every launch. See the file.
import './useProfile.ts';
import { App } from './App.tsx';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Renderer root element #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
