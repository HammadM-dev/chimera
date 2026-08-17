// Which tool calls cannot be taken back.
//
// CLAUDE.md: "Irreversible actions require a gate." That rule needs something
// to test, and until this file existed the agent loop declared every call
// irreversible — the conservative reading, correct while nothing else could be
// said, and useless as a rule because it never distinguished anything.
//
// Declared here rather than on the MCP descriptors because it is a claim about
// consequences in the world, not about the tool's interface, and because an
// external MCP server's own word for it is not something CHIMERA should take.

/** Calls whose effect outlives the run no matter what arguments they carry. */
const ALWAYS: readonly string[] = [
  // A command has whatever effect it has. Sandboxed to a directory, not to a
  // set of consequences: `curl | sh` is one string away.
  'shell.exec',
];

/** Calls whose effect stays inside the run's own sandbox, and stops there. */
const CONTAINED: readonly string[] = [
  'filesystem.readFile',
  'filesystem.listDirectory',
  'filesystem.writeFile',
  'filesystem.makeDirectory',
  // Memory is a store the user can read and delete from in the Memory section.
  // A wrong memory is a row to remove, not an action to undo.
  'memory.remember',
  'memory.recall',
];

/**
 * Whether one call, with these arguments, is irreversible.
 *
 * Arguments matter for exactly one tool today: an HTTP GET reads and a POST
 * does something. Treating both the same would either gate every lookup or let
 * every submission through, and neither is the behaviour anybody wants.
 *
 * Unknown tools — anything from an external MCP server — are irreversible. A
 * server CHIMERA has never seen is not a server whose side effects it can
 * vouch for.
 */
export function isIrreversible(toolId: string, args: Record<string, unknown> = {}): boolean {
  if (ALWAYS.includes(toolId)) return true;
  if (CONTAINED.includes(toolId)) return false;

  if (toolId === 'http.request') {
    const method = typeof args['method'] === 'string' ? args['method'].toUpperCase() : 'GET';
    return method !== 'GET' && method !== 'HEAD';
  }

  return true;
}

/** Every tool this build ships and can therefore vouch for. */
const KNOWN: readonly string[] = [...ALWAYS, ...CONTAINED, 'http.request'];

/**
 * Allowlist entries that are irreversible however they are called.
 *
 * What the save-time validator asks. It sees a role's allowlist rather than a
 * call, so it can only refuse what no set of arguments could make safe:
 * `shell.exec`, and any server this build has never heard of. `http.request`
 * is deliberately absent — a GET is a read, and refusing every automation that
 * can look something up would teach people to route around the rule. That case
 * is caught at call time, by the Governor, which has the arguments.
 *
 * Understands the wildcards roles are written with: `filesystem.*` expands to
 * four contained calls, `payments.*` expands to nothing known at all.
 */
export function alwaysIrreversibleTools(patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => {
    if (pattern.endsWith('.*')) {
      const prefix = `${pattern.slice(0, -2)}.`;
      const expanded = KNOWN.filter((toolId) => toolId.startsWith(prefix));
      // An unknown server grants unknown calls.
      if (expanded.length === 0) return true;
      return expanded.some((toolId) => ALWAYS.includes(toolId));
    }

    if (CONTAINED.includes(pattern) || pattern === 'http.request') return false;
    return true;
  });
}
