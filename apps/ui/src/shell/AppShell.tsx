import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { ChatPanel } from '../chat/ChatPanel.tsx';
import { AgentsView } from '../views/AgentsView.tsx';
import { CanvasView, type AutomationTemplate } from '../views/CanvasView.tsx';
import { HomeView } from '../views/HomeView.tsx';
import { MemoryView } from '../views/MemoryView.tsx';
import { ProvidersView } from '../views/ProvidersView.tsx';
import { RunsView } from '../views/RunsView.tsx';
import { StatusBar } from './StatusBar.tsx';
import { Confirm } from './Confirm.tsx';
import { bridge } from '../chat/useChimera.ts';
import './shell.css';
import { useProfile } from '../useProfile.ts';

// CHIMERA is a place you build automations, so the frame is a sidebar of places
// and one surface that changes — not a chat window with settings around it.
// M4's canvas replaces the builder's middle column; the frame does not move.

type View = 'home' | 'build' | 'runs' | 'agents' | 'memory' | 'providers' | 'chat';

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
    view: 'runs',
    label: 'Runs',
    icon: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3.2l2 1.3" />
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
    view: 'memory',
    label: 'Memory',
    icon: (
      <>
        <path d="M8 2.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3z" />
        <path d="M5 6.5H3.5M11 6.5h1.5M5 9.5H3.5M11 9.5h1.5" />
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
  runs: {
    title: 'Runs',
    subtitle:
      'Every run this workspace has made, what it cost, and the trace of what happened inside it.',
  },
  memory: {
    title: 'Memory',
    subtitle:
      'Everything the agents and you have recorded. Each entry says who wrote it and how sure they were.',
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

export function AppShell(): JSX.Element {
  const { profile, save } = useProfile();
  const theme = profile?.theme ?? 'dark';
  const [view, setView] = useState<View>('home');
  const [goal, setGoal] = useState('');
  const [template, setTemplate] = useState<AutomationTemplate | null>(null);
  const [canvasKey, setCanvasKey] = useState(0);
  const [buildingAgent, setBuildingAgent] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string }[]>([]);
  // Bumped whenever the set of connections changes, so every view reading it
  // re-reads rather than each keeping its own copy and disagreeing.
  const [refreshToken, setRefreshToken] = useState(0);
  const [forgetting, setForgetting] = useState<{ id: string; name: string } | null>(null);

  const onChanged = useCallback(() => {
    setRefreshToken((current) => current + 1);
  }, []);

  const loadSaved = useCallback(async () => {
    try {
      const result = await bridge().invoke<{ workflows: { id: string; name: string }[] }>(
        'workflow:list',
        {},
      );
      setSaved(result.workflows);
    } catch {
      // An empty list reads as "nothing saved yet", which is the honest answer
      // to both no automations and a failed read.
    }
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved, refreshToken]);

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
            setTemplate(null);
            setOpenId(null);
            // Bumped so the canvas remounts. Without it "New automation"
            // cleared the sidebar's idea of what was open and left the previous
            // graph, its brief and its saved id sitting on screen — a new
            // automation that was the old one wearing a different label.
            setCanvasKey((current) => current + 1);
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
        {saved.length === 0 ? (
          <p className="sidebar__hint">Automations you save will appear here.</p>
        ) : (
          <div className="sidebar__nav" data-testid="saved-list">
            {saved.map((automation) => (
              <div key={automation.id} className="sidebar__saved">
                <button
                  type="button"
                  className="sidebar__item"
                  data-testid={`saved-${automation.id}`}
                  onClick={() => {
                    setTemplate(null);
                    setOpenId(automation.id);
                    setView('build');
                  }}
                >
                  {automation.name}
                </button>
                {/* Quiet until the row is under the pointer: a list of the
                    things you work on should not be a row of delete buttons. */}
                <button
                  type="button"
                  className="sidebar__forget"
                  data-testid={`forget-${automation.id}`}
                  title={`Remove ${automation.name}`}
                  aria-label={`Remove ${automation.name}`}
                  onClick={() => {
                    setForgetting(automation);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="sidebar__spacer" />

        <div className="sidebar__footer">
          {/* What used to be here was "Replay intro", which answered a question
              nobody in the middle of their work was asking. The footer is prime
              space in a rail somebody looks at all day; a light switch earns it
              and a rewind button does not. */}
          <button
            type="button"
            className="button button--ghost sidebar__setup"
            data-testid="nav-theme"
            aria-pressed={theme === 'light'}
            onClick={() => {
              void save({ theme: theme === 'dark' ? 'light' : 'dark' });
            }}
          >
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <span className="chip chip--ok">Local</span>
        </div>
      </nav>

      <main className="main">
        {view === 'home' ? (
          <HomeView
            onDescribe={(description, planned) => {
              setGoal(description);
              setTemplate(planned);
              setOpenId(null);
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

            {view === 'build' && (
              <CanvasView
                key={`${openId ?? 'new'}-${String(canvasKey)}`}
                rolesToken={refreshToken}
                onBuildAgent={() => {
                  setBuildingAgent(true);
                  setView('agents');
                }}
                goal={goal}
                template={template}
                openId={openId}
                onSaved={() => void loadSaved()}
              />
            )}
            {view === 'chat' && <ChatPanel />}
            {view === 'runs' && <RunsView />}
            {view === 'memory' && <MemoryView />}
            {view === 'agents' && (
              <div className="view__body scroll">
                <AgentsView
                  onChanged={onChanged}
                  startBuilding={buildingAgent}
                  onStartedBuilding={() => {
                    setBuildingAgent(false);
                  }}
                />
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

      <Confirm
        open={forgetting !== null}
        title={`Delete ${forgetting?.name ?? ''}?`}
        body={
          <>
            The automation and everything it was built from goes. Its runs stay in Runs, with what
            they produced and what they cost.
          </>
        }
        confirmLabel="Delete automation"
        onCancel={() => {
          setForgetting(null);
        }}
        onConfirm={() => {
          const target = forgetting;
          setForgetting(null);
          if (!target) return;
          void (async () => {
            await bridge().invoke('workflow:remove', { id: target.id });
            if (openId === target.id) setOpenId(null);
            setRefreshToken((current) => current + 1);
          })();
        }}
      />

      <StatusBar changed={refreshToken} />
    </div>
  );
}
