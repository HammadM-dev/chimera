import { pluginsRepository, setSecret, getSecret, type PluginRecord } from '@chimera/store';
import {
  connectHttp,
  connectStdio,
  isIrreversible,
  type McpToolClient,
  type ToolRegistry,
} from '@chimera/tools';
import { getStore } from '../store/lifecycle.ts';

// Plugins: MCP servers the user added, and the tools they bring.
//
// This is the same protocol CHIMERA's own servers speak, which is the whole
// reason it exists — the community already ships servers for email, calendars,
// issue trackers, databases and the rest, and a user reaching one of those does
// not need CHIMERA to have written an integration for it.
//
// Nothing about the Governor changes. A plugin's tools are tools: subject to
// the role allowlist, the egress rules and the irreversible-action gate — and
// because they come from a server this build has never seen, they count as
// irreversible unless the step has been authorised.

export interface PluginSummary {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  tools: { name: string; description: string }[];
  lastError: string;
  command: string;
  url: string;
}

function summarise(record: PluginRecord): PluginSummary {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    enabled: record.enabled,
    tools: record.tools,
    lastError: record.lastError,
    command: record.command,
    url: record.url,
  };
}

export function listPlugins(): { plugins: PluginSummary[] } {
  return { plugins: pluginsRepository.list(getStore()).map(summarise) };
}

export interface SavePluginRequest {
  id?: string;
  name: string;
  kind: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  enabled: boolean;
  /** Names to *values*. Values go to the vault; only handles are stored. */
  secrets: Record<string, string>;
  headers: Record<string, string>;
}

export function savePlugin(input: SavePluginRequest): { id: string } {
  const db = getStore();
  const existing = input.id === undefined ? undefined : pluginsRepository.get(db, input.id);

  // A secret typed into the form goes to the keychain here and nowhere else.
  // What the row keeps is a handle — CLAUDE.md: secrets never land in SQLite,
  // not for connections and not for plugins either.
  const env: Record<string, string> = { ...(existing?.env ?? {}) };
  for (const [name, value] of Object.entries(input.secrets)) {
    if (value === '') continue;
    env[name] = setSecret('plugin', value);
  }

  const saved = pluginsRepository.save(db, {
    ...(input.id === undefined ? {} : { id: input.id }),
    name: input.name,
    kind: input.kind,
    command: input.command,
    args: input.args,
    url: input.url,
    env,
    headers: input.headers,
    enabled: input.enabled,
  });

  return { id: saved.id };
}

export function removePlugin(id: string): { removed: boolean } {
  pluginsRepository.remove(getStore(), id);
  return { removed: true };
}

/**
 * Resolves a plugin's secret handles into the environment it actually gets.
 *
 * A variable whose secret cannot be read is left out — a plugin receiving the
 * literal string "vault:plugin:…" would send it somewhere as if it were a key.
 * But the failure is *reported*, not swallowed: silently dropping a key leaves
 * a plugin that connects, lists its tools, and then does nothing when called,
 * which is the hardest kind of broken to diagnose from the outside.
 */
function environmentFor(record: PluginRecord): {
  env: Record<string, string>;
  missing: string[];
} {
  const env: Record<string, string> = {};
  const missing: string[] = [];

  for (const [name, handle] of Object.entries(record.env)) {
    try {
      const value = handle.startsWith('vault:') ? getSecret(handle as never) : handle;
      if (value !== undefined && value !== '') {
        env[name] = value;
      } else {
        missing.push(name);
      }
    } catch {
      missing.push(name);
    }
  }

  return { env, missing };
}

/**
 * Every plugin credential this workspace holds, in plaintext.
 *
 * Handed to the tool registry so it can take these values back out of whatever
 * a plugin returns. This is the one place in the app that assembles such a
 * list, it is never persisted, never logged, and never crosses the preload
 * bridge — it exists for the length of a redaction pass and no longer.
 *
 * HTTP plugins' header values count too: an `Authorization: Bearer …` is the
 * same secret by a different route.
 */
