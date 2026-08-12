import { useEffect, useState } from 'react';
import { bridge } from '../chat/useChimera.ts';

// The agent roster, from the real role registry. Grouped for the palette by
// what the agent is *for* rather than alphabetically: someone building an
// automation thinks "who plans this, who does it, who checks it".

export interface AgentRole {
  id: string;
  name: string;
  systemPrompt: string;
  toolAllowlist: string[];
  tier: string;
  maxIterations: number;
  maxCostUsd: number | null;
}

export const AGENT_GROUPS: { label: string; ids: string[] }[] = [
  { label: 'Planning', ids: ['planner'] },
  { label: 'Working', ids: ['coder', 'researcher', 'browser-operator', 'data-extractor'] },
  { label: 'Review', ids: ['reviewer', 'qa'] },
  { label: 'Swarm', ids: ['summariser'] },
];

export function useRoles(): AgentRole[] {
  const [roles, setRoles] = useState<AgentRole[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{ roles: AgentRole[] }>('role:list', {});
        setRoles(result.roles);
      } catch {
        // The palette renders empty rather than taking the view down. A roster
        // that failed to load is visible as an empty palette; a thrown error
        // here would blank the whole builder.
      }
    })();
  }, []);

  return roles;
}
