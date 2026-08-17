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
export type { NodeStateRecord, UpsertNodeStateInput } from './repositories/nodeStates.ts';
export * as runsRepository from './repositories/runs.ts';
export type { RunRecord, CreateRunInput } from './repositories/runs.ts';
export * as workspaceFactsRepository from './repositories/workspaceFacts.ts';
export type { WorkspaceFact } from './repositories/workspaceFacts.ts';
export * as tracesRepository from './repositories/traces.ts';
export type { TraceRecord, AppendTraceInput, TraceEventType } from './repositories/traces.ts';
export * as workflowsRepository from './repositories/workflows.ts';
export type { WorkflowSummary, WorkflowVersion } from './repositories/workflows.ts';
export { MODEL_TIERS } from './repositories/settings.ts';
export type { ModelTier, ModelTiers, TierBinding } from './repositories/settings.ts';
export * as blackboardRepository from './repositories/blackboard.ts';
export type { BlackboardEntry } from './repositories/blackboard.ts';
export * as deadLetterRepository from './repositories/deadLetter.ts';
export type { DeadLetterRecord } from './repositories/deadLetter.ts';
export * as memoriesRepository from './repositories/memories.ts';
export { MEMORY_KINDS } from './repositories/memories.ts';
export type { MemoryRecord, MemoryKind, WriteMemoryInput } from './repositories/memories.ts';
