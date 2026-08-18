import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { SidecarError } from '@chimera/errors';
import {
  encodeRequest,
  isEvent,
  parseLine,
  splitLines,
  type SidecarCommandName,
  type SidecarEvent,
} from './protocol.ts';

// M8-1's TypeScript half: starting the native-control binary, talking to it,
// and noticing when it dies.
//
// The binary itself is Rust and is not in this repository yet. This side is
// written and tested first on purpose — everything that decides *whether* a
// native action happens lives here, and it can be proven against a stand-in
// process that speaks the same protocol. What is left for the binary is the
// part only the operating system can do.

export interface SidecarOptions {
  /** The binary. Absent means native control is not available on this install. */
  path: string;
  args?: string[];
  /** How long any one command may take before it is given up on. */
  timeoutMs?: number;
  /** Called for anything the sidecar says without being asked. */
  onEvent?: (event: SidecarEvent) => void;
  /** Called when the process exits, expectedly or otherwise. */
  onExit?: (code: number | null) => void;
  /** Injected for tests; defaults to spawning a real process. */
  spawnProcess?: (path: string, args: string[]) => ChildProcessWithoutNullStreams;
}

export interface SidecarBridge {
  start: () => void;
  send: (command: SidecarCommandName, params?: Record<string, unknown>) => Promise<unknown>;
  readonly running: boolean;
  stop: () => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function createSidecarBridge(options: SidecarOptions): SidecarBridge {
  let child: ChildProcessWithoutNullStreams | undefined;
  let buffer = '';
  let nextId = 1;

  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
  >();

  /**
   * Fails everything still waiting.
   *
   * Called when the process exits for any reason. A command whose process has
   * gone is never going to be answered, and a promise that stays pending for
   * ever is a run that hangs with no error to show anybody.
   */
  const failAll = (reason: string): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new SidecarError('SIDECAR_GONE', reason, { id }));
    }
    pending.clear();
  };

  const handleLine = (line: string): void => {
    const message = parseLine(line);
    if (!message) return;

    if (isEvent(message)) {
      options.onEvent?.(message);
      return;
    }

    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.ok) {
      entry.resolve(message.result);
    } else {
      entry.reject(new SidecarError(message.error.code, message.error.message, { id: message.id }));
    }
  };

  return {
    get running() {
      return child !== undefined && child.exitCode === null;
    },

    start() {
      if (child) return;

      const spawnIt =
        options.spawnProcess ?? ((path, args) => spawn(path, args, { stdio: 'pipe' }));
      child = spawnIt(options.path, options.args ?? []);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        const split = splitLines(buffer + chunk);
        buffer = split.rest;
        for (const line of split.lines) handleLine(line);
      });

      // The sidecar's stderr is its own diagnostics, never the protocol. Kept
      // separate so a panicking binary cannot be mistaken for a response.
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        options.onEvent?.({ event: 'stderr', data: chunk.trim() });
      });

      child.on('exit', (code) => {
        failAll('The native helper stopped.');
        child = undefined;
        buffer = '';
        options.onExit?.(code);
      });

      child.on('error', (err: Error) => {
        failAll(`The native helper could not be started: ${err.message}`);
        child = undefined;
      });
    },

    send(command, params) {
      if (!child || child.exitCode !== null) {
        return Promise.reject(
          new SidecarError(
            'SIDECAR_NOT_RUNNING',
            'Native control is not available: the helper is not running.',
            { command },
          ),
        );
      }

      const id = nextId;
      nextId += 1;

      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          // Timed out rather than waited on for ever. A native action that has
          // not answered in fifteen seconds is one the user is already
          // wondering about, and a run stuck behind it cannot even be
          // cancelled.
          reject(
            new SidecarError(
              'SIDECAR_TIMEOUT',
              `The native helper did not answer "${command}" in time.`,
              { command, id },
            ),
          );
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        pending.set(id, { resolve, reject, timer });
        child?.stdin.write(encodeRequest({ id, command, ...(params ? { params } : {}) }));
      });
    },

    async stop() {
      const running = child;
      if (!running) return;

      failAll('Native control was stopped.');
      running.stdin.end();
      running.kill();
      child = undefined;

      // Waited for, briefly. A helper left half-dead is a process holding an
      // input hook on the user's machine after CHIMERA has quit.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        running.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
