import type { Role } from '../runtime/roleRegistry.ts';

// Which apps one App operator step may reach.
//
// CLAUDE.md: "Capability limits are the real defence, not prompt wording. An
// agent cannot misuse a tool it was never granted." This is the grant, for the
// case where the same agent runs twice in one automation against two different
// accounts — the step that triages support mail and the step that posts release
// notes are the same App operator, and neither should be able to do the other's
// job.
//
// The mechanism is that each connected app is registered as its own tool server
// — `composio-gmail`, `composio-slack` — holding that app's tools and no
// others, the same arrangement the mailboxes use. Narrowing a step is therefore
// not a filter applied to a list the agent can see: the agent's list has
// nothing else in it.

/** The server id one app's tools live on. Mirrors `serverIdForToolkit`. */
export function serverIdForApp(slug: string): string {
  return `composio-${slug.toLowerCase()}`;
}

/**
 * A role narrowed to the apps a step chose.
 *
 * Empty means every connected app, which is what an operator nobody has
 * narrowed has always had — so an automation saved before this existed is
 * unchanged by it.
 *
 * A role with no Composio grant comes back untouched. Naming apps on a step
 * whose agent cannot reach Composio at all must not hand it one: this narrows
 * a capability, it never adds one.
 */
export function narrowedToApps(role: Role, apps: readonly string[] | undefined): Role {
  const wanted = [
    ...new Set((apps ?? []).map((slug) => slug.trim().toLowerCase()).filter((slug) => slug !== '')),
  ];
  if (wanted.length === 0) return role;

  const holdsComposio = role.toolAllowlist.some((entry) => entry.startsWith('composio.'));
  if (!holdsComposio) return role;

  return {
    ...role,
    toolAllowlist: [
      ...role.toolAllowlist.filter((entry) => !entry.startsWith('composio.')),
      ...wanted.map((slug) => `${serverIdForApp(slug)}.*`),
    ],
  };
}
