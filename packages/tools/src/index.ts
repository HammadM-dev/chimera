// packages/tools — MCP client, internal MCP servers (filesystem, shell, http, browser).
// Populated starting M2. See docs/ARCHITECTURE.md and docs/MASTER_PLAN.md F2.3.
export { connectInProcess, connectStdio, connectHttp } from './mcpClient.ts';
export type { McpToolClient, McpToolResult, ToolDescriptor } from './mcpClient.ts';
export { createToolRegistry } from './toolRegistry.ts';
export type { InvocationContext, RegisteredTool, ToolRegistry } from './toolRegistry.ts';
export { assertToolAllowed, isToolAllowed } from './allowlist.ts';
export { isIrreversible, alwaysIrreversibleTools } from './reversibility.ts';
export type { AllowlistedRole } from './allowlist.ts';
export { createSandbox, destroySandbox, sweepSandboxes } from './sandbox.ts';
export type { Sandbox } from './sandbox.ts';
export { createFilesystemServer, DEFAULT_MAX_READ_BYTES } from './servers/filesystem.ts';
export type { FilesystemServerOptions } from './servers/filesystem.ts';
export { createShellServer, runInSandbox } from './servers/shell.ts';
export { createBrowserServer } from './servers/browser.ts';
export { createEmailServer } from './servers/email.ts';
export type { MailTransport, MailSummary, MailMessage, SendRequest } from './servers/email.ts';
export type { BrowserPage, BrowserServerOptions } from './servers/browser.ts';
export type { ShellResult } from './servers/shell.ts';
export {
  createHttpServer,
  assertEgressAllowed,
  isHostAllowed,
  isPrivateHost,
  DEFAULT_MAX_PAGE_CHARS,
} from './servers/http.ts';
export type { EgressMode } from './servers/http.ts';
export { KNOWN as KNOWN_TOOL_IDS } from './reversibility.ts';
export { createSearchServer, unwrapBing, DEFAULT_MAX_RESULTS } from './servers/search.ts';
export type { SearchServerOptions, SearchResult } from './servers/search.ts';
export { htmlToText } from './html.ts';
export type { HttpServerOptions, HttpTransport } from './servers/http.ts';
export { createMemoryServer } from './servers/memory.ts';
export type { MemoryBackend } from './servers/memory.ts';
