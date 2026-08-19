import fs from 'node:fs';
import path from 'node:path';
import { ToolExecutionError } from '@chimera/errors';

// F2.5's workspace sandbox. Every run gets one directory and cannot see outside
// it.
//
// The confinement is structural: every path an agent supplies is resolved and
// validated against the sandbox root *before* any syscall touches it. Nothing
// here relies on the prompt having told the agent to stay put — CLAUDE.md,
// "capability limits are the real defence, not prompt wording."
//
// This is OS-process-level isolation (working-directory confinement, path
// validation, spawn options, and the Governor's wall-clock and step limits),
// which is the master plan's open decision 2 resolved: not cgroups, not Job
// Objects, not sandbox-exec. Docker arrives later as an opt-in stronger mode.

export interface Sandbox {
  /** The run's own directory, already realpath-resolved. */
  readonly root: string;
  readonly runId: string;
  /**
   * Folders the user has granted read access to, already realpath-resolved.
   * Empty unless somebody has explicitly granted one.
   */
  readonly readable: readonly string[];
  /**
   * Turns an agent-supplied path into an absolute one inside the sandbox, or
   * throws. Call this before every filesystem operation that writes, without
   * exception.
   */
  resolve: (requested: string) => string;
  /**
   * The same, for reading, which may also reach a granted folder.
   *
   * Separate from `resolve` so that granting somewhere readable cannot make it
   * writable by accident: a write calls `resolve` and there is no argument it
   * can be given that reaches a granted folder. The two are different questions
   * and they are different functions.
   */
  resolveForRead: (requested: string) => string;
}

/**
 * The longest ancestor of `candidate` that exists on disk.
 *
 * Needed because `realpath` fails on a path that does not exist yet, and a
 * write to a new file is the ordinary case. Resolving the existing prefix and
 * re-appending the remainder gives a symlink-resolved answer for a path that is
 * about to be created.
 */
function existingAncestor(candidate: string): string {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Opens (creating if needed) the sandbox for one run.
 *
 * `baseDir` is the workspace's sandbox root; each run gets `baseDir/<runId>`.
 * Two runs therefore never share a directory, which is what makes one run
 * unable to read another's files a property of the layout rather than of
 * anyone remembering to check.
 */
export function createSandbox(
  baseDir: string,
  runId: string,
  /**
   * Folders the user has granted this workspace read access to.
   *
   * A grant is explicit, per folder, and readable only. One that cannot be
   * resolved — deleted since it was granted, or a broken link — is dropped
   * rather than throwing: a stale grant should not stop every run.
   */
  readableRoots: readonly string[] = [],
): Sandbox {
  if (runId === '' || runId.includes('/') || runId.includes('\\') || runId.includes('..')) {
    // The run id becomes a directory name, so it is a path component and has to
    // be validated like one — otherwise a crafted run id is itself an escape.
    throw new ToolExecutionError(`Unusable run id for a sandbox: "${runId}".`, { runId });
  }

  const root = path.join(path.resolve(baseDir), runId);
  fs.mkdirSync(root, { recursive: true });
  // Resolved once, here, so that a symlinked temp directory (macOS's /var, for
  // one) does not make every containment check fail for the wrong reason.
  const realRoot = fs.realpathSync(root);

  const readable = readableRoots
    .map((granted) => {
      try {
        return fs.realpathSync(path.resolve(granted));
      } catch {
        return '';
      }
    })
    .filter((granted) => granted !== '');

  /**
   * The shared half of both resolvers: everything except which roots count.
   *
   * Kept as one function because the traversal, null-byte and symlink
   * arguments are identical for reads and writes, and two copies of a
   * containment check is how one of them ends up subtly weaker.
   */
  const resolveWithin = (requested: string, roots: readonly string[], what: string): string => {
    if (requested.includes('\0')) {
      throw new ToolExecutionError('A path may not contain a null byte.', { requested, runId });
    }

    // `path.resolve` handles both halves of the traversal problem: a relative
    // '../../etc/passwd' is resolved against the root and lands outside it,
    // and an absolute '/etc/passwd' replaces the root entirely. Both are then
    // caught by the containment check below — one rule, not two.
    //
    // An absolute path is resolved as given, so a granted folder can be named
    // outright; it still has to survive containment against the roots below.
    const candidate = path.resolve(realRoot, requested);

    // Symlink escape: a link inside a permitted root pointing out of it
    // resolves to a path that fails containment. Checked on the longest
    // existing ancestor, because the target of a write may not exist yet.
    const anchor = existingAncestor(candidate);
    const realAnchor = fs.realpathSync(anchor);
    const remainder = path.relative(anchor, candidate);
    const resolved = remainder === '' ? realAnchor : path.resolve(realAnchor, remainder);

    if (!roots.some((root_) => contains(root_, resolved))) {
      throw new ToolExecutionError(
        `Path "${requested}" resolves outside ${what} and was refused.`,
        {
          requested,
          runId,
        },
      );
    }
    return resolved;
  };

  return {
    root: realRoot,
    runId,
    readable,

    resolve(requested: string): string {
      return resolveWithin(requested, [realRoot], "the run's workspace");
    },

    resolveForRead(requested: string): string {
      return resolveWithin(
        requested,
        [realRoot, ...readable],
        readable.length === 0
          ? "the run's workspace"
          : "the run's workspace or a folder you have been given",
      );
    },
  };
}

/** Removes a run's sandbox. Best-effort: a locked file must not fail a run's teardown. */
export function destroySandbox(sandbox: Sandbox): void {
  fs.rmSync(sandbox.root, { recursive: true, force: true });
}
