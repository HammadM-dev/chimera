import { ToolAllowlistError } from '@chimera/errors';

// CLAUDE.md hard rule 3: "Capability limits are the real defence, not prompt
// wording. An agent cannot misuse a tool it was never granted."
//
// This module is the concrete mechanism. It takes a tool id and a role, and
// answers from those two facts alone. It has no parameter for prompt text,
// conversation history, or tool output, and that absence is the design: a
// function that cannot see the model's words cannot be talked round by them.

/** The slice of a role this check needs. M2-5 defines the full role record. */
export interface AllowlistedRole {
  id: string;
  /**
   * Tool ids this role may invoke.
   *
   * Entries are either an exact id (`filesystem.readFile`) or a whole server
   * (`filesystem.*`). There is no bare `*`: a role that may call every tool in
   * existence, including ones added by a future milestone it was never reviewed
   * against, is not a capability limit.
   */
  toolAllowlist: readonly string[];
}

/** Splits `filesystem.readFile` into its server and tool halves. */
function serverOf(toolId: string): string {
  const dot = toolId.indexOf('.');
  return dot === -1 ? toolId : toolId.slice(0, dot);
}

export function isToolAllowed(toolId: string, role: AllowlistedRole): boolean {
  return role.toolAllowlist.some((entry) => entry === toolId || entry === `${serverOf(toolId)}.*`);
}

/**
 * Throws unless the role may call this tool.
 *
 * Called before dispatch, never after: the point is that the underlying tool is
 * not reached, not that its result is discarded.
 */
export function assertToolAllowed(toolId: string, role: AllowlistedRole): void {
  if (isToolAllowed(toolId, role)) return;
  throw new ToolAllowlistError(`Role "${role.id}" is not allowed to call "${toolId}".`, {
    toolId,
    roleId: role.id,
    allowlist: [...role.toolAllowlist],
  });
}
