// The two raw Electron IPC channel names everything multiplexes over.
// Deliberately has no Electron import of its own — both preload.ts
// (renderer-adjacent) and mainDispatch.ts (main-process-only) need these
// constants, and preload must never pull in a main-process-only module
// like mainDispatch.ts (which imports ipcMain) just to get a string.
export const INVOKE_CHANNEL = 'chimera:invoke';
export const EVENT_CHANNEL = 'chimera:event';
