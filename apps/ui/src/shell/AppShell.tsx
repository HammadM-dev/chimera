import { useCallback, useState } from 'react';
import type { JSX } from 'react';
import { ChatPanel } from '../chat/ChatPanel.tsx';
import { AgentsView } from '../views/AgentsView.tsx';
import { CanvasView } from '../views/CanvasView.tsx';
import { HomeView } from '../views/HomeView.tsx';
import { ProvidersView } from '../views/ProvidersView.tsx';
import { StatusBar } from './StatusBar.tsx';
import './shell.css';

// CHIMERA is a place you build automations, so the frame is a sidebar of places
// and one surface that changes — not a chat window with settings around it.
// M4's canvas replaces the builder's middle column; the frame does not move.

type View = 'home' | 'build' | 'agents' | 'providers' | 'chat';

const NAV: { view: View; label: string; icon: JSX.Element }[] = [
  {
    view: 'home',
    label: 'Home',
    icon: <path d="M2.5 6.5 8 2l5.5 4.5V13a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />,
  },
  {
    view: 'build',
    label: 'Automations',
    icon: (
      <>
        <rect x="2.5" y="2.5" width="4" height="4" rx="1" />
        <rect x="9.5" y="9.5" width="4" height="4" rx="1" />
        <path d="M4.5 6.5v3a2 2 0 0 0 2 2h3" />
      </>
    ),
  },
  {
    view: 'agents',
    label: 'Agents',
    icon: (
      <>
        <circle cx="8" cy="5.5" r="2.5" />
        <path d="M3 13.5a5 5 0 0 1 10 0" />
      </>
    ),
  },
  {
    view: 'providers',
    label: 'Providers',
    icon: (
      <>
        <path d="M6.5 9.5 9 7" />
        <path d="M4 12a2.5 2.5 0 0 1 0-3.5l1.5-1.5" />
        <path d="M12 4a2.5 2.5 0 0 1 0 3.5L10.5 9" />
      </>
    ),
  },
  {
    view: 'chat',
    label: 'Test a model',
    icon: <path d="M2.5 4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3.5 2.5z" />,
  },
];

const TITLES: Record<View, { title: string; subtitle: string }> = {
  home: { title: 'Home', subtitle: '' },
  build: {
    title: 'Automation',
    subtitle:
      'Drag agents onto the canvas, join them to say what runs after what, and click one to choose its model.',
  },
  agents: {
    title: 'Agents',
    subtitle: 'The roster an automation draws from. Editing these is a workspace-wide change.',
  },
  providers: {
    title: 'Providers',
    subtitle: 'Where models come from. Keys go to your OS keychain, never the database.',
  },
  chat: {
    title: 'Test a model',
    subtitle: 'A direct conversation with one provider, for checking a model before you use it.',
  },
};

interface ShellProps {
  /**
   * Re-opens first-run setup.
   *
   * Reachable at any time, because the alternative — the one this repository
   * actually shipped for a day — is telling a user to delete a directory to
   * see their own app's first-run guide. A guide that can only be seen once,
   * by accident of state, cannot be checked by the person who wrote it either.
   */
  onRunSetup: () => void;
}

export function AppShell({ onRunSetup }: ShellProps): JSX.Element {
  const [view, setView] = useState<View>('home');
  const [goal, setGoal] = useState('');
  // Bumped whenever the set of connections changes, so every view reading it
  // re-reads rather than each keeping its own copy and disagreeing.
  const [refreshToken, setRefreshToken] = useState(0);

  const onChanged = useCallback(() => {
    setRefreshToken((current) => current + 1);
  }, []);

  return (
    <div className="shell" data-testid="app-shell">
      <nav className="sidebar" aria-label="Workspace">
        <div className="sidebar__brand">
          <h1 className="sidebar__wordmark">CHIMERA</h1>
        </div>

        <button
          type="button"
          className="sidebar__new"
          data-testid="nav-new"
          onClick={() => {
            setGoal('');
            setView('build');
          }}
        >
          <svg className="sidebar__icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
          New automation
        </button>

        <div className="sidebar__nav">
          {NAV.map((item) => (
            <button
              key={item.view}
              type="button"
              className="sidebar__item"
              data-testid={`nav-${item.view}`}
              aria-current={view === item.view ? 'page' : undefined}
              onClick={() => {
                setView(item.view);
              }}
            >
              <svg className="sidebar__icon" viewBox="0 0 16 16" aria-hidden="true">
                {item.icon}
              </svg>
              {item.label}
            </button>
          ))}
        </div>

        <p className="sidebar__group">Recent</p>
        <p className="sidebar__hint">Automations you save will appear here.</p>

        <div className="sidebar__spacer" />

        <div className="sidebar__footer">
          <button
            type="button"
            className="button button--ghost sidebar__setup"
            data-testid="nav-setup"
            onClick={onRunSetup}
          >
            Setup guide
          </button>
          <span className="chip chip--ok">Local</span>
        </div>
      </nav>

      <main className="main">
        {view === 'home' ? (
          <HomeView
            onDescribe={(description) => {
              setGoal(description);
              setView('build');
            }}
            onBrowseAgents={() => {
              setView('agents');
            }}
          />
        ) : (
          <section className="view">
            <header className="view__header">
              <div>
                <h2 className="view__title">{TITLES[view].title}</h2>
                <p className="view__subtitle">{TITLES[view].subtitle}</p>
              </div>
            </header>

            {view === 'build' && <CanvasView goal={goal} />}
            {view === 'chat' && <ChatPanel />}
            {view === 'agents' && (
              <div className="view__body scroll">
                <AgentsView />
              </div>
            )}
            {view === 'providers' && (
              <div className="view__body scroll">
                <ProvidersView refreshToken={refreshToken} onChanged={onChanged} />
              </div>
            )}
          </section>
        )}
      </main>

      <StatusBar />
    </div>
  );
}
