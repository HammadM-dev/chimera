import { copyFile, cp, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Keeping something a run produced.
//
// A run writes into its own sandbox, which is a directory under the workspace
// that gets swept. That is the right place for an agent to work and the wrong
// place for the thing a person actually wanted — so the run window offers to
// copy it somewhere they choose, and this is the copying.
//
// The path comes from the renderer, which means it comes from a trace event,
// which means it originated in a tool call an agent made. It is checked against
// the run's own sandbox before anything is read: an agent that could talk the
// window into copying `~/.ssh/id_rsa` to the desktop would be an exfiltration
// path with a Save button on it.

export interface SaveResult {
  saved: boolean;
  /** Where it went, when it went anywhere. */
  path: string;
  reason: string;
}

export async function saveArtifact(input: {
  runId: string;
  /** The path as the trace recorded it: relative to the run's sandbox. */
  path: string;
  name: string;
}): Promise<SaveResult> {
  // The same root `service.ts` gives the run: one directory per run id under
  // the OS temp dir. Resolved through `realpath` because macOS's /var is a
  // symlink to /private/var, and a prefix comparison against the unresolved
  // form would refuse every save on a Mac.
  let root: string;
  try {
    root = await realpath(path.join(os.tmpdir(), 'chimera-runs', input.runId));
  } catch {
    return { saved: false, path: '', reason: 'This run has no workspace any more.' };
  }

  let resolved: string;
  try {
    resolved = await realpath(path.resolve(root, input.path));
  } catch {
    return {
      saved: false,
      path: '',
      reason: 'That file is no longer there — the run’s workspace may have been cleaned up.',
    };
  }

  // The whole check. `path.resolve` collapses `..`, so a path that climbs out
  // of the sandbox fails this comparison rather than arriving somewhere else.
  // The separator matters: `/runs/abc-evil` must not pass as inside `/runs/abc`.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { saved: false, path: '', reason: 'That file is not part of this run.' };
  }

  // Imported here rather than at module scope, the same as `files/service.ts`
  // and `runs/history.ts`: a top-level `electron` import drags Electron into
  // everything that reaches this file, and the IPC registry's own test reaches
  // it through `handlers.ts`.
  const { app, dialog } = await import('electron');

  let isDirectory = false;
  try {
    isDirectory = (await stat(resolved)).isDirectory();
  } catch {
    return {
      saved: false,
      path: '',
      reason: 'That file is no longer there — the run’s workspace may have been cleaned up.',
    };
  }

  const suggested = path.join(app.getPath('downloads'), input.name);

  if (isDirectory) {
    const chosen = await dialog.showOpenDialog({
      title: `Where should “${input.name}” go?`,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Save here',
    });
    const target = chosen.filePaths[0];
    if (chosen.canceled || target === undefined) {
      return { saved: false, path: '', reason: '' };
    }
    const destination = path.join(target, input.name);
    await cp(resolved, destination, { recursive: true });
    return { saved: true, path: destination, reason: '' };
  }

  const chosen = await dialog.showSaveDialog({
    title: `Save “${input.name}”`,
    defaultPath: suggested,
  });
  if (chosen.canceled || chosen.filePath === '') {
    // Cancelling is not a failure and must not read as one.
    return { saved: false, path: '', reason: '' };
  }

  await copyFile(resolved, chosen.filePath);
  return { saved: true, path: chosen.filePath, reason: '' };
}
