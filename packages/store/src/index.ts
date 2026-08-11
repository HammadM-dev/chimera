// packages/store — SQLite (WAL), forward-only migrations, and the credential vault.
// This is the only package permitted to hold raw SQL or touch a raw secret value.
// Populated starting M0-5 (db.ts) and M0-6 (vault.ts). See docs/ARCHITECTURE.md.
export { openDatabase } from './db.ts';
export type { OpenDatabaseOptions } from './db.ts';
export { setSecret, getSecret, deleteSecret, isAuthRef } from './vault.ts';
export type { AuthRef, VaultScope } from './vault.ts';

// One namespace per table family (docs/ARCHITECTURE.md section 3). Exported as
// a namespace rather than loose functions so a caller reads
// `connectionsRepository.create(db, ...)` and it is obvious at the call site
// which table is being written.
export * as connectionsRepository from './repositories/connections.ts';
export { onConnectionsChanged } from './repositories/connections.ts';
export type { ConnectionRecord, CreateConnectionInput } from './repositories/connections.ts';
export * as settingsRepository from './repositories/settings.ts';
export { onSettingsChanged } from './repositories/settings.ts';
export type { WorkspaceSettings } from './repositories/settings.ts';
export * as rolesRepository from './repositories/roles.ts';
export type { RoleRecord, UpsertRoleInput } from './repositories/roles.ts';
export * as nodeStatesRepository from './repositories/nodeStates.ts';
export type { NodeStateRecord } from './repositories/nodeStates.ts';
export * as runsRepository from './repositories/runs.ts';
export type { RunRecord, CreateRunInput } from './repositories/runs.ts';
