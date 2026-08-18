import { createRoleRegistry, type RoleRegistry } from '@chimera/core';
import { getStore } from '../store/lifecycle.ts';

// The roster the automation builder draws from. Reads the real role registry,
// so the agents a user can put in an automation are exactly the agents the
// runtime will execute — a palette invented in the renderer would drift from
// the runtime the first time either changed.

let registry: RoleRegistry | undefined;

function roles(): RoleRegistry {
  registry ??= createRoleRegistry(getStore());
  return registry;
}

export function closeRoles(): void {
  registry = undefined;
}

/** The roster as the runtime knows it, not as the renderer shows it. */
export function allRoles() {
  return roles().list();
}

export function listRoles() {
  return {
    roles: roles()
      .list()
      .map((role) => ({
        id: role.id,
        name: role.name,
        systemPrompt: role.systemPrompt,
        toolAllowlist: [...role.toolAllowlist],
        tier: role.modelBinding.tier,
        maxIterations: role.maxIterations,
        maxCostUsd: role.budget.maxCostUsd,
        maxTokens: role.budget.maxTokens,
        combinesMany: role.combinesMany,
        outputFormat: role.outputContract.format,
        isBuiltin: role.isBuiltin,
      })),
  };
}

export interface SaveRoleInput {
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
}

/**
 * Creates or edits an agent.
 *
 * An id is derived from the name for a new one and never changed afterwards:
 * saved automations refer to agents by id, and an id that followed a rename
 * would break every automation using it the moment somebody fixed a typo.
 */
export function saveRole(input: SaveRoleInput) {
  const registry = roles();
  const existing = input.id === '' ? undefined : registry.get(input.id);

  const id =
    existing?.id ??
    (input.id !== ''
      ? input.id
      : input.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || `agent-${String(Date.now())}`);

  const saved = registry.save({
    id,
    name: input.name.trim() === '' ? id : input.name.trim(),
    systemPrompt: input.systemPrompt,
    toolAllowlist: input.toolAllowlist,
    modelBinding: {
      tier: (input.tier === '' ? 'balanced' : input.tier) as never,
      preferredModel: existing?.modelBinding.preferredModel ?? null,
    },
    budget: {
      maxTokens: input.maxTokens ?? existing?.budget.maxTokens ?? 200_000,
      maxCostUsd: input.maxCostUsd,
      maxWallClockMs: existing?.budget.maxWallClockMs ?? 10 * 60_000,
    },
    outputContract: {
      format: (input.outputFormat === '' ? 'text' : input.outputFormat) as never,
      schemaId: input.outputFormat === 'json' ? (existing?.outputContract.schemaId ?? null) : null,
    },
    maxIterations: Math.max(1, Math.min(50, input.maxIterations)),
    combinesMany: input.combinesMany,
    // A user's agent is never builtin, and editing a shipped one does not make
    // it one either — that flag is about who wrote it, not who last touched it.
    isBuiltin: existing?.isBuiltin ?? false,
  });

  return { id: saved.id };
}

export function removeRole(id: string) {
  return roles().remove(id);
}
