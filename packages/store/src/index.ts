// packages/store — SQLite (WAL), forward-only migrations, and the credential vault.
// This is the only package permitted to hold raw SQL or touch a raw secret value.
// Populated starting M0-5 (db.ts) and M0-6 (vault.ts). See docs/ARCHITECTURE.md.
export { openDatabase } from './db.ts';
export type { OpenDatabaseOptions } from './db.ts';
export { setSecret, getSecret, deleteSecret } from './vault.ts';
export type { AuthRef, VaultScope } from './vault.ts';
