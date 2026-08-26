import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.ts';
import * as settings from './settings.ts';

// The models a workspace keeps at the top of its pickers.
//
// A workspace that connects OpenRouter gets four hundred models in a dropdown
// and the two anybody uses are somewhere in the middle. What matters here is
// that the list survives a restart and keeps the order somebody put it in.

const migrationsDir = path.join(import.meta.dirname, '..', 'migrations');

function withDb(body: (open: () => ReturnType<typeof openDatabase>) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'chimera-pinned-'));
  const dbPath = path.join(dir, 'chimera.sqlite');
  const opened: ReturnType<typeof openDatabase>[] = [];
  try {
    body(() => {
      const db = openDatabase({ dbPath, migrationsDir });
      opened.push(db);
      return db;
    });
  } finally {
    for (const db of opened) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a workspace starts with nothing pinned', () => {
  withDb((open) => {
    assert.deepEqual(settings.read(open()).pinnedModels, []);
  });
});

test('pins survive closing and reopening the workspace', () => {
  // The whole point. A pin that lasted until the next launch would be a
  // preference nobody could rely on.
  withDb((open) => {
    const first = open();
    settings.setPinnedModels(first, ['conn-1::claude-opus-5', 'conn-1::stealth/ox-alpha']);
    first.close();

    assert.deepEqual(settings.read(open()).pinnedModels, [
      'conn-1::claude-opus-5',
      'conn-1::stealth/ox-alpha',
    ]);
  });
});

test('the order somebody put them in is the order they come back in', () => {
  // Not sorted. "The ones I use" is a list a person curates, and re-ordering it
  // under them by name or price would be a different feature wearing this
  // one's name.
  withDb((open) => {
    const db = open();
    const order = ['conn-1::zeta', 'conn-1::alpha', 'conn-2::mid'];
    settings.setPinnedModels(db, order);
    assert.deepEqual(settings.read(db).pinnedModels, order);
  });
});

test('the same model pinned twice is stored once, keeping its first place', () => {
  withDb((open) => {
    const db = open();
    settings.setPinnedModels(db, ['a::one', 'b::two', 'a::one']);
    assert.deepEqual(settings.read(db).pinnedModels, ['a::one', 'b::two']);
  });
});
