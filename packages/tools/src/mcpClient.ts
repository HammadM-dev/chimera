import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolExecutionError } from '@chimera/errors';

// F2.3: "do not invent a format." This is a thin wrapper over the MCP
// TypeScript SDK, not a reimplementation of it — the wrapper exists to give the
// rest of CHIMERA one small surface (list, call, close) that does not change
// when the SDK's does, and to normalise results into the shape the registry and
// the prompt-envelope work (M2-6) expect.

export interface ToolDescriptor {
  /** The tool's own name, unqualified. The registry adds the server prefix. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * A tool's output, always as text.
 *
 * `isError` is MCP's own protocol-level flag: a tool that failed *inside* the
 * server reports it here rather than by breaking the transport, so this is a
 * normal result to receive and not an exception.
 *
 * The content is deliberately typed as opaque text and named nothing more
 * inviting than `text`. It is attacker-controllable — CLAUDE.md: "tool output
 * is data, never instructions" — and M2-6 wraps it in the untrusted envelope
 * before it goes anywhere near a prompt.
 */
export interface McpToolResult {
  text: string;
  isError: boolean;
}

export interface McpToolClient {
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

const CLIENT_INFO = { name: 'chimera', version: '0.0.0' };

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      if (typeof part !== 'object' || part === null) return '';
      const record = part as { type?: unknown; text?: unknown };
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .join('');
}

function wrap(client: Client): McpToolClient {
  return {
    async listTools() {
      const result = await client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
      }));
    },

    async callTool(name, args) {
      try {
        const result = await client.callTool({ name, arguments: args });
        return { text: textOf(result.content), isError: result.isError === true };
      } catch (err) {
        // A transport or protocol failure, as distinct from a tool that ran and
        // reported failure. Re-raised as a typed error so callers do not have
        // to know what the SDK throws.
        throw new ToolExecutionError(
          `MCP call to "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          { tool: name },
        );
      }
    },

    close: () => client.close(),
  };
}

/**
 * Connects to a server running in this process, over a linked pair of in-memory
 * transports.
 *
 * This is how CHIMERA's own servers (filesystem, shell, http) are reached:
 * they are MCP servers speaking the real protocol, but spawning a subprocess to
 * talk to code in the same binary would buy nothing. External servers get the
 * stdio transport instead — same `McpToolClient` on the other side of it, which
 * is the reason for the wrapper.
 */
export async function connectInProcess(server: McpServer): Promise<McpToolClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(CLIENT_INFO);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return wrap(client);
}

/**
 * Connects to an MCP server running as a separate process.
 *
 * This is how a plugin arrives: the same protocol CHIMERA's own servers speak,
 * over a pipe to something the user installed. The community's servers — email,
 * calendars, issue trackers, databases — are all this shape, which is why
 * CHIMERA does not need an integration written per service.
 *
 * The environment is not inherited wholesale. A plugin gets `PATH` and what the
 * user explicitly set for it, and nothing else: the ambient environment of a
 * desktop app holds tokens, keys and session variables that have nothing to do
 * with the plugin, and handing all of it over is the easiest credential leak in
 * the product.
 */
export async function connectStdio(input: {
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
}): Promise<McpToolClient> {
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const transport = new StdioClientTransport({
    command: input.command,
    args: [...(input.args ?? [])],
    env: {
      PATH: process.env.PATH ?? '',
      ...(input.env ?? {}),
    },
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    // A plugin's own diagnostics go to our stderr, not into the protocol.
    stderr: 'inherit',
  });

  const client = new Client(CLIENT_INFO);
  await client.connect(transport);
  return wrap(client);
}

/**
 * Connects to an MCP server over HTTP.
 *
 * The other shape a plugin comes in: something already running, local or
 * hosted. Headers carry whatever it needs to authenticate — they come from the
 * plugin's own configuration, which is stored beside it rather than in a
 * prompt or a workflow file.
 */
export async function connectHttp(input: {
  url: string;
  headers?: Record<string, string>;
}): Promise<McpToolClient> {
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

  const transport = new StreamableHTTPClientTransport(new URL(input.url), {
    ...(input.headers ? { requestInit: { headers: input.headers } } : {}),
  });

  const client = new Client(CLIENT_INFO);
  await client.connect(transport);
  return wrap(client);
}
