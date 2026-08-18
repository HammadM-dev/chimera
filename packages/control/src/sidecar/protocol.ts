// The wire between CHIMERA and the native-control binary.
//
// Line-delimited JSON over stdio, and deliberately nothing cleverer. A socket
// needs a port, a permission and a story about who else can connect; a shared
// memory region needs a lifetime nobody can see. A pipe to a child process
// starts when the app starts it, dies when the app dies, and cannot be reached
// by anything else on the machine.
//
// The sidecar holds no product logic. It takes a command, does one thing to the
// operating system, and answers — every decision about *whether* to do that
// thing has already been made on this side, by the Governor and the approval
// gate. The master plan's own constraint: if the binary grows past about 1500
// lines, something in it belongs in TypeScript.

/** Every command the sidecar understands. */
export type SidecarCommand =
  | { command: 'ping' }
  | { command: 'capture'; params: { displayId?: number } }
  | {
      command: 'injectInput';
      params:
        | { kind: 'key'; keys: string[] }
        | { kind: 'type'; text: string }
        | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' }
        | { kind: 'move'; x: number; y: number };
    }
  | { command: 'readUiTree'; params: { maxDepth?: number } };

export type SidecarCommandName = SidecarCommand['command'];

export interface SidecarRequest {
  /** Matched to a response. Monotonic per process; never reused. */
  id: number;
  command: SidecarCommandName;
  params?: Record<string, unknown>;
}

export interface SidecarOk {
  id: number;
  ok: true;
  result: unknown;
}

export interface SidecarFailure {
  id: number;
  ok: false;
  error: { code: string; message: string };
}

export type SidecarResponse = SidecarOk | SidecarFailure;

/**
 * Something the sidecar says without being asked.
 *
 * There is exactly one today — the binary announcing what it can do when it
 * starts — and the shape exists so that adding a second (a progress line for a
 * long capture, say) does not need a protocol change.
 */
export interface SidecarEvent {
  event: string;
  data: unknown;
}

export type SidecarMessage = SidecarResponse | SidecarEvent;

export function isEvent(message: SidecarMessage): message is SidecarEvent {
  return 'event' in message;
}

/**
 * Reads one line into a message, or nothing.
 *
 * Nothing rather than throwing: a sidecar that printed a warning to stdout
 * should cost us that line, not the session. The binary is told to keep stdout
 * for the protocol, and this is what happens when it forgets.
 */
export function parseLine(line: string): SidecarMessage | null {
  const trimmed = line.trim();
  if (trimmed === '' || !trimmed.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed['event'] === 'string') {
      return { event: parsed['event'], data: parsed['data'] };
    }
    if (typeof parsed['id'] !== 'number') return null;

    if (parsed['ok'] === true) return { id: parsed['id'], ok: true, result: parsed['result'] };

    const error = (parsed['error'] ?? {}) as { code?: string; message?: string };
    return {
      id: parsed['id'],
      ok: false,
      error: {
        code: error.code ?? 'SIDECAR_ERROR',
        message: error.message ?? 'The native helper did not say what went wrong.',
      },
    };
  } catch {
    return null;
  }
}

/** Splits a stream chunk into whole lines, keeping the partial tail. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts, rest };
}

export function encodeRequest(request: SidecarRequest): string {
  return `${JSON.stringify(request)}\n`;
}
