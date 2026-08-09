import type { JSX } from 'react';
import './shell.css';

// Empty-state copy follows docs/DESIGN.md section 8: an invitation with a
// verb, sentence case, no apology, no exclamation mark.
export function AppShell(): JSX.Element {
  return (
    <div className="shell" data-testid="app-shell">
      <nav className="shell__rail" aria-label="Workspace">
        <h2 className="shell__region-title">Workflows</h2>
        <p className="shell__empty">Build your first workflow, or start from a template.</p>
      </nav>
      <main className="shell__canvas">
        <p className="shell__empty">Open a workflow to edit it here.</p>
      </main>
      <aside className="shell__inspector" aria-label="Inspector">
        <h2 className="shell__region-title">Inspector</h2>
        <p className="shell__empty">Select a node to configure it.</p>
      </aside>
      <footer className="shell__status">
        <span>No active runs</span>
        <span>Connect a provider to start chatting</span>
      </footer>
    </div>
  );
}
