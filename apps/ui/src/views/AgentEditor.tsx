import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import type { AgentRole } from './useRoles.ts';
import { Confirm } from '../shell/Confirm.tsx';

// Building an agent, in full.
//
// An agent is four decisions and nothing else: what it is for, what it may
// touch, which tier of model it runs on, and where it has to stop. Everything
// on this form is one of those — there is no advanced section, because a
// setting a user cannot see is a setting they cannot be responsible for.

export interface ToolChoice {
  id: string;
  serverId: string;
  description: string;
  irreversible: boolean;
}

export interface AgentDraft {
  id: string;
  name: string;
  systemPrompt: string;
  toolAllowlist: string[];
  tier: string;
  maxIterations: number;
  maxCostUsd: number | null;
  maxTokens: number | null;
  combinesMany: boolean;
  outputFormat: string;
  isBuiltin: boolean;
}

export const BLANK_AGENT: AgentDraft = {
  id: '',
  name: '',
  systemPrompt: '',
  toolAllowlist: [],
  tier: 'balanced',
  maxIterations: 8,
  maxCostUsd: 1,
  maxTokens: 200_000,
  combinesMany: false,
  outputFormat: 'text',
  isBuiltin: false,
};

export function agentDraftFrom(role: AgentRole): AgentDraft {
  return {
    id: role.id,
    name: role.name,
    systemPrompt: role.systemPrompt,
    toolAllowlist: [...role.toolAllowlist],
    tier: role.tier,
    maxIterations: role.maxIterations,
    maxCostUsd: role.maxCostUsd,
    maxTokens: role.maxTokens ?? 200_000,
    combinesMany: role.combinesMany ?? false,
    outputFormat: role.outputFormat ?? 'text',
    isBuiltin: role.isBuiltin ?? false,
  };
}

interface Props {
  draft: AgentDraft;
  onSaved: (id: string) => void;
  onCancel: () => void;
}

