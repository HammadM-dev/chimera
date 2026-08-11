import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { ChatPanel } from '../chat/ChatPanel.tsx';
import { ConnectionForm } from '../connections/ConnectionForm.tsx';
import { OmniRouteSetup } from '../onboarding/OmniRouteSetup.tsx';
import { StatusBar } from './StatusBar.tsx';
import { bridge } from '../chat/useChimera.ts';
import './shell.css';

// Empty-state copy follows docs/DESIGN.md section 8: an invitation with a
// verb, sentence case, no apology, no exclamation mark.
export function AppShell(): JSX.Element {
  // One counter, owned here because both the form that invalidates the
  // connection list and the panel that reads it hang off this component.
  const [refreshToken, setRefreshToken] = useState(0);
  const [kinds, setKinds] = useState<string[]>([]);
  // Reported up by the chat panel, which already reads the list — a second
  // fetch here would be a second answer to the same question, and they would
  // disagree for one render every time a connection is added.
  const [connectionCount, setConnectionCount] = useState(0);

  const onCreated = useCallback(() => {
    setRefreshToken((current) => current + 1);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{ kinds: string[] }>('connection:list', {});
        setKinds(result.kinds);
      } catch {
        // The form renders with an empty provider list rather than taking the
        // shell down; the chat panel surfaces the same failure with a message.
      }
    })();
  }, []);

  return (
    <div className="shell" data-testid="app-shell">
      <header className="shell__topbar">
        <h1 className="shell__wordmark">CHIMERA</h1>
        <div className="shell__topbar-meta">
          <span>
            {connectionCount === 0 ? 'No providers' : `${String(connectionCount)} providers`}
          </span>
        </div>
      </header>

      <nav className="shell__rail" aria-label="Workspace">
        <div className="shell__section">
          <h2 className="shell__section-title">Workflows</h2>
          <p className="shell__empty">Build your first workflow, or start from a template.</p>
        </div>
        <div className="shell__section scroll">
          <h2 className="shell__section-title">Connections</h2>
          <ConnectionForm kinds={kinds} onCreated={onCreated} />
        </div>
      </nav>

      <main className="shell__canvas">
        {/* M1-10's chat panel stands in for the canvas until M4 builds the
            real one. It is here rather than in a separate route because M1 has
            no router and adding one for a single surface would be scaffolding
            with no second user. */}
        <ChatPanel refreshToken={refreshToken} onConnectionCount={setConnectionCount} />
      </main>

      <aside className="shell__inspector" aria-label="Inspector">
        <div className="shell__section">
          <h2 className="shell__section-title">OmniRoute</h2>
          <OmniRouteSetup onImported={onCreated} />
        </div>
        <div className="shell__section">
          <h2 className="shell__section-title">Inspector</h2>
          <p className="shell__empty">Select a node to configure it.</p>
        </div>
      </aside>

      <StatusBar />
    </div>
  );
}
