import Database from 'better-sqlite3';

// Every vault handle a workspace holds, read straight off a database file.
//
// Exists because secrets outlive the workspace that referred to them: deleting
// the SQLite file leaves the OS keychain entries behind, and something has to
// be able to ask "what did this workspace own" in order to collect them. The
// E2E suite is the first caller and the reason this was written — it had
// accumulated 1,218 orphaned entries and choked the keyring it depended on —
// but removing a connection in the product has the same problem and the same
// answer.
//
// Opened read-only and without running migrations: this is asked about
// workspaces that are on their way out, including ones written by an older
// build, and a cleanup path that migrates what it is about to delete is a
// cleanup path that can fail on the way to tidying up.

export function vaultHandlesAt(dbPath: string): string[] {
  const handles = new Set<string>();
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }

  try {
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    );

    if (tables.has('connections')) {
      for (const row of db.prepare('SELECT auth_ref FROM connections').all() as {
        auth_ref: string;
      }[]) {
        if (row.auth_ref.startsWith('vault:')) handles.add(row.auth_ref);
      }
    }

    if (tables.has('workspace_settings')) {
      // Whatever JSON blobs the settings row holds. Read by scanning rather
      // than by naming `search_json`, so the next setting that stores a handle
      // is collected the day it is added instead of the day somebody notices
      // the keychain filling up again.
      const columns = (
        db.prepare('PRAGMA table_info(workspace_settings)').all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => name.endsWith('_json'));

      if (columns.length > 0) {
        const row = db
          .prepare(`SELECT ${columns.join(', ')} FROM workspace_settings WHERE id = 1`)
          .get() as Record<string, unknown> | undefined;
        for (const value of Object.values(row ?? {})) {
          if (typeof value !== 'string') continue;
          // The handle's own shape, found wherever in the blob it sits: these
          // are small, flat settings objects and a regex over the text needs no
          // knowledge of which key holds it.
          for (const handle of value.match(/vault:[a-z]+:[0-9a-f-]{36}/g) ?? []) {
            handles.add(handle);
          }
        }
      }
    }

    if (tables.has('plugins')) {
      for (const row of db.prepare('SELECT env_json, headers_json FROM plugins').all() as {
        env_json: string;
        headers_json: string;
      }[]) {
        for (const json of [row.env_json, row.headers_json]) {
          try {
            for (const value of Object.values(JSON.parse(json) as Record<string, string>)) {
              if (typeof value === 'string' && value.startsWith('vault:')) handles.add(value);
            }
          } catch {
            // A column that is not the JSON it should be holds no handle worth
            // collecting, and this is not the place to complain about it.
          }
        }
      }
    }
  } finally {
    db.close();
  }

  return [...handles];
}
