import { spawn } from 'node:child_process';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Sandbox } from '../sandbox.ts';

// The shell tool server. Same confinement discipline as the filesystem server:
// the process's working directory is the run's sandbox, and it is set here
// rather than being something the agent can choose.

/**
 * The environment a spawned process gets.
 *
 * Built from nothing rather than inherited from `process.env`. CHIMERA's own
 * process holds no vault secrets by design, but it does hold whatever the user
 * exported into their shell before launching the app — API keys, tokens, CI
 * credentials — and passing that wholesale into a process an agent chose the
 * arguments for would hand it all of them. PATH is included because a command
 * cannot be found without it.
 */
function childEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
    ...(process.platform === 'win32'
      ? {
          SystemRoot: process.env.SystemRoot ?? '',
          COMSPEC: process.env.COMSPEC ?? '',
          PATHEXT: process.env.PATHEXT ?? '',
        }
      : {}),
  };
}

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Output beyond this is truncated rather than fed whole into a prompt. */
const MAX_OUTPUT_BYTES = 200_000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return `${text.slice(0, MAX_OUTPUT_BYTES)}\n[truncated at ${String(MAX_OUTPUT_BYTES)} characters]`;
}

/**
 * Runs one command inside the sandbox, under a wall-clock limit.
 *
 * No shell interpretation: the command and its arguments are passed as a vector
 * and `shell` is left off. With a shell, `args` would be re-parsed as source
 * text, and a filename an agent read out of an untrusted document could become
 * `; rm -rf ~`. Quoting is not a defence against that; not invoking a shell is.
 */
export function runInSandbox(
  sandbox: Sandbox,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    const child = spawn(command, [...args], {
      cwd: sandbox.root,
      env: childEnvironment(),
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL rather than SIGTERM: the limit is the Governor's, and a process
      // that ignores a polite request is exactly the case the limit exists for.
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout: truncate(stdout), stderr: truncate(stderr), timedOut });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err: Error) => {
      stderr += err.message;
      finish(null);
    });
    child.on('close', (code) => {
      finish(code);
    });
  });
}

export function createShellServer(sandbox: Sandbox): McpServer {
  const server = new McpServer({ name: 'chimera-shell', version: '0.0.0' });

  server.registerTool(
    'exec',
    {
      description: "Runs a command in the run's workspace and returns its output.",
      inputSchema: {
        command: z.string().describe('Executable name. Not a shell line — no pipes or redirects.'),
        args: z.array(z.string()).default([]),
        // Required, with no default. The wall-clock limit belongs to the node's
        // declared budget and is passed in by the caller; a default here would
        // be this file quietly deciding a governed number.
        timeoutMs: z
          .number()
          .int()
          .positive()
          .describe("Wall-clock limit, from the calling node's budget"),
      },
    },
    async ({ command, args, timeoutMs }) => {
      const result = await runInSandbox(sandbox, command, args ?? [], timeoutMs);
      const report = [
        `exit: ${result.timedOut ? 'killed after timeout' : String(result.exitCode)}`,
        result.stdout === '' ? '' : `stdout:\n${result.stdout}`,
        result.stderr === '' ? '' : `stderr:\n${result.stderr}`,
      ]
        .filter((part) => part !== '')
        .join('\n');

      return {
        content: [{ type: 'text' as const, text: report }],
        ...(result.timedOut || result.exitCode !== 0 ? { isError: true as const } : {}),
      };
    },
  );

  return server;
}
