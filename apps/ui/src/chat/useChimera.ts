// The renderer's only door to the main process. Everything here goes through
// window.chimera.* — apps/ui imports nothing from packages/* and has no Node
// access at all (CLAUDE.md, docs/ARCHITECTURE.md section 4).

export interface WireError {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface ChimeraBridge {
  invoke: <T = unknown>(channel: string, payload: unknown) => Promise<T>;
  on: <T = unknown>(channel: string, callback: (payload: T) => void) => () => void;
  parseError: (err: unknown) => WireError | null;
}

export interface ConnectionSummary {
  id: string;
  label: string;
  kind: string;
  baseUrl: string | null;
  healthState: string;
}

export interface ChatDelta {
  streamId: string;
  type: 'start' | 'text' | 'finish' | 'error';
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * The bridge, or an explanation of why it is missing.
 *
 * A renderer loaded outside Electron (a plain browser, a broken preload) has no
 * `window.chimera`, and reading through it would throw during the first render
 * with a message that says nothing useful. Failing here names the actual cause.
 */
export function bridge(): ChimeraBridge {
  const candidate = (window as unknown as { chimera?: ChimeraBridge }).chimera;
  if (!candidate) {
    throw new Error(
      'The preload bridge is unavailable. This window was not created by the CHIMERA main process.',
    );
  }
  return candidate;
}

/** Turns any thrown value into something worth showing a person. */
export function describeError(err: unknown): { code: string; message: string } {
  const parsed = bridge().parseError(err);
  if (parsed) return { code: parsed.code, message: parsed.message };
  return {
    code: 'UNKNOWN',
    message: err instanceof Error ? err.message : String(err),
  };
}
