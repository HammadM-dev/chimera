import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { vaultHandlesAt } from './vaultHandles.ts';

// Reading a workspace's vault handles back off a database file.
//
// This exists because the E2E suite filled the OS keyring with 1,218 orphaned
// secrets and choked the daemon it depended on. The first version of the fix
// did not work at all — it `require`d an ES module, threw, and was swallowed by
// the catch meant for a missing workspace — so the leak carried on while the
// commit message said otherwise. Hence a test that opens a real file.

function workspace(build: (db: Database.Database) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-handles-'));
  const dbPath = path.join(dir, 'chimera.sqlite');
  const db = new Database(dbPath);
  build(db);
  db.close();
  return dbPath;
}

test('every connection and plugin handle is found', () => {
  const dbPath = workspace((db) => {
    db.exec('CREATE TABLE connections (auth_ref TEXT NOT NULL)');
    db.exec('CREATE TABLE plugins (env_json TEXT NOT NULL, headers_json TEXT NOT NULL)');
    db.prepare('INSERT INTO connections VALUES (?)').run('vault:connection:a');
    db.prepare('INSERT INTO connections VALUES (?)').run('vault:connection:b');
    db.prepare('INSERT INTO plugins VALUES (?, ?)').run(
      JSON.stringify({ TOKEN: 'vault:plugin:c' }),
      JSON.stringify({ Authorization: 'vault:plugin:d' }),
    );
  });

  assert.deepEqual(vaultHandlesAt(dbPath).sort(), [
    'vault:connection:a',
    'vault:connection:b',
    'vault:plugin:c',
    'vault:plugin:d',
  ]);
});

test('anything that is not a handle is left alone', () => {
  const dbPath = workspace((db) => {
    db.exec('CREATE TABLE connections (auth_ref TEXT NOT NULL)');
    db.prepare('INSERT INTO connections VALUES (?)').run('not-a-handle');
  });
  assert.deepEqual(vaultHandlesAt(dbPath), []);
});

test('a workspace from an older build, with no plugins table, still reports its connections', () => {
  const dbPath = workspace((db) => {
    db.exec('CREATE TABLE connections (auth_ref TEXT NOT NULL)');
    db.prepare('INSERT INTO connections VALUES (?)').run('vault:connection:old');
  });
  assert.deepEqual(vaultHandlesAt(dbPath), ['vault:connection:old']);
});

test('a database that is not there answers with nothing rather than throwing', () => {
  assert.deepEqual(vaultHandlesAt(path.join(os.tmpdir(), 'chimera-nope-9f2c.sqlite')), []);
});

test('a plugin column that is not JSON does not stop the rest being collected', () => {
  const dbPath = workspace((db) => {
    db.exec('CREATE TABLE connections (auth_ref TEXT NOT NULL)');
    db.exec('CREATE TABLE plugins (env_json TEXT NOT NULL, headers_json TEXT NOT NULL)');
    db.prepare('INSERT INTO connections VALUES (?)').run('vault:connection:a');
    db.prepare('INSERT INTO plugins VALUES (?, ?)').run('not json', '{}');
  });
  assert.deepEqual(vaultHandlesAt(dbPath), ['vault:connection:a']);
});
