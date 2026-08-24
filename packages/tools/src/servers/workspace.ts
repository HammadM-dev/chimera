import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Everything this workspace holds, readable by the assistant on the home screen.
//
// The home screen could design an automation and knew nothing else: ask it what
// your invoice run cost last week, or which agents can send email, or what it
// learned yesterday, and it had no way to find out. Nothing was missing from
// the database — the assistant simply had no door into it.
//
// Read-only, all of it. This server has no tool that writes, deletes, renames
// or runs anything, and that is a property of the file rather than a promise:
// the one thing that changes state is `planAutomation`, which returns a design
// and applies nothing. An assistant that could edit the workspace while
// discussing it would need a confirmation on every turn, and an assistant you
// have to supervise is one you would rather do without.
//
// The backend is injected, the way `createMemoryServer` takes one, so this file
// holds no SQL and can be tested against a stand-in. `apps/desktop` supplies the
// real one.

export interface WorkspaceAutomation {
  id: string;
  name: string;
  updatedAt: string;
  /** How it is built: the steps in order, and what each is told to do. */
  steps: { nodeId: string; kind: string; agent: string; instruction: string }[];
  trigger: string;
}

export interface WorkspaceAgent {
  id: string;
  name: string;
  systemPrompt: string;
  tools: string[];
  maxIterations: number;
  isBuiltin: boolean;
}

export interface WorkspaceRun {
  id: string;
  automation: string;
  status: string;
  startedAt: string;
  endedAt: string;
  costUsd: number;
  tokens: number;
  /** Empty unless it stopped. */
  error: string;
}

export interface WorkspaceRunDetail extends WorkspaceRun {
  output: string;
  steps: { nodeId: string; label: string; status: string; output: string }[];
  failures: string[];
}

export interface WorkspaceNote {
  kind: string;
  subject: string;
  body: string;
  source: string;
  updatedAt: string;
}

export interface WorkspaceBackend {
  automations: () => WorkspaceAutomation[];
  agents: () => WorkspaceAgent[];
  runs: (limit: number) => WorkspaceRun[];
  run: (runId: string) => WorkspaceRunDetail | null;
  notes: (query: string, limit: number) => WorkspaceNote[];
  plugins: () => { name: string; kind: string; enabled: boolean; tools: string[] }[];
  providers: () => { label: string; kind: string; models: string[]; health: string }[];
  templates: () => { id: string; name: string; audience: string; summary: string }[];
  folders: () => string[];
  /**
   * Designs an automation from a description, exactly as the home screen's
   * "Design it for me" does.
   *
   * The whole point of keeping it: the assistant gained a workspace and must
   * not have lost the one thing it could already do.
   */
  planAutomation: (
    description: string,
  ) => Promise<{ name: string; summary: string; steps: unknown }>;
}

function text(value: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

export function createWorkspaceServer(backend: WorkspaceBackend): McpServer {
  const server = new McpServer({ name: 'chimera-workspace', version: '0.0.0' });

  server.registerTool(
    'automations',
    {
      description:
        'Lists every automation saved in this workspace, with the steps each one is built from and what starts it. Use this before answering anything about what the user has built.',
      inputSchema: {},
    },
    () => text(backend.automations()),
  );

  server.registerTool(
    'agents',
    {
      description:
        'Lists every agent in this workspace — the shipped ones and any the user wrote — with its instructions, the tools it may use and its iteration limit.',
      inputSchema: {},
    },
    () => text(backend.agents()),
  );

  server.registerTool(
    'runs',
    {
      description:
        'Lists recent runs, newest first: which automation, whether it finished, how long it took and what it cost. Use this for anything about history, spend or reliability.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('How many. Default 25.'),
      },
    },
    ({ limit }) => text(backend.runs(limit ?? 25)),
  );

  server.registerTool(
    'run',
    {
      description:
        'One run in full: what it produced, what each step produced, and anything that failed. Use it after `runs` when the user asks why something went wrong.',
      inputSchema: { runId: z.string() },
    },
    ({ runId }) => {
      const found = backend.run(runId);
      return found === null
        ? {
            content: [{ type: 'text' as const, text: `There is no run with the id "${runId}".` }],
            isError: true as const,
          }
        : text(found);
    },
  );

  server.registerTool(
    'notes',
    {
      description:
        'Searches what this workspace has remembered: facts the user recorded and notes agents made during runs. Leave the query empty for the most recent.',
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    ({ query, limit }) => text(backend.notes(query ?? '', limit ?? 20)),
  );

  server.registerTool(
    'plugins',
    {
      description: 'Lists the plugins connected to this workspace and the tools each one adds.',
      inputSchema: {},
    },
    () => text(backend.plugins()),
  );

  server.registerTool(
    'providers',
    {
      description:
        'Lists the model providers connected here, which models each offers, and whether they are healthy. Never returns keys — there is nothing here that could.',
      inputSchema: {},
    },
    () => text(backend.providers()),
  );

  server.registerTool(
    'templates',
    {
      description: 'Lists the automations CHIMERA ships to start from, and who each is for.',
      inputSchema: {},
    },
    () => text(backend.templates()),
  );

  server.registerTool(
    'folders',
    {
      description:
        'Lists the folders the user has granted this workspace permission to read. An automation that needs a folder not on this list will be refused.',
      inputSchema: {},
    },
    () => text(backend.folders()),
  );

  server.registerTool(
    'planAutomation',
    {
      description:
        'Designs an automation from a description: which agents, in what order, each told what to do. Use this whenever the user asks for something to be built, automated or set up. It designs and applies nothing — the design is shown to the user to open on the canvas.',
      inputSchema: {
        description: z
          .string()
          .describe('What the automation should do, in the fullest terms you have.'),
      },
    },
    async ({ description }) => {
      try {
        return text(await backend.planAutomation(description));
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `The design could not be produced: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }
    },
  );

  return server;
}
