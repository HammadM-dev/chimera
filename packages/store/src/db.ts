import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface OpenDatabaseOptions {
  dbPath: string;
  // Explicit, not resolved internally via import.meta.url — this module
  // may end up bundled into apps/desktop's dist/main.js (M0-11), at which
  // point import.meta.url would point at the bundle's own location, not
  // packages/store/src/ (the exact class of bug fixed in M0-3 for
  // placeholder.html). The caller owns resolving this path correctly for
  // its own context; db.ts stays agnostic to how it's invoked.
  migrationsDir: string;
}

const MIGRATION_FILENAME = /^(\d{4})_.+\.sql$/;

export function openDatabase({ dbPath, migrationsDir }: OpenDatabaseOptions): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  );

  runPendingMigrations(db, migrationsDir);

  return db;
}

function runPendingMigrations(db: Database.Database, migrationsDir: string): void {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // NNNN_ prefix makes lexicographic order the same as numeric order

  const appliedIds = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as Array<{ id: number }>).map((row) => row.id),
  );

  for (const file of files) {
    const match = MIGRATION_FILENAME.exec(file);
    if (!match) {
      throw new Error(
        `Migration filename "${file}" does not match NNNN_description.sql (docs/ARCHITECTURE.md section 5)`,
      );
    }
    const id = Number(match[1]);
    if (appliedIds.has(id)) continue;

    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        id,
        file,
        new Date().toISOString(),
      );
    });
    applyMigration();
  }
}