export function pluginSecrets(): string[] {
  const values: string[] = [];
  for (const record of pluginsRepository.list(getStore())) {
    const handles =
      record.kind === 'http' ? Object.values(record.headers) : Object.values(record.env);
    for (const handle of handles) {
      try {
        const value = handle.startsWith('vault:') ? getSecret(handle as never) : handle;
        if (value !== undefined && value !== '') values.push(value);
      } catch {
        // A credential that cannot be read cannot leak through a tool result
        // either. The missing-key report in `environmentFor` is where that is
        // surfaced to the user; here it is simply nothing to redact.
      }
    }
  }
  return values;
}

async function connect(
  record: PluginRecord,
): Promise<{ client: McpToolClient; missing: string[] }> {
  if (record.kind === 'http') {
    return {
      client: await connectHttp({ url: record.url, headers: record.headers }),
      missing: [],
    };
  }

  const { env, missing } = environmentFor(record);
  const client = await connectStdio({ command: record.command, args: record.args, env });
  return { client, missing };
}

/**
 * The server id a plugin's tools are prefixed with.
 *
 * Derived from the name so a grant reads `gmail.send` rather than
 * `plugin-9f2c.send`.
 */
export function serverIdFor(record: { id: string; name: string }): string {
  const slug = record.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? `plugin-${record.id.slice(0, 6)}` : slug;
}

/**
 * Registers every enabled plugin into a run's tool registry.
 *
 * Failures are recorded and skipped, never thrown. A plugin whose command was
 * uninstalled last week must not stop an automation that does not use it, and
 * the reason belongs on the plugin's own row where the user can read it.
 */
