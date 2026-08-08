import type { WireError } from './types.ts';

// Verified empirically (Electron 43.3.0): a value thrown from a function
// exposed via contextBridge.exposeInMainWorld crosses into the renderer's
// main world as a plain Error with exactly two own properties preserved —
// `stack` and `message`. `name` is flattened to the generic "Error", and
// any custom subclass/properties (code, details) are silently dropped —
// there is no `instanceof CustomErrorClass` and no `.code` on the other
// side, no matter what was actually thrown in preload. `message` is the
// only channel structured data can survive through, so it carries the
// WireError as JSON rather than prose. parseIpcError is the documented way
// to get it back; a raw, unparsed .message is still a reasonable fallback
// for anything that just logs the caught error directly.
export function throwIpcError(error: WireError): never {
  throw new Error(JSON.stringify(error));
}

export function parseIpcError(err: unknown): WireError | null {
  if (!(err instanceof Error)) return null;
  try {
    const parsed: unknown = JSON.parse(err.message);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>)['code'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['message'] === 'string'
    ) {
      return parsed as WireError;
    }
  } catch {
    // Not JSON — a genuine, non-IPC error crossed instead. Fall through.
  }
  return null;
}
