import type Database from 'better-sqlite3';

// Folders the user has given CHIMERA read access to.
//
// Deliberately the plainest table in the store: a path and when it was granted.
// A grant is a permission, and a permission a person cannot read back and
// revoke in one action is not one they can meaningfully have given.

export interface FileGrant {
  path: string;
  grantedAt: string;
}

interface Row {
  path: string;
  granted_at: string;
}

export function list(db: Database.Database): FileGrant[] {
  return (db.prepare('SELECT path, granted_at FROM file_grants ORDER BY path').all() as Row[]).map(
    (row) => ({ path: row.path, grantedAt: row.granted_at }),
  );
}

/** Granting a folder twice is granting it once. */
export function grant(db: Database.Database, folder: string): FileGrant {
  const grantedAt = new Date().toISOString();
  db.prepare(
    'INSERT INTO file_grants (path, granted_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING',
  ).run(folder, grantedAt);
  return { path: folder, grantedAt };
}

export function revoke(db: Database.Database, folder: string): boolean {
  return db.prepare('DELETE FROM file_grants WHERE path = ?').run(folder).changes > 0;
}
