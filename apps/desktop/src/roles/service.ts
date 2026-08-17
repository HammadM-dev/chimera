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
      })),
  };
}