export function AgentEditor({ draft, onSaved, onCancel }: Props): JSX.Element {
  const [agent, setAgent] = useState<AgentDraft>(draft);
  const [tools, setTools] = useState<ToolChoice[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setAgent(draft);
  }, [draft]);

  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{ tools: ToolChoice[] }>('tool:list', {});
        setTools(result.tools);
      } catch (err) {
        setNote(describeError(err).message);
      }
    })();
  }, []);

  const toggleTool = useCallback((id: string) => {
    setAgent((current) => ({
      ...current,
      toolAllowlist: current.toolAllowlist.includes(id)
        ? current.toolAllowlist.filter((tool) => tool !== id)
        : [...current.toolAllowlist, id],
    }));
  }, []);

  const save = useCallback(async () => {
    if (agent.name.trim() === '') {
      setNote('Give the agent a name.');
      return;
    }
    if (agent.systemPrompt.trim() === '') {
      setNote('Say what this agent is for. That instruction is the agent.');
      return;
    }

    setBusy(true);
    try {
      const result = await bridge().invoke<{ id: string }>('role:save', {
        id: agent.id,
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        toolAllowlist: agent.toolAllowlist,
        tier: agent.tier,
        maxIterations: agent.maxIterations,
        maxCostUsd: agent.maxCostUsd,
        maxTokens: agent.maxTokens,
        combinesMany: agent.combinesMany,
        outputFormat: agent.outputFormat,
      });
      onSaved(result.id);
    } catch (err) {
      setNote(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }, [agent, onSaved]);

  const remove = useCallback(async () => {
    try {
      const result = await bridge().invoke<{ removed: boolean; reason: string }>('role:remove', {
        id: agent.id,
      });
      if (result.removed) {
        onSaved('');
      } else {
        setNote(result.reason);
      }
    } catch (err) {
      setNote(describeError(err).message);
    }
  }, [agent.id, onSaved]);

  const byServer = new Map<string, ToolChoice[]>();
  for (const tool of tools) {
    byServer.set(tool.serverId, [...(byServer.get(tool.serverId) ?? []), tool]);
  }

  return (
    <section className="agent-editor scroll" data-testid="agent-editor">
      <header className="agent-editor__head">
        <h2 className="agent-editor__title">
          {agent.id === '' ? 'Build an agent' : `Edit ${agent.name}`}
        </h2>
        <p className="canvas__hint">
          An agent is a job description: what it does, what it may touch, and when it has to stop.
        </p>
      </header>

      <div className="field">
        <label className="field__label" htmlFor="agent-name">
          Name
        </label>
        <input
          id="agent-name"
          className="control"
          data-testid="agent-name"
          placeholder="Invoice checker"
          value={agent.name}
          onChange={(event) => {
            setAgent((current) => ({ ...current, name: event.target.value }));
          }}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="agent-prompt">
          What it is for
        </label>
        <textarea
          id="agent-prompt"
          className="canvas__instruction"
          data-testid="agent-prompt"
          rows={5}
          placeholder="You check invoices against purchase orders. You report every mismatch with the invoice number and what differs, and you never guess at a missing number."
          value={agent.systemPrompt}
          onChange={(event) => {
            setAgent((current) => ({ ...current, systemPrompt: event.target.value }));
          }}
        />
        <p className="agent-card__prompt">
          This is the agent. Write what it does, what it must always do, and what it must never do —
          the sharper it is, the less it improvises.
        </p>
      </div>

      <p className="canvas__section">What it may use</p>
      <div className="agent-editor__tools scroll" data-testid="agent-tools">
        {[...byServer.entries()].map(([serverId, group]) => (
          <div key={serverId}>
            <p className="agent-editor__server">{serverId}</p>
            {group.map((tool) => (
              <label key={tool.id} className="canvas__check">
                <input
                  type="checkbox"
                  data-testid={`agent-tool-${tool.id}`}
                  checked={agent.toolAllowlist.includes(tool.id)}
                  onChange={() => {
                    toggleTool(tool.id);
                  }}
                />
                <span>
                  {tool.id}
                  {tool.irreversible && <span className="tag">cannot be undone</span>}
                  <span className="agent-editor__toolNote">{tool.description}</span>
                </span>
              </label>
            ))}
          </div>
        ))}
        {tools.length === 0 && <p className="agent-card__prompt">No tools available yet.</p>}
      </div>

      <p className="canvas__section">How it runs</p>
      <div className="field">
        <label className="field__label" htmlFor="agent-tier">
          Model tier
        </label>
        <select
          id="agent-tier"
          className="control"
          data-testid="agent-tier"
          value={agent.tier}
          onChange={(event) => {
            setAgent((current) => ({ ...current, tier: event.target.value }));
          }}
        >
          <option value="cheap">Cheap — for work you run a thousand times</option>
          <option value="balanced">Balanced — most things</option>
          <option value="frontier">Frontier — planning, review, the final check</option>
          <option value="local">Local — whatever runs on this machine</option>
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="agent-iterations">
          Stop after this many turns
        </label>
        <input
          id="agent-iterations"
          className="control"
          type="number"
          min={1}
          max={50}
          data-testid="agent-iterations"
          value={agent.maxIterations}
          onChange={(event) => {
            setAgent((current) => ({ ...current, maxIterations: Number(event.target.value) }));
          }}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="agent-cost">
          Stop after this much spend, in dollars
        </label>
        <input
          id="agent-cost"
          className="control"
          type="number"
          min={0}
          step={0.5}
          data-testid="agent-cost"
          value={agent.maxCostUsd ?? ''}
          placeholder="No cap"
          onChange={(event) => {
            const raw = event.target.value;
            setAgent((current) => ({
              ...current,
              maxCostUsd: raw === '' ? null : Number(raw),
            }));
          }}
        />
      </div>

      <label className="canvas__check">
        <input
          type="checkbox"
          data-testid="agent-combines"
          checked={agent.combinesMany}
          onChange={(event) => {
            setAgent((current) => ({ ...current, combinesMany: event.target.checked }));
          }}
        />
        <span>
          Several agents can feed this one at once. Tick it for an agent whose job is to take many
          answers and return one — otherwise the canvas refuses more than three of the same agent
          into it.
        </span>
      </label>

      <div className="agent-editor__actions">
        <button
          type="button"
          className="button button--primary"
          data-testid="agent-save"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving' : 'Save agent'}
        </button>
        <button type="button" className="button" data-testid="agent-cancel" onClick={onCancel}>
          Cancel
        </button>
        {agent.id !== '' && !agent.isBuiltin && (
          <button
            type="button"
            className="button button--destructive"
            data-testid="agent-delete"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Delete
          </button>
        )}
      </div>

      <Confirm
        open={confirming}
        title={`Delete ${agent.name}?`}
        body={
          <>
            Any automation still using this agent will not run until you put another in its place.
            Deleting it does not change the runs it has already made.
          </>
        }
        confirmLabel="Delete agent"
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() => {
          setConfirming(false);
          void remove();
        }}
      />

      {note !== '' && (
        <p className="connections__error" data-testid="agent-note" role="alert">
          {note}
        </p>
      )}
    </section>
  );
}
