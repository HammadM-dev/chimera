import {
  getSecret,
  setSecret,
  deleteSecret,
  settingsRepository,
  type AuthRef,
} from '@chimera/store';
import type {
  ComposioBackend,
  ComposioSearchResult,
  ComposioTool,
  ComposioToolkit,
} from '@chimera/tools';
import { getStore } from '../store/lifecycle.ts';

// The half of Composio that holds the key and talks to their SDK.
//
// `packages/tools` has the server and no SDK; this has the SDK and no server.
// The same split as email and the workspace, for the same reason: the tool
// layer stays testable without a network, and the dependency lives where the
// dependency is used.
//
// The key is in the OS keychain like every other. A CHIMERA workspace is one
// Composio "user", so every automation in a workspace reaches the same
// connected accounts — which is what somebody means when they connect their
// Gmail once and expect their automations to use it.

export interface ComposioSettings {
  enabled: boolean;
  /** Vault handle. Never the key. */
  authRef: string;
  /** Which Composio user this workspace is. Stable, so connections persist. */
  userId: string;
}

const DEFAULT: ComposioSettings = { enabled: false, authRef: '', userId: '' };

/** Composio rejects anything above fifty. */
const TOOLKIT_PAGE_SIZE = 50;

/**
 * How many pages to walk before stopping.
 *
 * Six is three hundred apps, which is more than a person scrolls and four
 * round trips fewer than it sounds. A search narrows to one page in practice,
 * so this bound is only reached by the unfiltered list.
 */
const MAX_TOOLKIT_PAGES = 6;

function read(): ComposioSettings {
  const stored = settingsRepository.read(getStore()).composio;
  return stored ?? DEFAULT;
}

export function getComposio(): { enabled: boolean; hasKey: boolean; userId: string } {
  const settings = read();
  return {
    enabled: settings.enabled,
    hasKey: settings.authRef !== '',
    userId: settings.userId,
  };
}

export function setComposio(input: { enabled: boolean; apiKey?: string }): {
  enabled: boolean;
  hasKey: boolean;
  userId: string;
} {
  const db = getStore();
  const current = read();

  let authRef = current.authRef;
  if (!input.enabled) {
    // Switching it off drops the key rather than leaving it in the keychain for
    // a service nothing will call again.
    if (authRef !== '') {
      try {
        deleteSecret(authRef as AuthRef);
      } catch {
        // Already gone, or a keychain that will not talk to us. Either way the
        // handle is being dropped on the next line.
      }
    }
    authRef = '';
  } else if (input.apiKey !== undefined && input.apiKey !== '') {
    if (authRef !== '') {
      try {
        deleteSecret(authRef as AuthRef);
      } catch {
        // See above.
      }
    }
    authRef = setSecret('composio', input.apiKey);
  }

  // A workspace keeps its Composio identity for good: change it and every app
  // the user connected becomes unreachable, with no error that says why.
  const userId = current.userId === '' ? `chimera-${crypto.randomUUID()}` : current.userId;

  settingsRepository.setComposio(db, { enabled: input.enabled, authRef, userId });
  return getComposio();
}

/** The key, read at the moment it is needed and never held. */
function apiKey(): string {
  const settings = read();
  if (!settings.enabled || settings.authRef === '') return '';
  try {
    return getSecret(settings.authRef as AuthRef) ?? '';
  } catch {
    return '';
  }
}

/**
 * A session, made per call rather than cached.
 *
 * The SDK is imported lazily so that a workspace with Composio switched off
 * never loads it — and so that this module can be reached from `handlers.ts`
 * without dragging the SDK into the IPC registry's own test.
 */
interface ToolkitPage {
  items: {
    name: string;
    slug: string;
    isNoAuth: boolean;
    connection?: { isActive: boolean } | null | undefined;
  }[];
  cursor?: string | null;
  totalPages?: number;
}

/** Composio's own search answer. Verified against the live API, 2026-08-25. */
interface SearchAnswer {
  results?: {
    primaryToolSlugs?: string[];
    relatedToolSlugs?: string[];
    knownPitfalls?: string[];
    executionGuidance?: string;
  }[];
  toolSchemas?: Record<
    string,
    { toolSlug?: string; toolkit?: string; description?: string; inputSchema?: unknown }
  >;
  toolkitConnectionStatuses?: {
    toolkit?: string;
    hasActiveConnection?: boolean;
    statusMessage?: string;
  }[];
  nextStepsGuidance?: string[];
}

async function session(): Promise<{
  toolkits: (options?: {
    search?: string;
    isConnected?: boolean;
    cursor?: string;
    limit?: number;
  }) => Promise<ToolkitPage>;
  search: (params: { query: string; toolkits?: string[] }) => Promise<SearchAnswer>;
  execute: (
    slug: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data?: Record<string, unknown>; error?: string | null }>;
  authorize: (toolkit: string) => Promise<{ redirectUrl?: string | null }>;
} | null> {
  const key = apiKey();
  if (key === '') return null;

  const { Composio } = await import('@composio/core');
  const composio = new Composio({ apiKey: key });
  return (await composio.create(read().userId)) as never;
}

/**
 * Turns Composio's search answer into tools.
 *
 * This is the part that was wrong, and wrong in the quietest possible way. The
 * first version looked for an array, or `.items`, or `.tools` — none of which
 * Composio returns. It found nothing every single time and reported an empty
 * list, which reads exactly like "no tool matches your query". Every unit test
 * passed, because they were written against the same guess as the code.
 *
 * What actually comes back is a plan per use case: `results[].primaryToolSlugs`
 * naming the tools, `toolSchemas` keyed by slug holding their arguments, and
 * `toolkitConnectionStatuses` saying which apps are signed into. Verified
 * against the live API on 2026-08-25.
 */
