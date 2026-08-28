// packages/control — browser control (Playwright) and the sidecar bridge client.
// Browser control populated starting M6; sidecar bridge client scaffolded M0,
// wired to a real binary starting M8. See docs/ARCHITECTURE.md.
export { createBrowserProfileManager } from './browser/profileManager.ts';
export { ensureBrowser, browsersRoot, browserPresent } from './browser/ensureBrowser.ts';
export { createSidecarBridge } from './sidecar/bridge.ts';
export type { SidecarBridge, SidecarOptions } from './sidecar/bridge.ts';
export { parseLine, splitLines, encodeRequest, isEvent } from './sidecar/protocol.ts';
export type {
  SidecarCommand,
  SidecarCommandName,
  SidecarEvent,
  SidecarRequest,
  SidecarResponse,
} from './sidecar/protocol.ts';
export type {
  BrowserProfileManager,
  BrowserSession,
  ProfileManagerOptions,
} from './browser/profileManager.ts';
