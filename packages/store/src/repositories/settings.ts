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

export const MODEL_TIERS = ['cheap', 'standard', 'frontier'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** What a tier resolves to here. Empty strings mean "not configured yet". */
export interface TierBinding {
  connectionId: string;
  model: string;
}

export type ModelTiers = Record<ModelTier, TierBinding>;

const NO_TIERS: ModelTiers = {
  cheap: { connectionId: '', model: '' },
  standard: { connectionId: '', model: '' },
  frontier: { connectionId: '', model: '' },
};

export interface WorkspaceSettings {
  localOnlyMode: boolean;
  modelTiers: ModelTiers;
}

export function read(db: Database.Database): WorkspaceSettings {
  const row = db
    .prepare('SELECT local_only_mode, model_tiers_json FROM workspace_settings WHERE id = 1')
    .get() as { local_only_mode: number; model_tiers_json: string } | undefined;

  let modelTiers = NO_TIERS;
  try {
    const parsed = JSON.parse(row?.model_tiers_json ?? '{}') as Partial<ModelTiers>;
    modelTiers = {
      cheap: parsed.cheap ?? NO_TIERS.cheap,
      standard: parsed.standard ?? NO_TIERS.standard,
      frontier: parsed.frontier ?? NO_TIERS.frontier,
    };
  } catch {
    // An unreadable tier map is no tier map. A workflow bound to a tier will
    // then say so plainly rather than running on whatever parsed.
    modelTiers = NO_TIERS;
  }

  // SQLite has no boolean type; 0/1 is the storage convention.
  return { localOnlyMode: (row?.local_only_mode ?? 0) === 1, modelTiers };
}

export function setModelTiers(db: Database.Database, tiers: ModelTiers): void {
  db.prepare('UPDATE workspace_settings SET model_tiers_json = ? WHERE id = 1').run(
    JSON.stringify(tiers),
  );
  notifyChanged(db);
}

export function setLocalOnlyMode(db: Database.Database, enabled: boolean): void {
  db.prepare('UPDATE workspace_settings SET local_only_mode = ? WHERE id = 1').run(enabled ? 1 : 0);
  notifyChanged(db);
}