export async function registerPlugins(tools: ToolRegistry): Promise<{ registered: string[] }> {
  const db = getStore();
  const registered: string[] = [];

  for (const record of pluginsRepository.list(db)) {
    if (!record.enabled) continue;
    try {
      const { client, missing } = await connect(record);
      const ids = await tools.registerServer(serverIdFor(record), client);
      const advertised = await client.listTools();
      pluginsRepository.recordConnection(db, record.id, {
        tools: advertised.map((tool) => ({ name: tool.name, description: tool.description })),
        error:
          missing.length === 0
            ? ''
            : `Started without ${missing.join(', ')} — the key could not be read from the keychain.`,
      });
      registered.push(...ids);
    } catch (err) {
      pluginsRepository.recordConnection(db, record.id, {
        tools: record.tools,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { registered };
}

/** Tries a plugin now and says what happened, for the button in the UI. */
export async function testPlugin(
  id: string,
): Promise<{ ok: boolean; detail: string; tools: number }> {
  const db = getStore();
  const record = pluginsRepository.get(db, id);
  if (!record) return { ok: false, detail: 'That plugin is not here any more.', tools: 0 };

  try {
    const { client, missing } = await connect(record);
    const tools = await client.listTools();
    const error =
      missing.length === 0
        ? ''
        : `Started without ${missing.join(', ')} — the key could not be read from the keychain.`;
    pluginsRepository.recordConnection(db, id, {
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
      error,
    });
    await client.close();
    return { ok: error === '', detail: error, tools: tools.length };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    pluginsRepository.recordConnection(db, id, { tools: record.tools, error: detail });
    return { ok: false, detail, tools: 0 };
  }
}

const BUILT_IN_TOOLS = [
  { id: 'filesystem.readFile', description: 'Reads a file inside the run sandbox.' },
  { id: 'filesystem.writeFile', description: 'Writes a file inside the run sandbox.' },
  { id: 'filesystem.listDirectory', description: 'Lists a directory inside the sandbox.' },
  { id: 'filesystem.makeDirectory', description: 'Creates a directory inside the sandbox.' },
  { id: 'shell.exec', description: 'Runs a command inside the sandbox.' },
  { id: 'http.request', description: 'Makes an HTTP request to an allowed host.' },
  { id: 'memory.remember', description: 'Records something worth knowing next time.' },
  { id: 'memory.recall', description: 'Looks up what is already known.' },
  { id: 'browser.navigate', description: 'Opens a page in the browser.' },
  { id: 'browser.read', description: 'Reads the text of a page.' },
  { id: 'browser.click', description: 'Clicks something on a page.' },
  { id: 'browser.type', description: 'Types into a field on a page.' },
  {
    id: 'browser.extract',
    description: 'Pulls out every element matching a selector, and the fields you name from each.',
  },
  {
    id: 'browser.html',
    description: 'Reads the markup of a page, for when the answer is in an attribute.',
  },
  { id: 'browser.screenshot', description: 'Takes a picture of the page.' },
  {
    id: 'search.web',
    description: 'Searches the web and returns titles, links and snippets to fetch.',
  },
  // This workspace, readable. Granted to the Assistant by default and offered
  // to any agent: there is no reason somebody should not build one that reads
  // their own run history, and every one of these is a read.
  { id: 'workspace.automations', description: 'Lists the automations saved here.' },
  { id: 'workspace.agents', description: 'Lists the agents here and what each may use.' },
  { id: 'workspace.runs', description: 'Lists recent runs, with what each one cost.' },
  { id: 'workspace.run', description: 'One run in full, including what failed.' },
  { id: 'workspace.notes', description: 'Searches what this workspace has remembered.' },
  { id: 'workspace.plugins', description: 'Lists connected plugins and their tools.' },
  { id: 'workspace.providers', description: 'Lists model providers and their models. Never keys.' },
  { id: 'workspace.templates', description: 'Lists the automations CHIMERA ships.' },
  { id: 'workspace.folders', description: 'Lists folders this workspace may read.' },
  { id: 'composio.toolkits', description: 'Lists the apps reachable through Composio.' },
  {
    id: 'composio.search',
    description: 'Finds Composio tools for a job described in plain words.',
  },
  {
    id: 'composio.execute',
    description: 'Runs one Composio tool for real. Needs an approval step before it.',
  },
  {
    id: 'workspace.planAutomation',
    description: 'Designs an automation from a description. Designs only — applies nothing.',
  },
  {
    id: 'notebook.list',
    description: 'Reads the notes and reminders on this workspace’s board.',
  },
  {
    id: 'notebook.add',
    description: 'Leaves a note or a reminder where the person will see it.',
  },
  {
    id: 'notebook.update',
    description: 'Changes something on the notes board, or ticks it off.',
  },
];

/**
 * Every tool an agent could be granted: CHIMERA's own, plus every plugin's.
 *
 * Read from what each plugin advertised last time it connected rather than by
 * starting all of them — an agent editor that spawned six processes to draw a
 * checklist would be unusable.
 */
/** The ids the editor offers, so a test can hold this list against the one the build ships. */
export const BUILT_IN_TOOL_IDS: readonly string[] = BUILT_IN_TOOLS.map((tool) => tool.id);

export function listTools(): {
  tools: { id: string; serverId: string; description: string; irreversible: boolean }[];
} {
  const builtin = BUILT_IN_TOOLS.map((tool) => ({
    ...tool,
    serverId: tool.id.split('.')[0] ?? '',
    irreversible: isIrreversible(tool.id),
  }));

  const fromPlugins = pluginsRepository.list(getStore()).flatMap((record) =>
    record.tools.map((tool) => {
      const id = `${serverIdFor(record)}.${tool.name}`;
      return {
        id,
        serverId: serverIdFor(record),
        description: tool.description,
        // A server this build has never seen: irreversible until a person says
        // otherwise, which is what `isIrreversible` already answers for it.
        irreversible: isIrreversible(id),
      };
    }),
  );

  return { tools: [...builtin, ...fromPlugins] };
}
