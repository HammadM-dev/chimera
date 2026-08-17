// packages/tools — MCP client, internal MCP servers (filesystem, shell, http, browser).
// Populated starting M2. See docs/ARCHITECTURE.md and docs/MASTER_PLAN.md F2.3.
export { connectInProcess } from './mcpClient.ts';
export type { McpToolClient, McpToolResult, ToolDescriptor } from './mcpClient.ts';
export { createToolRegistry } from './toolRegistry.ts';
export type { InvocationContext, RegisteredTool, ToolRegistry } from './toolRegistry.ts';
export { assertToolAllowed, isToolAllowed } from './allowlist.ts';
export { isIrreversible, alwaysIrreversibleTools } from './reversibility.ts';
export type { AllowlistedRole } from './allowlist.ts';
export { createSandbox, destroySandbox } from './sandbox.ts';
export type { Sandbox } from './sandbox.ts';
export { createFilesystemServer } from './servers/filesystem.ts';
export { createShellServer, runInSandbox } from './servers/shell.ts';
export { createBrowserServer } from './servers/browser.ts';
export type { BrowserPage, BrowserServerOptions } from './servers/browser.ts';
export type { ShellResult } from './servers/shell.ts';
export { createHttpServer, assertEgressAllowed, isHostAllowed } from './servers/http.ts';
export type { HttpServerOptions, HttpTransport } from './servers/http.ts';
export { createMemoryServer } from './servers/memory.ts';
export type { MemoryBackend } from './servers/memory.ts';
