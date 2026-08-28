import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import { kindOf, readableExtensions, type DocumentText } from './documents.ts';

// The parent half of document reading: spawn the child, wait, read one line.
//
// Everything about this file is about the parser being somebody else's code
// reading a stranger's file. It gets its own process, a wall-clock limit, and a
// cap on how much it may say back. It is given a path and a number and no
// environment, and nothing it returns is trusted beyond being a string.

export interface DocumentReadOptions {
  /** How much text may come back. The automation's own file limit. */
  maxChars: number;
  /** How long a single file may take. A parser that hangs is a parser that is killed. */
  timeoutMs?: number;
  /** Injected by tests so they can run the parse in-process without a child. */
  spawn?: (path: string, maxChars: number, timeoutMs: number) => Promise<DocumentText>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Where the child's entry point lives, relative to this file.
 *
 * Two forms, because this module runs from two places. Under `node --test` it
 * is TypeScript source and its sibling is `documentWorker.ts`; inside the app
 * it is a line in `dist/main.js` and its sibling is `documentWorker.js`, built
 * beside it. Hard-coding the `.ts` name meant the built app spawned a path
 * that does not exist there, so every document read failed — and no test saw
 * it, because they all inject `spawn` and never reach this line.
 */
const WORKER = ((): string => {
  const built = path.join(import.meta.dirname, 'documentWorker.js');
  return fsSync.existsSync(built) ? built : path.join(import.meta.dirname, 'documentWorker.ts');
})();

export class DocumentReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentReadError';
  }
}

function runWorker(target: string, maxChars: number, timeoutMs: number): Promise<DocumentText> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        // Only source needs the stripper. Asking for it on built JavaScript is
        // harmless but says the wrong thing about what is being run.
        ...(WORKER.endsWith('.ts') ? ['--experimental-strip-types'] : []),
        '--no-warnings',
        WORKER,
        target,
        String(maxChars),
      ],
      {
        timeout: timeoutMs,
        // Room for the answer plus the slack a parser's own chatter needs.
        maxBuffer: Math.max(maxChars * 4, 4 * 1024 * 1024),
        // Nothing from the app's environment. A parser has no business reading
        // it, and a compromised one has no business finding an API key in it.
        //
        // ELECTRON_RUN_AS_NODE is the exception, and it is not app state: in
        // the packaged app `process.execPath` is the Electron binary, which
        // given a script path tries to *open it as an application* — "Unable
        // to find Electron app at …/documentWorker.ts" was this, not a missing
        // file. The flag makes that same binary behave as the Node it embeds.
        // Harmless under plain Node, which ignores it.
        env: { PATH: process.env['PATH'] ?? '', ELECTRON_RUN_AS_NODE: '1' },
      },
      (err, stdout) => {
        if (err && stdout.trim() === '') {
          // Killed, or died before it could say anything.
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          reject(
            new DocumentReadError(
              killed
                ? `Reading this file took longer than ${String(Math.round(timeoutMs / 1000))}s and was stopped.`
                : `The file could not be read: ${err.message}`,
            ),
          );
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          reject(new DocumentReadError('The reader returned something unreadable.'));
          return;
        }

        const record = (parsed ?? {}) as Record<string, unknown>;
        if (typeof record['error'] === 'string') {
          reject(new DocumentReadError(record['error']));
          return;
        }

        resolve({
          kind: (record['kind'] as DocumentText['kind']) ?? 'text',
          text: typeof record['text'] === 'string' ? record['text'] : '',
          note: typeof record['note'] === 'string' ? record['note'] : '',
        });
      },
    );
  });
}

/**
 * Reads a file of any supported type as text.
 *
 * Throws `DocumentReadError` with something a person could act on — an agent
 * gets the message back as a tool result and has to be able to tell "this is
 * not a format I can open" from "that file is not there".
 */
export async function readAnyDocument(
  target: string,
  options: DocumentReadOptions,
): Promise<DocumentText> {
  if (kindOf(target) === null) {
    throw new DocumentReadError(
      `"${path.basename(target)}" is not a file type this build can read. It can read: ${readableExtensions().join(', ')}.`,
    );
  }

  const spawn = options.spawn ?? runWorker;
  return spawn(target, options.maxChars, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}
