import { useState } from 'react';
import type { JSX } from 'react';
import { AGENT_GROUPS, useRoles, type AgentRole } from './useRoles.ts';
import './views.css';

// The builder: pick agents, put them in order, see what each one is allowed to
// do. The steps are the same roles the runtime executes, so what you assemble
// here is what would run — not a drawing of it.

interface Props {
  goal: string;
}

interface Step {
  key: string;
  role: AgentRole;
}

export function BuilderView({ goal }: Props): JSX.Element {
  const roles = useRoles();
  const [steps, setSteps] = useState<Step[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const add = (role: AgentRole): void => {
    const key = `${role.id}-${String(Date.now())}`;
    setSteps((current) => [...current, { key, role }]);
    setSelected(key);
  };

  const detail = steps.find((step) => step.key === selected)?.role;

  return (
    <div className="builder" data-testid="builder-view">
      <aside className="builder__palette scroll" aria-label="Agents">
        {AGENT_GROUPS.map((group) => {
          const members = group.ids
            .map((id) => roles.find((role) => role.id === id))
            .filter((role): role is AgentRole => role !== undefined);
          if (members.length === 0) return null;

          return (
            <div key={group.label}>
              <p className="builder__section">{group.label}</p>
              {members.map((role) => (
                <button
                  key={role.id}
                  type="button"
                  className="palette__agent"
                  data-testid={`palette-${role.id}`}
                  onClick={() => {
                    add(role);
                  }}
                >
                  <span className="palette__name">{role.name}</span>
                  <span className="palette__meta">
                    {role.tier} ·{' '}
                    {role.toolAllowlist.length === 0
                      ? 'no tools'
                      : `${String(role.toolAllowlist.length)} tools`}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </aside>

      <div className="builder__canvas scroll">
        {steps.length === 0 ? (
          <p className="sequence__empty" data-testid="sequence-empty">
            {goal === ''
              ? 'Add an agent from the left to begin. Each one runs in order, and each declares what it may use.'
              : `Building: ${goal}. Add the first agent from the left.`}
          </p>
        ) : (
          <div className="sequence" data-testid="sequence">
            {steps.map((step, index) => (
              <div key={step.key}>
                {index > 0 && <div className="sequence__link" />}
                <button
                  type="button"
                  className="step"
                  aria-current={step.key === selected}
                  onClick={() => {
                    setSelected(step.key);
                  }}
                >
                  <span className="step__index">{index + 1}</span>
                  <span className="step__body">
                    <span className="step__name">{step.role.name}</span>
                    <span className="step__meta">
                      {step.role.toolAllowlist.length === 0
                        ? 'No tools'
                        : step.role.toolAllowlist.join(', ')}
                    </span>
                  </span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <aside className="builder__inspector scroll" aria-label="Step detail">
        {detail ? (
          <>
            <p className="builder__section">{detail.name}</p>
            <p className="agent-card__prompt">{detail.systemPrompt}</p>
            <p className="builder__section">Allowed tools</p>
            <div className="agent-card__tags">
              {detail.toolAllowlist.length === 0 ? (
                <span className="tag">None</span>
              ) : (
                detail.toolAllowlist.map((tool) => (
                  <span key={tool} className="tag">
                    {tool}
                  </span>
                ))
              )}
            </div>
            <p className="builder__section">Limits</p>
            <div className="agent-card__tags">
              <span className="tag">{detail.maxIterations} iterations max</span>
              <span className="tag">
                {detail.maxCostUsd === null
                  ? 'No cost cap'
                  : `$${detail.maxCostUsd.toFixed(2)} cap`}
              </span>
              <span className="tag">{detail.tier} model</span>
            </div>
          </>
        ) : (
          <p className="sequence__empty">Select a step to see what that agent may do.</p>
        )}
      </aside>
    </div>
  );
}
