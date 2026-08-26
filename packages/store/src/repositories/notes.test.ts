import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.ts';
import * as notes from './notes.ts';

const migrationsDir = path.join(import.meta.dirname, '..', 'migrations');

function withDb(body: (db: ReturnType<typeof openDatabase>) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'chimera-notes-'));
  const db = openDatabase({ dbPath: path.join(dir, 'chimera.sqlite'), migrationsDir });
  try {
    body(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a note and a reminder are the same row with and without a time', () => {
  withDb((db) => {
    const note = notes.create(db, { kind: 'note', title: 'Renewal terms' });
    assert.equal(note.dueAt, null);

    const reminder = notes.create(db, {
      kind: 'reminder',
      title: 'Chase the invoice',
      dueAt: '2026-09-01T09:00:00.000Z',
    });
    assert.equal(reminder.dueAt, '2026-09-01T09:00:00.000Z');
  });
});

test('a note cannot carry a due date, whatever the caller passes', () => {
  // Enforced here rather than trusted from the caller, so "what is due" and
  // "what is a reminder" cannot disagree. An agent writing through the tool
  // server is a caller like any other.
  withDb((db) => {
    const note = notes.create(db, {
      kind: 'note',
      title: 'Not a reminder',
      dueAt: '2026-09-01T09:00:00.000Z',
    });
    assert.equal(note.dueAt, null);
    assert.equal(notes.due(db, '2027-01-01T00:00:00.000Z').length, 0);
  });
});

test('outstanding comes before done, and the soonest due comes first', () => {
  // The order the question "what needs doing" wants.
  withDb((db) => {
    const later = notes.create(db, {
      kind: 'reminder',
      title: 'Later',
      dueAt: '2026-12-01T09:00:00.000Z',
    });
    notes.create(db, { kind: 'reminder', title: 'Sooner', dueAt: '2026-09-01T09:00:00.000Z' });
    notes.create(db, { kind: 'note', title: 'No date' });
    notes.update(db, later.id, { done: true });

    assert.deepEqual(
      notes.list(db).map((one) => one.title),
      ['Sooner', 'No date', 'Later'],
    );
    // The done one is last whatever its date, which is the point of the first
    // sort key: yesterday's finished reminder must not sit above today's open
    // one.
    assert.equal(notes.list(db).at(-1)?.id, later.id);
  });
});

test('ticking something off records when, and untucking clears it', () => {
  withDb((db) => {
    const one = notes.create(db, { kind: 'note', title: 'Something' });
    assert.equal(one.doneAt, null);

    const done = notes.update(db, one.id, { done: true });
    assert.ok(done?.doneAt !== null, 'completing should record a time');

    const undone = notes.update(db, one.id, { done: false });
    assert.equal(undone?.doneAt, null);
  });
});

test('only what is due is due', () => {
  // What anything wanting to nudge somebody reads. A reminder for next month
  // is not a thing to raise today.
  withDb((db) => {
    notes.create(db, { kind: 'reminder', title: 'Past', dueAt: '2026-01-01T00:00:00.000Z' });
    notes.create(db, { kind: 'reminder', title: 'Future', dueAt: '2027-01-01T00:00:00.000Z' });
    notes.create(db, { kind: 'note', title: 'Undated' });

    assert.deepEqual(
      notes.due(db, '2026-06-01T00:00:00.000Z').map((one) => one.title),
      ['Past'],
    );
  });
});

test('something ticked off stops being due', () => {
  withDb((db) => {
    const one = notes.create(db, {
      kind: 'reminder',
      title: 'Chase it',
      dueAt: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(notes.due(db, '2026-06-01T00:00:00.000Z').length, 1);
    notes.update(db, one.id, { done: true });
    assert.equal(notes.due(db, '2026-06-01T00:00:00.000Z').length, 0);
  });
});

test('who wrote it travels with it', () => {
  // A reminder a person set and one an automation set are not the same claim
  // on somebody's attention, and the board says which is which.
  withDb((db) => {
    const mine = notes.create(db, { kind: 'note', title: 'Mine' });
    const theirs = notes.create(db, { kind: 'note', title: 'Theirs', source: 'assistant' });
    assert.equal(mine.source, 'user');
    assert.equal(theirs.source, 'assistant');
  });
});

test('turning a reminder into a note drops its date', () => {
  withDb((db) => {
    const one = notes.create(db, {
      kind: 'reminder',
      title: 'Was a reminder',
      dueAt: '2026-09-01T09:00:00.000Z',
    });
    assert.equal(notes.update(db, one.id, { kind: 'note' })?.dueAt, null);
  });
});

test('updating something that is not there says so rather than inventing it', () => {
  withDb((db) => {
    assert.equal(notes.update(db, 'no-such-note', { title: 'x' }), undefined);
    assert.equal(notes.remove(db, 'no-such-note').removed, false);
  });
});
