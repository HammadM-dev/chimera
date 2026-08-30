import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.ts';
import * as swarms from './swarms.ts';

const migrationsDir = path.join(import.meta.dirname, '..', 'migrations');

function withDb(body: (db: ReturnType<typeof openDatabase>) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'chimera-swarms-'));
  const db = openDatabase({ dbPath: path.join(dir, 'chimera.sqlite'), migrationsDir });
  try {
    body(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a swarm is its own seed, so replaying it rebuilds the same population', () => {
  withDb((db) => {
    const swarm = swarms.create(db, { name: 'Price rise', question: 'Should we raise prices?' });
    // Not a second value to keep in step with the id: the id *is* the seed.
    assert.equal(swarm.seed, swarm.id);
    assert.equal(swarms.get(db, swarm.id)?.seed, swarm.id);
  });
});

test('turns are numbered in order and belong to their thread', () => {
  withDb((db) => {
    const swarm = swarms.create(db, { name: 'A', question: 'q' });
    const other = swarms.create(db, { name: 'B', question: 'q' });

    swarms.addTurn(db, { swarmId: swarm.id, asked: 'first', answer: 'a', resultJson: '{}' });
    swarms.addTurn(db, { swarmId: other.id, asked: 'elsewhere', answer: 'b', resultJson: '{}' });
    swarms.addTurn(db, { swarmId: swarm.id, asked: 'second', answer: 'c', resultJson: '{}' });

    const turns = swarms.turnsOf(db, swarm.id);
    assert.deepEqual(
      turns.map((turn) => [turn.seq, turn.asked]),
      [
        [1, 'first'],
        [2, 'second'],
      ],
    );
  });
});

test('speaking to a thread moves it up the list', () => {
  withDb((db) => {
    const older = swarms.create(db, { name: 'Older', question: 'q' });
    const newer = swarms.create(db, { name: 'Newer', question: 'q' });

    // Newest first to begin with.
    assert.deepEqual(
      swarms.list(db).map((row) => row.name),
      ['Newer', 'Older'],
    );

    // A thread you have just worked on belongs at the top, which is what makes
    // the list read as "what I have been doing" rather than as a filing cabinet.
    swarms.addTurn(db, { swarmId: older.id, asked: 'again', answer: 'a', resultJson: '{}' });
    assert.deepEqual(
      swarms.list(db).map((row) => row.name),
      ['Older', 'Newer'],
    );
    assert.ok(newer.id !== older.id);
  });
});

test('a thread can be renamed, because the first name was a guess', () => {
  withDb((db) => {
    const swarm = swarms.create(db, { name: 'Untitled swarm', question: 'q' });
    swarms.rename(db, swarm.id, 'Q3 pricing');
    assert.equal(swarms.get(db, swarm.id)?.name, 'Q3 pricing');
  });
});

test('archiving hides a thread without losing what it said', () => {
  withDb((db) => {
    const swarm = swarms.create(db, { name: 'Gone', question: 'q' });
    swarms.addTurn(db, { swarmId: swarm.id, asked: 'x', answer: 'y', resultJson: '{}' });
    swarms.archive(db, swarm.id);

    assert.equal(swarms.list(db).length, 0);
    // Still readable by id, and its turns are still there. Archiving is
    // hiding, and a person who archived the wrong one has lost nothing.
    assert.equal(swarms.get(db, swarm.id)?.name, 'Gone');
    assert.equal(swarms.turnsOf(db, swarm.id).length, 1);
  });
});

test('a swarm an automation started can be found from the run that started it', () => {
  withDb((db) => {
    // The link behind the button on a swarm node: the canvas knows its run id
    // and needs the thread that run created.
    const made = swarms.create(db, { name: 'From a run', question: 'q', source: 'run-42' });
    assert.equal(swarms.bySource(db, 'run-42')?.id, made.id);
    assert.equal(swarms.bySource(db, 'run-none'), undefined);
  });
});

test('deleting a thread takes its turns with it', () => {
  withDb((db) => {
    const swarm = swarms.create(db, { name: 'A', question: 'q' });
    swarms.addTurn(db, { swarmId: swarm.id, asked: 'x', answer: 'y', resultJson: '{}' });

    db.prepare('DELETE FROM swarms WHERE id = ?').run(swarm.id);
    // The foreign key cascade, which only holds if the pragma is on — worth
    // asserting rather than assuming, since an orphaned turn is invisible.
    assert.equal(swarms.turnsOf(db, swarm.id).length, 0);
  });
});

test('threads made in the same millisecond still come back newest first', () => {
  // The clock is not fine enough to order these on a fast machine, and this
  // failed on a CI runner while passing everywhere it was written. Ordering by
  // timestamp alone leaves it to whatever SQLite feels like returning.
  withDb((db) => {
    const names = ['First', 'Second', 'Third', 'Fourth'];
    for (const name of names) swarms.create(db, { name, question: 'q' });

    assert.deepEqual(
      swarms.list(db).map((row) => row.name),
      [...names].reverse(),
    );
  });
});

test('speaking to a thread beats one created in the same millisecond', () => {
  // The case a `rowid` tiebreak gets wrong: touching an old thread does not
  // change its rowid, so the newer one stayed on top however recently the old
  // one had been used. Ordering has to come from a value that advances.
  withDb((db) => {
    const older = swarms.create(db, { name: 'Older', question: 'q' });
    swarms.create(db, { name: 'Newer', question: 'q' });

    swarms.addTurn(db, { swarmId: older.id, asked: 'again', answer: 'a', resultJson: '{}' });

    assert.deepEqual(
      swarms.list(db).map((row) => row.name),
      ['Older', 'Newer'],
    );
  });
});
