import path from 'node:path';
import fs from 'node:fs';
import { fileGrantsRepository, type FileGrant } from '@chimera/store';
import { getStore } from '../store/lifecycle.ts';

// Which folders the user has let CHIMERA read.
//
// The grant is the whole feature. Reading a file the user picked in a dialog
// has always worked — attachments do it — but naming a folder once and then
// referring to anything in it is what makes an automation about somebody's
// actual work rather than about whatever they remembered to attach.
//
// Read access only. Nothing here makes a folder writable, and the sandbox has
// no code path that would: writes resolve against the run's own workspace and
// there is no argument that reaches a granted folder.

export function listGrants(): { grants: (FileGrant & { missing: boolean })[] } {
  return {
    grants: fileGrantsRepository.list(getStore()).map((grant) => ({
      ...grant,
      // A folder that has moved or been deleted since it was granted is shown
      // as missing rather than silently doing nothing: a permission that is
      // not working should say so where it was given.
      missing: !fs.existsSync(grant.path),
    })),
  };
}

export function grantFolder(folder: string): { granted: boolean; reason: string } {
  const resolved = path.resolve(folder);
  if (folder.trim() === '') return { granted: false, reason: 'Choose a folder.' };

  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return { granted: false, reason: `There is no folder at "${folder}".` };
  }
  if (!fs.statSync(real).isDirectory()) {
    return { granted: false, reason: `"${folder}" is a file, not a folder.` };
  }

  // The root of the filesystem, or a home directory, is not a grant — it is
  // everything. A person who means "all of it" can still grant the folders
  // they mean one at a time, and will have said so about each.
  if (real === path.parse(real).root) {
    return { granted: false, reason: 'Choose a folder inside your drive, not the whole drive.' };
  }

  fileGrantsRepository.grant(getStore(), real);
  return { granted: true, reason: '' };
}

export function revokeFolder(folder: string): { revoked: boolean } {
  return { revoked: fileGrantsRepository.revoke(getStore(), folder) };
}

/**
 * The grants a run may read, as absolute paths.
 *
 * Read at the start of every run rather than cached: revoking a folder has to
 * take effect on the next run, not on the next restart.
 */
export function readableFolders(): string[] {
  return fileGrantsRepository.list(getStore()).map((grant) => grant.path);
}
