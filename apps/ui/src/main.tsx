import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design-tokens/tokens.css';
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
