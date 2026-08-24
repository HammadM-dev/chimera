import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolExecutionError } from '@chimera/errors';
import type { Sandbox } from '../sandbox.ts';
import { readAnyDocument } from '../documentReader.ts';
import { readableExtensions, type DocumentText } from '../documents.ts';

// The filesystem tool server. One instance per run, holding that run's sandbox.
//
// Every handler's first statement is a sandbox resolve. There is no path in
// this file that reaches a syscall without going through one, and the tests
// assert the refusal happens before any access rather than merely that the call
// failed.
//
// Reads use `resolveForRead`, which also reaches folders the user has granted;
// writes use `resolve`, which never does. Granting a folder makes it readable
// and nothing else — there is no argument to `writeFile` that reaches one.

/** Files larger than this are refused rather than read into a prompt, unless the automation says otherwise. */
export const DEFAULT_MAX_READ_BYTES = 1_000_000;

export interface FilesystemServerOptions {
  /** The automation's own read limit. Absent means `DEFAULT_MAX_READ_BYTES`. */
  maxReadBytes?: number;
  /** How long one document may take to parse before the child is killed. */
  documentTimeoutMs?: number;
  /**
   * Injected by tests, so they can parse in-process instead of spawning.
   *
   * A test that spawns a real child for every fixture is a slow test, and the
   * thing worth asserting here is that `readFile` reaches the reader at all —
   * the parsers have their own tests against real documents.
   */
  readDocument?: (path: string, maxChars: number, timeoutMs: number) => Promise<DocumentText>;
}

function failure(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  // MCP's protocol-level error: the tool ran and could not do the job. Returned
  // rather than thrown so the agent sees a result it can reason about, which is
  // the difference between "that file does not exist" and a broken transport.
  return { content: [{ type: 'text', text: message }], isError: true };
}

function ok(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

/**
 * Runs a handler, turning a refused path into a tool error the agent can read.
 *
 * `ToolExecutionError` from the sandbox is the expected shape of "you may not
 * go there" and becomes an `isError` result; anything else is a real fault and
 * is re-raised.
 */
function guard(work: () => { content: { type: 'text'; text: string }[]; isError?: true }): {
  content: { type: 'text'; text: string }[];
  isError?: true;
} {
  try {
    return work();
  } catch (err) {
    if (err instanceof ToolExecutionError) return failure(err.message);
    if (err instanceof Error) return failure(err.message);
    throw err;
  }
}

/**
 * Tells the model where it may look.
 *
 * A capability the agent cannot see is a capability it will not use: granted
 * folders are enforced in the sandbox whatever the description says, but an
 * agent that has not been told about them will keep answering "I have no
 * access to that file".
 */
function readDescription(sandbox: Sandbox, verb: string): string {
  if (sandbox.readable.length === 0) return `${verb} from the run's workspace.`;
  return `${verb} from the run's workspace, or from these folders the user has granted read access to: ${sandbox.readable.join(', ')}.`;
}

export function createFilesystemServer(
  sandbox: Sandbox,
  options: FilesystemServerOptions = {},
): McpServer {
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const server = new McpServer({ name: 'chimera-filesystem', version: '0.0.0' });

  server.registerTool(
    'readFile',
    {
      description: readDescription(
        sandbox,
        `Reads a file as text. Spreadsheets, Word documents, PDFs, PowerPoints and zip listings are converted for you, so ask for the file itself rather than a text export of it. Readable: ${readableExtensions().join(', ')}`,
      ),
      inputSchema: {
        path: z
          .string()
          .describe("Relative to the run's workspace, or an absolute path inside a granted folder"),
      },
    },
    async ({ path: requested }) => {
      let resolved: string;
      try {
        resolved = sandbox.resolveForRead(requested);
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) return failure(`"${requested}" is a directory.`);
        if (stat.size > maxReadBytes) {
          return failure(
            `"${requested}" is ${String(stat.size)} bytes, over this automation’s ${String(maxReadBytes)}-byte read limit. Raise the file size limit on the automation if this file is meant to be read.`,
          );
        }
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }

      // A character limit derived from the byte one. They measure different
      // things — a spreadsheet is far smaller than the text it becomes, a PDF
      // far larger — so the file limit bounds what is opened and this bounds
      // what reaches the prompt.
      const maxChars = Math.max(1_000, Math.floor(maxReadBytes / 2));

      try {
        const document = await readAnyDocument(resolved, {
          maxChars,
          ...(options.documentTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.documentTimeoutMs }),
          ...(options.readDocument === undefined ? {} : { spawn: options.readDocument }),
        });
        return ok(document.note === '' ? document.text : `${document.text}\n\n[${document.note}]`);
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'writeFile',
    {
      description:
        "Writes a UTF-8 text file into the run's workspace, creating parent directories.",
      inputSchema: {
        path: z.string().describe("Path relative to the run's workspace root"),
        content: z.string(),
      },
    },
    ({ path: requested, content }) =>
      guard(() => {
        const resolved = sandbox.resolve(requested);
        // The parent is resolved too. Creating it via `recursive: true` from an
        // unvalidated path would let a traversal create directories outside the
        // sandbox even though the write itself was later refused.
        sandbox.resolve(path.dirname(requested));
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, 'utf8');
        return ok(`Wrote ${String(Buffer.byteLength(content, 'utf8'))} bytes to ${requested}`);
      }),
  );

  server.registerTool(
    'listDirectory',
    {
      description: readDescription(sandbox, 'Lists the entries of a directory'),
      inputSchema: { path: z.string().default('.') },
    },
    ({ path: requested }) =>
      guard(() => {
        const resolved = sandbox.resolveForRead(requested ?? '.');
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        if (entries.length === 0) return ok('(empty)');
        return ok(
          entries
            .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
            .sort()
            .join('\n'),
        );
      }),
  );

  server.registerTool(
    'makeDirectory',
    {
      description: "Creates a directory in the run's workspace.",
      inputSchema: { path: z.string() },
    },
    ({ path: requested }) =>
      guard(() => {
        const resolved = sandbox.resolve(requested);
        fs.mkdirSync(resolved, { recursive: true });
        return ok(`Created ${requested}`);
      }),
  );

  return server;
}
