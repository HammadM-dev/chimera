import { ToolError, redact } from '@chimera/errors';
import { assertToolAllowed, type AllowlistedRole } from './allowlist.ts';
import type { McpToolClient, McpToolResult, ToolDescriptor } from './mcpClient.ts';

// The single entry point for every tool invocation in CHIMERA. Nothing calls an
// MCP server directly — the runtime holds a registry, not a client.
//
// Note what this file does *not* take: a prompt, a message history, or the
// model's stated intent. Dispatch is decided by the tool id and the calling
// role, both of which are set by the workflow rather than by anything the model
// or a tool result said.

/** A tool as the registry knows it: server-qualified, with its server's client. */
export interface RegisteredTool {
  /** `filesystem.readFile` — server id, dot, the server's own tool name. */
  id: string;
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface InvocationContext {
  role: AllowlistedRole;
}

export interface ToolRegistry {
  /** Registers every tool a connected server advertises. Returns their qualified ids. */
  registerServer: (serverId: string, client: McpToolClient) => Promise<string[]>;
  list: () => RegisteredTool[];
  /** Tools this role may actually call — what the prompt assembler advertises to the model. */
  listFor: (role: AllowlistedRole) => RegisteredTool[];
  invoke: (
    toolId: string,
    params: Record<string, unknown>,
    context: InvocationContext,
  ) => Promise<McpToolResult>;
  close: () => Promise<void>;
}

export interface ToolRegistryOptions {
  /**
   * Secret values to remove from every tool result, resolved at call time.
   *
   * A function rather than an array because plugins are registered after the
   * registry is built: a snapshot taken at construction would miss every
   * plugin added afterwards, which is all of them.
   *
   * A plugin's credential is put into that plugin's environment by the layer
   * above, and plenty of real MCP servers echo their configuration back in a
   * result or an error. Whatever comes back is written to the run trace and
   * sent to the model on the next turn, so without this a server saying
   * "signed in with sk-live-..." puts that key into SQLite and then into a
   * provider's request. Proved by a test that made a server do exactly that.
   */
  secrets?: () => readonly string[];
}

export function createToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  const tools = new Map<string, RegisteredTool>();
  const clients = new Map<string, McpToolClient>();

  const qualify = (serverId: string, tool: ToolDescriptor): RegisteredTool => ({
    id: `${serverId}.${tool.name}`,
    serverId,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });

  return {
    async registerServer(serverId, client) {
      if (clients.has(serverId)) {
        throw new ToolError(
          'TOOL_SERVER_ALREADY_REGISTERED',
          `A server is already registered as "${serverId}".`,
          { serverId },
        );
      }
      clients.set(serverId, client);
      const descriptors = await client.listTools();
      const ids: string[] = [];
      for (const descriptor of descriptors) {
        const tool = qualify(serverId, descriptor);
        tools.set(tool.id, tool);
        ids.push(tool.id);
      }
      return ids;
    },

    list: () => [...tools.values()],

    listFor: (role) =>
      [...tools.values()].filter((tool) =>
        role.toolAllowlist.some((entry) => entry === tool.id || entry === `${tool.serverId}.*`),
      ),

    async invoke(toolId, params, context) {
      // Allowlist first, before the tool is even looked up. Checking existence
      // first would answer "does this tool exist" for a role that is not
      // allowed to know, and — more importantly — the order is what makes
      // "zero underlying calls" testable rather than merely intended.
      assertToolAllowed(toolId, context.role);

      const tool = tools.get(toolId);
      if (!tool) {
        throw new ToolError('TOOL_NOT_FOUND', `No tool registered as "${toolId}".`, { toolId });
      }
      const client = clients.get(tool.serverId);
      if (!client) {
        throw new ToolError(
          'TOOL_SERVER_UNAVAILABLE',
          `The server "${tool.serverId}" hosting "${toolId}" is not connected.`,
          { toolId, serverId: tool.serverId },
        );
      }

      const result = await client.callTool(tool.name, params);

      // The one place every tool result passes through, so a caller cannot
      // forget: the loop, the trace and the next prompt all read what this
      // returns.
      const secrets = options.secrets?.() ?? [];
      if (secrets.length === 0) return result;
      return { ...result, text: redact(result.text, secrets) };
    },

    async close() {
      await Promise.all([...clients.values()].map((client) => client.close()));
      clients.clear();
      tools.clear();
    },
  };
}
