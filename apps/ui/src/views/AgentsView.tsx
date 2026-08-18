import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useRoles } from './useRoles.ts';
import { AgentEditor, BLANK_AGENT, agentDraftFrom, type AgentDraft } from './AgentEditor.tsx';
import './views.css';

// The roster, in full, and the place agents are made.
//
// Every agent shows the two things that decide whether it is safe to put in an
// automation: what it is told to do, and what it is allowed to touch. Clicking
// one opens it — including the ones CHIMERA ships, because a starter agent
// whose prompt does not suit your business is a starter agent you should be
// able to fix rather than work around.

export function AgentsView({
  onChanged,
  startBuilding = false,
  onStartedBuilding,
}: {
  onChanged?: () => void;
  /** True when the user pressed "Build an agent" somewhere else — the palette. */
  startBuilding?: boolean;
  onStartedBuilding?: () => void;
}): JSX.Element {
  const [refreshToken, setRefreshToken] = useState(0);
  const roles = useRoles(refreshToken);
  const [editing, setEditing] = useState<AgentDraft | null>(startBuilding ? BLANK_AGENT : null);

  // Arriving here from the palette means the editor, not the list: the person
  // already decided they need an agent, and showing them the roster again is
  // asking the question twice.
  useEffect(() => {
    if (!startBuilding) return;
    setEditing(BLANK_AGENT);
    onStartedBuilding?.();
  }, [startBuilding, onStartedBuilding]);

  const finish = useCallback(() => {
    setEditing(null);
    setRefreshToken((current) => current + 1);
    onChanged?.();
  }, [onChanged]);

  if (editing !== null) {
    return (
      <AgentEditor
        draft={editing}
        onSaved={finish}
        onCancel={() => {
          setEditing(null);
        }}
      />
    );
  }

  return (
    <div className="agents" data-testid="agents-view">
      <button
        type="button"
        className="agent-card agent-card--new"
        data-testid="agent-add"
        onClick={() => {
          setEditing(BLANK_AGENT);
        }}
      >
        <span className="agent-card__plus" aria-hidden="true">
          +
        </span>
        <h3 className="agent-card__name">Build an agent</h3>
        <p className="agent-card__prompt">
          One you write yourself: what it is for, what it may touch, and where it has to stop.
        </p>
      </button>

      {roles.map((role) => (
        <button
          key={role.id}
          type="button"
          className="agent-card"
          data-testid={`agent-card-${role.id}`}
          onClick={() => {
            setEditing(agentDraftFrom(role));
          }}
        >
          <h3 className="agent-card__name">
            {role.name}
            {role.isBuiltin !== true && <span className="tag">yours</span>}
          </h3>
          <p className="agent-card__prompt">{role.systemPrompt}</p>
          {/* What it may touch, in full on hover and in part on the card. Every
              grant listed made the tags taller than the prompt above them, and
              the roster stopped being scannable at eight agents. */}
          <div className="agent-card__tags" title={role.toolAllowlist.join(', ')}>
            <span className="tag">{role.tier}</span>
            <span className="tag">{role.maxIterations} iterations</span>
            {role.combinesMany === true && <span className="tag">takes many inputs</span>}
            {role.toolAllowlist.length === 0 ? (
              <span className="tag">No tools</span>
            ) : (
              <>
                {role.toolAllowlist.slice(0, 3).map((tool) => (
                  <span key={tool} className="tag">
                    {tool}
                  </span>
                ))}
                {role.toolAllowlist.length > 3 && (
                  <span className="tag">+{role.toolAllowlist.length - 3} more</span>
                )}
              </>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
