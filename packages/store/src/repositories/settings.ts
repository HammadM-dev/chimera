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

/**
 * Whether this workspace reuses answers it has already paid for.
 *
 * `exact` is a byte-identical prompt to the same model, which is a claim about
 * determinism. `semantic` is a *similar* prompt, which is a claim about
 * meaning — a wrong one hands back a confident answer to a question nobody
 * asked, so it is off until somebody turns it on and can see the threshold.
 */
export interface CachePolicySettings {
  exact: boolean;
  semantic: boolean;
  threshold: number;
  /** The model used to embed prompts. Empty means semantic cannot run at all. */
  embeddingModel: string;
  embeddingConnectionId: string;
}

const CACHE_DEFAULT: CachePolicySettings = {
  exact: false,
  semantic: false,
  threshold: 0.97,
  embeddingModel: '',
  embeddingConnectionId: '',
};

/** Where runs are exported, if anywhere. Empty and off until somebody sets it. */
export interface TelemetrySettings {
  enabled: boolean;
  endpoint: string;
  headersJson: string;
  /** Whether prompts and answers travel too. Off, deliberately. */
  includePayloads: boolean;
}

const TELEMETRY_DEFAULT: TelemetrySettings = {
  enabled: false,
  endpoint: '',
  headersJson: '{}',
  includePayloads: false,
};

/**
 * Search services an agent can be pointed at.
 *
 * `none` is not "no search" — it is the built-in keyless one, which needs no
 * configuration and is what a fresh workspace uses. The others are named APIs
 * the workspace has a key for.
 */
export const SEARCH_PROVIDERS = ['none', 'brave', 'tavily', 'serper'] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

export interface SearchSettings {
  provider: SearchProvider;
  /** Vault handle for the key. Empty for `none`. Never the key itself. */
  authRef: string;
  /** Region hint for results, e.g. `uk`. Empty means no hint. */
  region: string;
}

const SEARCH_DEFAULT: SearchSettings = { provider: 'none', authRef: '', region: '' };

/** Composio: one account per workspace, so connected apps are shared by every automation in it. */
export interface ComposioSettings {
  enabled: boolean;
  /** Vault handle for the API key. Never the key. */
  authRef: string;
  /** Which Composio user this workspace is. Stable for the life of the workspace. */
  userId: string;
}

const COMPOSIO_DEFAULT: ComposioSettings = { enabled: false, authRef: '', userId: '' };

export interface WorkspaceSettings {
  localOnlyMode: boolean;
  /**
   * `connectionId::model` keys, in the order they were pinned.
   *
   * Order is the user's, not a sort: "the ones I use" is a list somebody
   * curates, and re-ordering it under them by name or price would be a
   * different feature wearing this one's name.
   */
  pinnedModels: string[];
  modelTiers: ModelTiers;
  cache: CachePolicySettings;
  telemetry: TelemetrySettings;
  search: SearchSettings;
  composio: ComposioSettings;
}

export function read(db: Database.Database): WorkspaceSettings {
  const row = db
    .prepare(
      `SELECT local_only_mode, model_tiers_json, cache_policy_json, telemetry_json, search_json,
              composio_json, pinned_models_json
       FROM workspace_settings WHERE id = 1`,
    )
    .get() as
    | {
        local_only_mode: number;
        model_tiers_json: string;
        cache_policy_json: string;
        telemetry_json: string;
        search_json: string;
        composio_json: string;
        pinned_models_json: string;
      }
    | undefined;

  let pinnedModels: string[] = [];
  try {
    const parsed = JSON.parse(row?.pinned_models_json ?? '[]') as unknown;
    if (Array.isArray(parsed)) {
      pinnedModels = parsed.filter((entry): entry is string => typeof entry === 'string');
    }
  } catch {
    // A settings row somebody edited by hand is not a reason to refuse to open
    // the workspace. An empty list is the same as never having pinned anything.
  }

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

  let cache = CACHE_DEFAULT;
  try {
    cache = { ...CACHE_DEFAULT, ...(JSON.parse(row?.cache_policy_json ?? '{}') as object) };
  } catch {
    // An unreadable policy is no policy: the safe reading of "we cannot tell
    // whether you asked for this" is that you did not.
    cache = CACHE_DEFAULT;
  }

  let telemetry = TELEMETRY_DEFAULT;
  try {
    telemetry = { ...TELEMETRY_DEFAULT, ...(JSON.parse(row?.telemetry_json ?? '{}') as object) };
  } catch {
    telemetry = TELEMETRY_DEFAULT;
  }

  let search = SEARCH_DEFAULT;
  try {
    const parsed = { ...SEARCH_DEFAULT, ...(JSON.parse(row?.search_json ?? '{}') as object) };
    // A provider name this build does not know is not a provider. Falling back
    // to the keyless one keeps research working rather than switching it off.
    search = {
      ...parsed,
      provider: SEARCH_PROVIDERS.includes(parsed.provider) ? parsed.provider : 'none',
    };
  } catch {
    search = SEARCH_DEFAULT;
  }

  let composio = COMPOSIO_DEFAULT;
  try {
    composio = { ...COMPOSIO_DEFAULT, ...(JSON.parse(row?.composio_json ?? '{}') as object) };
  } catch {
    composio = COMPOSIO_DEFAULT;
  }

  // SQLite has no boolean type; 0/1 is the storage convention.
  return {
    localOnlyMode: (row?.local_only_mode ?? 0) === 1,
    pinnedModels,
    modelTiers,
    cache,
    telemetry,
    search,
    composio,
  };
}

export function setComposio(db: Database.Database, composio: ComposioSettings): void {
  db.prepare('UPDATE workspace_settings SET composio_json = ? WHERE id = 1').run(
    JSON.stringify(composio),
  );
  notifyChanged(db);
}

export function setSearch(db: Database.Database, search: SearchSettings): void {
  db.prepare('UPDATE workspace_settings SET search_json = ? WHERE id = 1').run(
    JSON.stringify(search),
  );
  notifyChanged(db);
}

export function setCachePolicy(db: Database.Database, policy: CachePolicySettings): void {
  db.prepare('UPDATE workspace_settings SET cache_policy_json = ? WHERE id = 1').run(
    JSON.stringify(policy),
  );
  notifyChanged(db);
}

export function setTelemetry(db: Database.Database, telemetry: TelemetrySettings): void {
  db.prepare('UPDATE workspace_settings SET telemetry_json = ? WHERE id = 1').run(
    JSON.stringify(telemetry),
  );
  notifyChanged(db);
}

export function setPinnedModels(db: Database.Database, pinned: readonly string[]): void {
  // De-duplicated on the way in, first mention winning, so the order stays the
  // one the user built.
  const unique = [...new Set(pinned.filter((key) => key.trim() !== ''))];
  db.prepare('UPDATE workspace_settings SET pinned_models_json = ? WHERE id = 1').run(
    JSON.stringify(unique),
  );
  notifyChanged(db);
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
