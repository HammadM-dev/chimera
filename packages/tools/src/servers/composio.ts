import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Composio, as tools an agent can use.
//
// Composio is thousands of actions across hundreds of apps — Gmail, Slack,
// Notion, Jira, HubSpot, Stripe — behind one account and one auth layer. What
// makes it usable by an agent is that it is *searched* rather than listed: no
// prompt holds ten thousand tool schemas, so the agent describes the job and
// gets back the handful that fit.
//
// Three tools, and the split between them is the whole safety story. `toolkits`
// and `search` are reads. `execute` is the one that does something, it is
// classified irreversible, and it therefore needs an approval node in front of
// it like anything else that sends, posts, buys or deletes. That is not
// pessimism about Composio — it is that a tool called `GMAIL_SEND_EMAIL` is
// exactly what the gate exists for, and this build cannot tell which of ten
// thousand slugs are the safe ones.
//
// The backend is injected, the way `createMemoryServer` and
// `createWorkspaceServer` take theirs, so this file holds no SDK and can be
// tested against a stand-in.

export interface ComposioToolkit {
  name: string;
  slug: string;
  /** True when the app needs no login at all. */
  isNoAuth: boolean;
  connected: boolean;
}

export interface ComposioTool {
  slug: string;
  description: string;
  /** JSON Schema for the arguments, as Composio gives it. */
  inputParameters: unknown;
}

export interface ComposioBackend {
  toolkits: () => Promise<ComposioToolkit[]>;
  search: (input: { query: string; toolkits?: string[] }) => Promise<ComposioTool[]>;
  execute: (input: {
    slug: string;
    arguments: Record<string, unknown>;
  }) => Promise<{ ok: boolean; output: string }>;
}

function text(value: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function failure(message: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createComposioServer(backend: ComposioBackend): McpServer {
  const server = new McpServer({ name: 'chimera-composio', version: '0.0.0' });

  server.registerTool(
    'toolkits',
    {
      description:
        'Lists the apps reachable through Composio and says which are already connected. Check this before assuming you can reach somebody’s Gmail or Slack — an app that is not connected cannot be used, and saying so is more useful than trying and failing.',
      inputSchema: {},
    },
    async () => {
      try {
        return text(await backend.toolkits());
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'search',
    {
      description:
        'Finds the Composio tools that fit a job, described in plain words — "add a row to a Google Sheet", "find recent messages in a Slack channel". Use this rather than guessing a tool name: there are thousands, and their names are not guessable. Returns each tool’s slug and what arguments it takes.',
      inputSchema: {
        query: z.string().describe('What you are trying to do, in plain words.'),
        toolkits: z
          .array(z.string())
          .optional()
          .describe('Narrow it to these apps, by slug, when you already know which.'),
      },
    },
    async ({ query, toolkits }) => {
      if (query.trim() === '') return failure('A search needs something to look for.');
      try {
        const found = await backend.search({
          query,
          ...(toolkits === undefined ? {} : { toolkits }),
        });
        return found.length === 0
          ? text(
              'Nothing matched. Try describing the job differently, or check with `toolkits` that the app is connected.',
            )
          : text(found);
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'execute',
    {
      description:
        'Runs one Composio tool, by the slug `search` gave you, with the arguments its schema asks for. This does the thing for real — it sends the email, creates the issue, posts the message. Get the slug and the argument names from `search` rather than inventing them.',
      inputSchema: {
        slug: z.string().describe('The tool slug, exactly as `search` returned it.'),
        arguments: z
          .record(z.string(), z.unknown())
          .default({})
          .describe('The arguments, matching the schema `search` returned.'),
      },
    },
    async ({ slug, arguments: args }) => {
      if (slug.trim() === '') return failure('Which tool? Use `search` to find its slug.');
      try {
        const result = await backend.execute({ slug, arguments: args ?? {} });
        return result.ok ? text(result.output) : failure(result.output);
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}
