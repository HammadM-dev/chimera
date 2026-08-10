import type Database from 'better-sqlite3';

// Workspace-scoped settings. One row, created by migration 0002, so every read
// finds it and no caller has to handle "not configured yet".

type ChangeListener = () => void;
const listeners = new WeakMap<Database.Database, Set<ChangeListener>>();

export function onSettingsChanged(db: Database.Database, listener: ChangeListener): () => void {
  let set = listeners.get(db);
  if (!set) {
    set = new Set();
    listeners.set(db, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

function notifyChanged(db: Database.Database): void {
  for (const listener of listeners.get(db) ?? []) listener();
}

export interface WorkspaceSettings {
  localOnlyMode: boolean;
}

export function read(db: Database.Database): WorkspaceSettings {
  const row = db.prepare('SELECT local_only_mode FROM workspace_settings WHERE id = 1').get() as
    { local_only_mode: number } | undefined;
  // SQLite has no boolean type; 0/1 is the storage convention.
  return { localOnlyMode: (row?.local_only_mode ?? 0) === 1 };
}

export function setLocalOnlyMode(db: Database.Database, enabled: boolean): void {
  db.prepare('UPDATE workspace_settings SET local_only_mode = ? WHERE id = 1').run(enabled ? 1 : 0);
  notifyChanged(db);
}