function readSearch(answer: SearchAnswer): ComposioSearchResult {
  const schemas = answer.toolSchemas ?? {};

  // Primary slugs first and in order, then related ones — the plan's own
  // ranking, which is more use than anything this end could work out. A slug
  // with no schema is dropped: an agent cannot call what it has no arguments
  // for, and a name on its own invites a guess.
  const slugs: string[] = [];
  for (const result of answer.results ?? []) {
    for (const slug of [...(result.primaryToolSlugs ?? []), ...(result.relatedToolSlugs ?? [])]) {
      if (!slugs.includes(slug) && schemas[slug] !== undefined) slugs.push(slug);
    }
  }

  const tools = slugs.map((slug): ComposioTool => {
    const schema = schemas[slug] ?? {};
    return {
      slug: schema.toolSlug ?? slug,
      toolkit: schema.toolkit ?? '',
      description: schema.description ?? '',
      inputSchema: schema.inputSchema ?? {},
    };
  });

  const toolkits = (answer.toolkitConnectionStatuses ?? []).map((status) => ({
    toolkit: status.toolkit ?? '',
    connected: status.hasActiveConnection === true,
    note: status.statusMessage ?? '',
  }));

  const pitfalls = (answer.results ?? []).flatMap((result) => result.knownPitfalls ?? []);
  const guidance = [
    ...(answer.nextStepsGuidance ?? []),
    ...(answer.results ?? [])
      .map((result) => result.executionGuidance ?? '')
      .filter((line) => line !== ''),
  ];

  return { tools, toolkits, guidance, pitfalls };
}

/** The backend the tool server runs on. Absent key means every call says so. */
export function composioBackend(): ComposioBackend {
  const offline = 'Composio is not connected in this workspace — add its key in Providers.';

  return {
    async toolkits(input): Promise<ComposioToolkit[]> {
      const live = await session();
      if (live === null) throw new Error(offline);

      // Composio serves these a page at a time — 50 at most, and there were 28
      // pages of them the day this was written. The first version took the
      // default page and returned it, so the panel showed twenty apps out of
      // roughly fourteen hundred and gave no sign that it was a first page.
      //
      // Paging through all of them is 28 round trips for a list nobody reads
      // end to end, so a search is passed to the server instead and the paging
      // here is bounded. Unfiltered, this is "the first few hundred", and the
      // panel says so rather than implying it is everything.
      const collected: ComposioToolkit[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < MAX_TOOLKIT_PAGES; page += 1) {
        const answer = await live.toolkits({
          limit: TOOLKIT_PAGE_SIZE,
          ...(input?.search === undefined || input.search === '' ? {} : { search: input.search }),
          ...(input?.connectedOnly === true ? { isConnected: true } : {}),
          ...(cursor === undefined ? {} : { cursor }),
        });

        for (const item of answer.items) {
          collected.push({
            name: item.name,
            slug: item.slug,
            isNoAuth: item.isNoAuth,
            connected: item.connection?.isActive === true,
          });
        }

        const next = answer.cursor;
        if (next === null || next === undefined || next === '' || answer.items.length === 0) break;
        cursor = next;
      }

      return collected;
    },

    async search(input): Promise<ComposioSearchResult> {
      const live = await session();
      if (live === null) throw new Error(offline);
      return readSearch(await live.search(input));
    },

    async execute(input): Promise<{ ok: boolean; output: string }> {
      const live = await session();
      if (live === null) throw new Error(offline);

      // `{ data, error, logId }` — there is no `successful` flag, whatever the
      // first version of this checked for. A failure usually arrives as a
      // thrown BadRequestError rather than as a populated `error`, and those
      // carry the useful part (which app is not connected, what to do about
      // it), so they are left to propagate to the server's own handler.
      const answer = await live.execute(input.slug, input.arguments);

      const failed = answer.error !== null && answer.error !== undefined && answer.error !== '';
      return failed
        ? { ok: false, output: answer.error ?? 'The tool reported a failure.' }
        : { ok: true, output: JSON.stringify(answer.data ?? {}, null, 2) };
    },
  };
}

/**
 * Starts connecting an app, and hands back the page the user has to visit.
 *
 * Composio runs the OAuth dance; CHIMERA's part is to open the browser and to
 * be honest that the connection is not made until the user finishes there.
 */
export async function connectToolkit(input: {
  toolkit: string;
}): Promise<{ url: string; reason: string }> {
  const live = await session();
  if (live === null) {
    return { url: '', reason: 'Composio is not connected in this workspace.' };
  }
  try {
    const request = await live.authorize(input.toolkit);
    const url = request.redirectUrl ?? '';
    return url === ''
      ? { url: '', reason: 'That app needs no sign-in — it is ready to use.' }
      : { url, reason: '' };
  } catch (err) {
    return { url: '', reason: err instanceof Error ? err.message : String(err) };
  }
}

/** What the Providers panel lists. Empty when Composio is off or unreachable. */
/** The tools that fit a job. Empty with a reason when Composio is unreachable. */
export async function searchTools(input: {
  query: string;
  toolkits?: string[];
}): Promise<ComposioSearchResult & { reason: string }> {
  try {
    return { ...(await composioBackend().search(input)), reason: '' };
  } catch (err) {
    return {
      tools: [],
      toolkits: [],
      guidance: [],
      pitfalls: [],
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function listToolkits(input?: {
  search?: string;
  connectedOnly?: boolean;
}): Promise<{ toolkits: ComposioToolkit[]; reason: string }> {
  try {
    return { toolkits: await composioBackend().toolkits(input), reason: '' };
  } catch (err) {
    return { toolkits: [], reason: err instanceof Error ? err.message : String(err) };
  }
}
