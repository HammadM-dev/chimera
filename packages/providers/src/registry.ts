import type Database from 'better-sqlite3';
import {
  connectionsRepository,
  onConnectionsChanged,
  type AuthRef,
  type ConnectionRecord,
} from '@chimera/store';

// The runtime view of the `connections` table. packages/store persists rows and
// knows nothing about what a provider is; this module is the layer that knows
// the provider taxonomy and turns rows into something the rest of the system
// can use.
//
// Imports packages/store only. Never packages/core — docs/ARCHITECTURE.md
// section 3's dependency direction, which is what makes CLAUDE.md's "provider
// differences live in adapters only" structurally true rather than a
// convention: nothing in this package can see a role, a budget, or a workflow,
// so nothing here can branch on one.

/** The provider kinds with adapters, shipped (M1-4) or planned (M1-5). */
export const PROVIDER_KINDS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'omniroute',
  'ollama',
  'lmstudio',
  'openai-compatible',
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const HEALTH_STATES = ['unknown', 'healthy', 'degraded', 'unavailable'] as const;

export type HealthState = (typeof HEALTH_STATES)[number];

/** Per-connection ceilings. Enforced by the Governor from M3-5, not here. */
export interface ProviderLimits {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  maxConcurrentRequests?: number;
}

export interface ProviderConnection {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string | null;
  /** A vault handle. The secret itself is never in this object. */
  authRef: AuthRef;
  /** Cached capability-matrix snapshot, keyed by model id. Typed in M1-3. */
  capabilities: Record<string, unknown>;
  limits: ProviderLimits;
  healthState: HealthState;
  createdAt: string;
}

/** A row the registry could not turn into a `ProviderConnection`. */
export interface UnusableConnection {
  id: string;
  label: string;
  kind: string;
  reason: string;
}

export interface ConnectionRegistry {
  /** Every usable connection, reflecting the table as of this call. */
  list(): ProviderConnection[];
  get(id: string): ProviderConnection | undefined;
  /**
   * Rows that exist but cannot be used — an unrecognised provider kind, or a
   * corrupt capabilities blob.
   *
   * Surfaced rather than dropped on purpose. Skipping them silently would mean
   * a user whose connection vanished from the UI has nothing to go on; throwing
   * would mean one bad row takes out every other connection in the workspace.
   * Neither is acceptable, so bad rows are quarantined and reported.
   */
  unusable(): UnusableConnection[];
  /** Drop the cache. Rarely needed — mutations invalidate it automatically. */
  refresh(): void;
  /** Unsubscribe from the repository. Call when tearing the workspace down. */
  close(): void;
}

function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

function isHealthState(value: string | null): value is HealthState {
  return value !== null && (HEALTH_STATES as readonly string[]).includes(value);
}

interface ParsedCapabilities {
  capabilities: Record<string, unknown>;
  limits: ProviderLimits;
}

/**
 * `capabilities_json` holds `{ capabilities, limits }` as one blob.
 *
 * The kernel schema (docs/ARCHITECTURE.md section 5) gives the table one JSON
 * column and no `limits` column, while the M1-1 runtime shape needs both.
 * Nesting them keeps the schema unchanged — a migration to add a second JSON
 * column would buy nothing that a second key in this one does not.
 */
function parseCapabilities(json: string | null): ParsedCapabilities {
  if (json === null || json.trim() === '') return { capabilities: {}, limits: {} };
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('capabilities_json is not a JSON object');
  }
  const record = parsed as { capabilities?: unknown; limits?: unknown };
  const capabilities =
    typeof record.capabilities === 'object' &&
    record.capabilities !== null &&
    !Array.isArray(record.capabilities)
      ? (record.capabilities as Record<string, unknown>)
      : {};
  const limits =
    typeof record.limits === 'object' && record.limits !== null && !Array.isArray(record.limits)
      ? (record.limits as ProviderLimits)
      : {};
  return { capabilities, limits };
}

type Parsed = { ok: true; connection: ProviderConnection } | { ok: false; reason: string };

function parseRecord(record: ConnectionRecord): Parsed {
  if (!isProviderKind(record.kind)) {
    return {
      ok: false,
      reason: `Unknown provider kind "${record.kind}". This connection was made by a newer version of CHIMERA, or its row was edited by hand.`,
    };
  }

  let parsedCapabilities: ParsedCapabilities;
  try {
    parsedCapabilities = parseCapabilities(record.capabilitiesJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Stored capabilities are unreadable: ${message}` };
  }

  return {
    ok: true,
    connection: {
      id: record.id,
      label: record.label,
      kind: record.kind,
      baseUrl: record.baseUrl,
      authRef: record.authRef,
      capabilities: parsedCapabilities.capabilities,
      limits: parsedCapabilities.limits,
      // An unrecognised health state degrades to 'unknown' rather than
      // quarantining the row: health is re-derived by M1-8's checks on the next
      // poll, so a stale or unexpected value costs nothing and taking the whole
      // connection out of service over it would be a worse outcome.
      healthState: isHealthState(record.healthState) ? record.healthState : 'unknown',
      createdAt: record.createdAt,
    },
  };
}

/**
 * Builds a registry over one database handle.
 *
 * A factory rather than module-level singletons so tests (and, later, multiple
 * open workspaces) get isolated instances instead of sharing hidden global
 * state.
 *
 * The cache is invalidated by subscribing to the repository, not by polling and
 * not by asking callers to remember: a write through
 * `connectionsRepository.create()` is visible to the next `list()` with no
 * restart and no explicit refresh, which is M1-1's third acceptance criterion.
 */
export function createConnectionRegistry(db: Database.Database): ConnectionRegistry {
  let cache: { usable: ProviderConnection[]; unusable: UnusableConnection[] } | undefined;

  const unsubscribe = onConnectionsChanged(db, () => {
    cache = undefined;
  });

  function load(): { usable: ProviderConnection[]; unusable: UnusableConnection[] } {
    if (cache) return cache;
    const usable: ProviderConnection[] = [];
    const unusable: UnusableConnection[] = [];
    for (const record of connectionsRepository.list(db)) {
      const parsed = parseRecord(record);
      if (parsed.ok) {
        usable.push(parsed.connection);
      } else {
        unusable.push({
          id: record.id,
          label: record.label,
          kind: record.kind,
          reason: parsed.reason,
        });
      }
    }
    cache = { usable, unusable };
    return cache;
  }

  return {
    list: () => [...load().usable],
    get: (id) => load().usable.find((connection) => connection.id === id),
    unusable: () => [...load().unusable],
    refresh: () => {
      cache = undefined;
    },
    close: unsubscribe,
  };
}
