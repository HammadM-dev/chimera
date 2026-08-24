import { getSecret, setSecret, deleteSecret, settingsRepository, type AuthRef } from '@chimera/store';
import type { ComposioBackend, ComposioTool, ComposioToolkit } from '@chimera/tools';
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

export function setComposio(input: {
  enabled: boolean;
  apiKey?: string;
}): { enabled: boolean; hasKey: boolean; userId: string } {
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
async function session(): Promise<{
  toolkits: () => Promise<{ items: { name: string; slug: string; isNoAuth: boolean; connection?: { isActive: boolean } | undefined }[] }>;
  search: (params: { query: string; toolkits?: string[] }) => Promise<unknown>;
  execute: (slug: string, args?: Record<string, unknown>) => Promise<unknown>;
  authorize: (toolkit: string) => Promise<{ redirectUrl?: string | null }>;
} | null> {
  const key = apiKey();
  if (key === '') return null;

  const { Composio } = await import('@composio/core');
  const composio = new Composio({ apiKey: key });
  return (await composio.create(read().userId)) as never;
}

function asTools(value: unknown): ComposioTool[] {
  const items = Array.isArray(value)
    ? value
    : Array.isArray((value as { items?: unknown[] } | null)?.items)
      ? ((value as { items: unknown[] }).items ?? [])
      : Array.isArray((value as { tools?: unknown[] } | null)?.tools)
        ? ((value as { tools: unknown[] }).tools ?? [])
        : [];

  return items.map((item): ComposioTool => {
    const record = (item ?? {}) as Record<string, unknown>;
    return {
      slug: typeof record['slug'] === 'string' ? record['slug'] : String(record['name'] ?? ''),
      description: typeof record['description'] === 'string' ? record['description'] : '',
      inputParameters: record['inputParameters'] ?? record['input_parameters'] ?? {},
    };
  });
}

/** The backend the tool server runs on. Absent key means every call says so. */
export function composioBackend(): ComposioBackend {
  const offline = 'Composio is not connected in this workspace — add its key in Providers.';

  return {
    async toolkits(): Promise<ComposioToolkit[]> {
      const live = await session();
      if (live === null) throw new Error(offline);
      const answer = await live.toolkits();
      return answer.items.map((item) => ({
        name: item.name,
        slug: item.slug,
        isNoAuth: item.isNoAuth,
        connected: item.connection?.isActive === true,
      }));
    },

    async search(input): Promise<ComposioTool[]> {
      const live = await session();
      if (live === null) throw new Error(offline);
      return asTools(await live.search(input));
    },

    async execute(input): Promise<{ ok: boolean; output: string }> {
      const live = await session();
      if (live === null) throw new Error(offline);

      const answer = (await live.execute(input.slug, input.arguments)) as {
        successful?: boolean;
        error?: unknown;
        data?: unknown;
      };

      const ok = answer.successful !== false && answer.error == null;
      return {
        ok,
        output: ok
          ? JSON.stringify(answer.data ?? answer, null, 2)
          : String(answer.error ?? 'The tool reported a failure.'),
      };
    },
  };
}

/**
 * Starts connecting an app, and hands back the page the user has to visit.
 *
 * Composio runs the OAuth dance; CHIMERA's part is to open the browser and to
 * be honest that the connection is not made until the user finishes there.
 */
export async function connectToolkit(input: { toolkit: string }): Promise<{ url: string; reason: string }> {
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
export async function listToolkits(): Promise<{ toolkits: ComposioToolkit[]; reason: string }> {
  try {
    return { toolkits: await composioBackend().toolkits(), reason: '' };
  } catch (err) {
    return { toolkits: [], reason: err instanceof Error ? err.message : String(err) };
  }
}
