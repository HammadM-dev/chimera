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
import { openExternal } from '../security/openExternal.ts';

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

/** One entry of Composio's account-level catalogue. Verified live 2026-08-25. */
interface CatalogueToolkit {
  name?: string;
  slug?: string;
  noAuth?: boolean;
  authSchemes?: string[];
  meta?: {
    description?: string;
    logo?: string;
    appUrl?: string;
    toolsCount?: number;
    categories?: { slug?: string; name?: string }[];
  };
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
 * The whole directory, with what each app is and what it will ask for.
 *
 * A different endpoint from the session's `toolkits()`: that one knows which
 * apps this workspace has signed into and nothing else about them, while this
 * one carries the description, the logo, the categories and the auth scheme and
 * knows nothing about connections. The panel needs both, so both are read and
 * merged.
 *
 * One call, up to a thousand apps — the entire catalogue, which is what makes
 * searching and filtering here honest rather than a search of whatever page
 * happened to load.
 */
async function catalogue(): Promise<CatalogueToolkit[]> {
  const key = apiKey();
  if (key === '') return [];

  const { Composio } = await import('@composio/core');
  const composio = new Composio({ apiKey: key });
  // `get`, not `getToolkits`: the latter is the same call but marked private
  // in the SDK's types, and reaching past that would break on any release that
  // took the word seriously.
  const listed = (await composio.toolkits.get({ limit: 1000 })) as unknown;
  return Array.isArray(listed) ? (listed as CatalogueToolkit[]) : [];
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

      // Which apps this workspace has actually signed into. One page is
      // plenty: nobody connects fifty.
      const connected = new Set<string>();
      try {
        const signedIn = await live.toolkits({ limit: TOOLKIT_PAGE_SIZE, isConnected: true });
        for (const item of signedIn.items) {
          if (item.connection?.isActive === true) connected.add(item.slug);
        }
      } catch {
        // A directory with every app marked "not connected" is still worth
        // showing; each row's Connect button tells the truth either way.
      }

      const all = (await catalogue()).flatMap((entry): ComposioToolkit[] => {
        const slug = entry.slug ?? '';
        if (slug === '') return [];
        return [
          {
            name: entry.name ?? slug,
            slug,
            isNoAuth: entry.noAuth === true,
            connected: connected.has(slug),
            description: entry.meta?.description ?? '',
            logo: entry.meta?.logo ?? '',
            categories: (entry.meta?.categories ?? [])
              .map((category) => category.slug ?? '')
              .filter((category) => category !== ''),
            toolsCount: entry.meta?.toolsCount ?? 0,
            authSchemes: entry.authSchemes ?? [],
            appUrl: entry.meta?.appUrl ?? '',
          },
        ];
      });

      // Filtering happens here rather than at Composio's end, and that is
      // correct now for the reason it was wrong before: this is the whole
      // catalogue, not the first page of it. Their `search` parameter ranks
      // rather than filters — asking for "gmail" returned a thousand rows
      // beginning with Gmail — so using it would quietly show everything.
      const needle = (input?.search ?? '').trim().toLowerCase();
      const wanted = all.filter(
        (toolkit) =>
          (input?.connectedOnly !== true || toolkit.connected) &&
          (needle === '' ||
            toolkit.name.toLowerCase().includes(needle) ||
            toolkit.slug.includes(needle) ||
            toolkit.description.toLowerCase().includes(needle) ||
            toolkit.categories.some((category) => category.includes(needle))),
      );

      // Connected first, then the ones with the most to offer.
      wanted.sort(
        (a, b) =>
          Number(b.connected) - Number(a.connected) ||
          b.toolsCount - a.toolsCount ||
          a.name.localeCompare(b.name),
      );
      return wanted;
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
}): Promise<{ url: string; opened: boolean; reason: string }> {
  const live = await session();
  if (live === null) {
    return {
      url: '',
      opened: false,
      reason: 'Composio is not connected in this workspace — add its key first.',
    };
  }
  try {
    const request = await live.authorize(input.toolkit);
    const url = request.redirectUrl ?? '';
    if (url === '') {
      return { url: '', opened: false, reason: 'That app needs no sign-in — it is ready to use.' };
    }

    // Opened here rather than handed back for the renderer to open.
    //
    // This is the whole of the bug where Connect said "Opening" and nothing
    // happened. The renderer called `window.open`, which the navigation guard
    // denies for every origin but the app's own — correctly, and by design.
    // The browser has to be opened by the process that is allowed to open it.
    const opened = await openExternal(url);
    return { url, opened: opened.opened, reason: opened.reason };
  } catch (err) {
    return { url: '', opened: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** What the Providers panel lists. Empty when Composio is off or unreachable. */
/**
 * App logos, fetched here and handed to the renderer as data.
 *
 * The renderer has no network egress of its own — `connect-src 'self'` and
 * `img-src 'self' data: blob:` — which is deliberate and worth keeping: it is
 * the property that makes a compromised renderer unable to phone anywhere. So
 * an `<img src="https://logos.composio.dev/...">` simply does not load, and a
 * directory of a thousand apps with no logos is a directory of a thousand
 * identical grey rows.
 *
 * Cached for the life of the process. A logo is a few kilobytes and never
 * changes; refetching one per render of a scrolling list would be a request
 * storm for no benefit.
 */
const logos = new Map<string, string>();

/** Beyond this a "logo" is something else, and not something to inline. */
const MAX_LOGO_BYTES = 256 * 1024;

export async function toolkitLogo(input: {
  slug: string;
  url: string;
}): Promise<{ dataUri: string }> {
  const cached = logos.get(input.slug);
  if (cached !== undefined) return { dataUri: cached };

  // Only Composio's own logo host. This function takes a URL from a response
  // body, which is exactly the kind of value that must not be allowed to
  // address anything it likes — an attacker-controlled catalogue entry would
  // otherwise make the main process fetch a URL of its choosing.
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { dataUri: '' };
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'logos.composio.dev') {
    return { dataUri: '' };
  }

  try {
    const response = await fetch(parsed.toString(), { redirect: 'error' });
    if (!response.ok) return { dataUri: '' };

    const type = response.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return { dataUri: '' };

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_LOGO_BYTES) return { dataUri: '' };

    const dataUri = `data:${type.split(';')[0] ?? 'image/png'};base64,${bytes.toString('base64')}`;
    logos.set(input.slug, dataUri);
    return { dataUri };
  } catch {
    // A logo that will not load is a row without a picture, which is a normal
    // thing for a row to be.
    return { dataUri: '' };
  }
}

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
