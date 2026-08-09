import { app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDatabase } from '@chimera/store';

// The single SQLite connection for the life of the application
// (docs/ARCHITECTURE.md section 3: the main process owns it). Held here rather
// than passed around so there is exactly one, and so nothing can open a second
// one against the same file and defeat WAL's single-writer assumption.
let db: Database.Database | undefined;

// dist/migrations, resolved against this module's own location in the built
// bundle. Same reasoning as windows.ts: app.getAppPath() reports the launched
// script's directory rather than the package root under some launch styles,
// and import.meta.url is unambiguous under all of them.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function openStore(): Database.Database {
  if (db) return db;
  db = openDatabase({
    dbPath: path.join(app.getPath('userData'), 'chimera.sqlite'),
    migrationsDir: path.join(moduleDir, 'migrations'),
  });
  return db;
}

export function getStore(): Database.Database {
  if (!db) {
    throw new Error('The store was read before openStore() ran — check main.ts ordering');
  }
  return db;
}

export function closeStore(): void {
  db?.close();
  db = undefined;
}
