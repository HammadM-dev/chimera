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
      <nav className="shell__rail" aria-label="Workspace">
        <h2 className="shell__region-title">Workflows</h2>
        <p className="shell__empty">Build your first workflow, or start from a template.</p>
        <ConnectionForm kinds={kinds} onCreated={onCreated} />
      </nav>
      <main className="shell__canvas">
        {/* M1-10's chat panel stands in for the canvas until M4 builds the
            real one. It is here rather than in a separate route because M1 has
            no router and adding one for a single surface would be scaffolding
            with no second user. */}
        <ChatPanel refreshToken={refreshToken} />
      </main>
      <aside className="shell__inspector" aria-label="Inspector">
        <h2 className="shell__region-title">Inspector</h2>
        <p className="shell__empty">Select a node to configure it.</p>
        <OmniRouteSetup onImported={onCreated} />
      </aside>
      <StatusBar />
    </div>
  );
}
