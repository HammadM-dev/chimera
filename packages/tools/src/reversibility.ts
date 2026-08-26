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
  // Clicking and typing are how a browser sends, buys, publishes and deletes.
  // Unlike an HTTP method, the arguments cannot tell us which: a selector is
  // `#send` or `.btn-primary`, and neither says what the button does. The
  // honest classification is the one that assumes it sends.
  'browser.click',
  'browser.type',
  // A sent message is gone. There is no protocol for taking one back, and the
  // recipient has already read it or has not — which is exactly the shape of
  // thing CLAUDE.md requires a person to approve first.
  'email.send',
  'email.reply',
  // One tool standing in for ten thousand: Composio's `execute` is how an agent
  // sends the Gmail, creates the Jira issue, posts to the channel and charges
  // the card. The slug says which — `GMAIL_SEND_EMAIL` is legible enough — but
  // this build has no list of which of Composio's thousands are safe, and a
  // guess that gets one wrong sends something on somebody's behalf. Declared
  // irreversible outright, so it needs an approval step in front of it like
  // anything else that cannot be taken back.
  'composio.execute',
];

/** Calls whose effect stays inside the run's own sandbox, and stops there. */
const CONTAINED: readonly string[] = [
  'filesystem.readFile',
  'filesystem.listDirectory',
  'filesystem.writeFile',
  'filesystem.makeDirectory',
  // Memory is a store the user can read, and forget entries from, in the
  // Memory section. A wrong memory is a row to remove, not an action to undo.
  'memory.remember',
  'memory.recall',
  // Reading the web. A page load leaves the machine, which is why the egress
  // allowlist governs it — but it changes nothing on the other end.
  'browser.navigate',
  'browser.read',
  'browser.extract',
  // Reading the markup is reading. It exists because the text-only tools could
  // not answer "collect the link for each result", which is most of what a
  // browsing agent is asked to do.
  'browser.html',
  'browser.screenshot',
  // A query to a search engine. It leaves the machine and changes nothing at
  // the far end — the same category as loading a page, and the reason a
  // research agent does not need a gate to look something up.
  'search.web',
  // The workspace server, all of it. There is no tool on it that writes,
  // deletes, renames or runs anything — `planAutomation` returns a design and
  // applies nothing — so reading this workspace is as contained as reading a
  // page. Listed by name rather than as `workspace.*` so that a tool added
  // there later has to be considered rather than inheriting this.
  'workspace.automations',
  'workspace.agents',
  'workspace.runs',
  'workspace.run',
  'workspace.notes',
  'workspace.plugins',
  'workspace.providers',
  'workspace.templates',
  'workspace.folders',
  'workspace.planAutomation',
  // Composio's two reads. Listing the connected apps and searching for a tool
  // change nothing at the far end.
  //
  // `composio.execute` is deliberately absent: it is the one that sends the
  // email, creates the issue and posts the message, and this build cannot tell
  // which of ten thousand slugs are the harmless ones. It falls through to the
  // default — irreversible, needs a gate — which is what a tool named
  // GMAIL_SEND_EMAIL should get.
  'composio.toolkits',
  'composio.search',
  // The notes board, all of it including the writes.
  //
  // A note is a row on a board the person is looking at, with an edit and a
  // delete next to it — the same call `memory.remember` gets, for the same
  // reason. Gating it would mean an assistant that spotted something worth
  // remembering had to interrupt somebody to ask permission to write it down,
  // which is worse than the thing being written down.
  'notebook.list',
  'notebook.add',
  'notebook.update',
  // Reading a mailbox changes nothing in it. Marking as read is not done here:
  // these fetch without touching flags, so a triage run leaves an inbox exactly
  // as it found it.
  'email.list',
  'email.read',
  'email.search',
];

/**
 * Folds a per-app Composio server back onto the rules written for `composio`.
 *
 * An App operator can be pointed at one app rather than at everything the
 * workspace has connected, and the way that is enforced is that it gets its own
 * server — `composio-gmail` — holding only that app's tools. Same three tools,
 * same consequences: `composio-gmail.execute` sends an email exactly as
 * `composio.execute` does, and `composio-gmail.search` reads exactly as
 * `composio.search` does.
 *
 * Without this they would both fall through to the unknown-server default and
 * be treated as irreversible, so an operator pointed at one app could not even
 * look up which tools exist without an approval step in front of it.
 */
function canonicalId(toolId: string): string {
  if (!toolId.startsWith('composio-')) return toolId;
  const dot = toolId.indexOf('.');
  return dot === -1 ? toolId : `composio.${toolId.slice(dot + 1)}`;
}

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
export function isIrreversible(rawToolId: string, args: Record<string, unknown> = {}): boolean {
  const toolId = canonicalId(rawToolId);
  if (ALWAYS.includes(toolId)) return true;
  if (CONTAINED.includes(toolId)) return false;

  if (toolId === 'http.request') {
    const method = typeof args['method'] === 'string' ? args['method'].toUpperCase() : 'GET';
    return method !== 'GET' && method !== 'HEAD';
  }

  return true;
}

/** Every tool this build ships and can therefore vouch for. */
/**
 * Every tool id this build ships, whatever its reversibility.
 *
 * Exported so the list a person picks from can be checked against it. That list
 * lives in the desktop app and is written by hand, and it had silently fallen
 * two tools behind: `browser.html` and `search.web` both existed, were both
 * registered, and could not be granted to an agent by anybody using the editor.
 */
export const KNOWN: readonly string[] = [...ALWAYS, ...CONTAINED, 'http.request'];

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
