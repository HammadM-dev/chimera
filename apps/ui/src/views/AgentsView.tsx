import type { JSX } from 'react';
import { useRoles } from './useRoles.ts';
import './views.css';

// The roster, in full. Every agent shows the two things that decide whether it
// is safe to put in an automation: what it is told to do, and what it is
// allowed to touch.

export function AgentsView(): JSX.Element {
  const roles = useRoles();

  return (
    <div className="agents" data-testid="agents-view">
      {roles.map((role) => (
        <article key={role.id} className="agent-card">
          <h3 className="agent-card__name">{role.name}</h3>
          <p className="agent-card__prompt">{role.systemPrompt}</p>
          <div className="agent-card__tags">
            <span className="tag">{role.tier}</span>
            <span className="tag">{role.maxIterations} iterations</span>
            {role.toolAllowlist.length === 0 ? (
              <span className="tag">No tools</span>
            ) : (
              role.toolAllowlist.map((tool) => (
                <span key={tool} className="tag">
                  {tool}
                </span>
              ))
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
