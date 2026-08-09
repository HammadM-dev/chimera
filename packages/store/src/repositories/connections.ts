import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ValidationError, VaultError } from '@chimera/core';
import { isAuthRef, type AuthRef } from '../vault.ts';

// The only code permitted to write SQL against the `connections` table
// (CLAUDE.md: "All SQLite access through packages/store"). Mirrors the table
// from migrations/0001_init.sql exactly; the runtime view with parsed
// capabilities and limits is packages/providers/src/registry.ts's job, which
// is also the layer that knows what a provider *kind* is. This repository
// deliberately does not — `kind` is stored as an opaque string so that
// packages/store never has to know the provider taxonomy, per the dependency
// direction in docs/ARCHITECTURE.md section 3.

export interface ConnectionRecord {
  id: string;
  label: string;
  kind: string;
  baseUrl: string | null;
  authRef: AuthRef;
  /** JSON blob; shape owned by packages/providers. Null until M1-3 populates it. */
  capabilitiesJson: string | null;
  healthState: string | null;
  createdAt: string;
}

export interface CreateConnectionInput {
  /** Generated when omitted. Accepted mainly so tests and imports can be deterministic. */
  id?: string;
  label: string;
  kind: string;
  baseUrl?: string | null;
  authRef: AuthRef;
  capabilitiesJson?: string | null;
  healthState?: string | null;
}

interface ConnectionRow {
  id: string;
  label: string;
  kind: string;
  base_url: string | null;
  auth_ref: string;
  capabilities_json: string | null;
  health_state: string | null;
  created_at: string;
}

// Change notification, scoped per database handle so two databases open in the
// same process (every test file does this) cannot invalidate each other's
// caches. WeakMap rather than Map so closing a database does not leak its
// listener set.
type ChangeListener = () => void;
const listeners = new WeakMap<Database.Database, Set<ChangeListener>>();

/**
 * Subscribe to mutations of the `connections` table on this database.
 *
 * Exists so a cached runtime view — packages/providers' connection registry —
 * can satisfy "reflects the current table contents without an app restart"
 * structurally, rather than by polling or by trusting every caller to
 * remember to refresh it.
 */
export function onConnectionsChanged(db: Database.Database, listener: ChangeListener): () => void {
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

function toRecord(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    baseUrl: row.base_url,
    // Rows already in the table were validated by create(); re-asserting the
    // brand on read would mean a corrupted row breaks every list() call
    // instead of just its own connection.
    authRef: row.auth_ref as AuthRef,
    capabilitiesJson: row.capabilities_json,
    healthState: row.health_state,
    createdAt: row.created_at,
  };
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(
      'CONNECTION_INVALID_FIELD',
      `Connection ${field} can't be empty. Enter a ${field} and try again.`,
      { field },
    );
  }
  return trimmed;
}

/**
 * The boundary that enforces CLAUDE.md's "secrets never leave the vault, not
 * into SQLite".
 *
 * TypeScript's `AuthRef` brand catches this at compile time, but branding is
 * erased at runtime, so anything arriving over IPC, out of a template import,
 * or through a deliberate `as never` cast reaches here unchecked. This is the
 * runtime half of that rule, and the reason it lives in the repository rather
 * than in the caller: there is exactly one place that writes this column, so
 * there is exactly one place to get it right.
 */
function requireVaultHandle(authRef: string): AuthRef {
  if (!isAuthRef(authRef)) {
    // `details` carries shape only — never the offending value. If this
    // rejection fired because a live API key was passed by mistake, putting it
    // in an error payload would defeat the check by writing the secret into
    // whatever logs or surfaces that error instead.
    throw new VaultError(
      'VAULT_RAW_SECRET_REJECTED',
      'Connection auth must be a vault handle, not a secret value. Store the secret with vault.setSecret first and pass the handle it returns.',
      { length: authRef.length },
    );
  }
  return authRef;
}

export function create(db: Database.Database, input: CreateConnectionInput): ConnectionRecord {
  const record: ConnectionRecord = {
    id: input.id ?? randomUUID(),
    label: requireNonEmpty(input.label, 'label'),
    kind: requireNonEmpty(input.kind, 'kind'),
    baseUrl: input.baseUrl ?? null,
    authRef: requireVaultHandle(input.authRef),
    capabilitiesJson: input.capabilitiesJson ?? null,
    healthState: input.healthState ?? 'unknown',
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO connections
       (id, label, kind, base_url, auth_ref, capabilities_json, health_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.label,
    record.kind,
    record.baseUrl,
    record.authRef,
    record.capabilitiesJson,
    record.healthState,
    record.createdAt,
  );

  notifyChanged(db);
  return record;
}

export function list(db: Database.Database): ConnectionRecord[] {
  const rows = db
    .prepare('SELECT * FROM connections ORDER BY created_at, id')
    .all() as ConnectionRow[];
  return rows.map(toRecord);
}

export function get(db: Database.Database, id: string): ConnectionRecord | undefined {
  const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as
    ConnectionRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function updateHealth(db: Database.Database, id: string, healthState: string): void {
  const result = db
    .prepare('UPDATE connections SET health_state = ? WHERE id = ?')
    .run(healthState, id);
  if (result.changes === 0) {
    throw new ValidationError('CONNECTION_NOT_FOUND', `No connection with id "${id}".`, { id });
  }
  notifyChanged(db);
}

export function updateCapabilities(
  db: Database.Database,
  id: string,
  capabilitiesJson: string | null,
): void {
  const result = db
    .prepare('UPDATE connections SET capabilities_json = ? WHERE id = ?')
    .run(capabilitiesJson, id);
  if (result.changes === 0) {
    throw new ValidationError('CONNECTION_NOT_FOUND', `No connection with id "${id}".`, { id });
  }
  notifyChanged(db);
}

export function remove(db: Database.Database, id: string): void {
  const result = db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  if (result.changes === 0) {
    throw new ValidationError('CONNECTION_NOT_FOUND', `No connection with id "${id}".`, { id });
  }
  notifyChanged(db);
}
