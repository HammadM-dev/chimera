// packages/control — browser control (Playwright) and the sidecar bridge client.
// Browser control populated starting M6; sidecar bridge client scaffolded M0,
// wired to a real binary starting M8. See docs/ARCHITECTURE.md.
export { createBrowserProfileManager } from './browser/profileManager.ts';
export type {
  BrowserProfileManager,
  BrowserSession,
  ProfileManagerOptions,
} from './browser/profileManager.ts';
