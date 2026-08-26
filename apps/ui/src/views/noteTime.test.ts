import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSource, readDue } from './noteTime.ts';

// Date arithmetic, which is where this kind of code goes wrong.

const NOW = new Date('2026-08-26T14:00:00');

test('a note has nothing to say about time', () => {
  assert.deepEqual(readDue(null, NOW), { label: '', late: false, today: false });
  assert.equal(readDue('', NOW).label, '');
});

test('today is today, even when the hour has passed', () => {
  // The case that makes counting in hours wrong. A reminder set for 9am and
  // read at 2pm the same day is due today; "5 hours ago" is technically true
  // and no use to anybody.
  const reading = readDue('2026-08-26T09:00:00', NOW);
  assert.equal(reading.label, 'due today');
  assert.equal(reading.late, false);
  assert.equal(reading.today, true);
});

test('yesterday is a day late, not twenty-nine hours', () => {
  const reading = readDue('2026-08-25T09:00:00', NOW);
  assert.equal(reading.label, '1 day late');
  assert.equal(reading.late, true);
});

test('lateness counts in whole days and reads in plain words', () => {
  assert.equal(readDue('2026-08-22T09:00:00', NOW).label, '4 days late');
  assert.equal(readDue('2026-08-27T09:00:00', NOW).label, 'due tomorrow');
  assert.equal(readDue('2026-08-29T09:00:00', NOW).label, 'due in 3 days');
});

test('past a week it gives the date, because "in 34 days" is not a plan', () => {
  const reading = readDue('2026-09-29T09:00:00', NOW);
  assert.match(reading.label, /^due /);
  assert.doesNotMatch(reading.label, /days/);
  assert.equal(reading.late, false);
});

test('a date that is not a date says nothing rather than showing NaN', () => {
  assert.deepEqual(readDue('not a date', NOW), { label: '', late: false, today: false });
});

test('who wrote it is described, never shown as an id', () => {
  // A run id is not something to put in front of a person.
  assert.equal(describeSource('user'), '');
  assert.equal(describeSource(''), '');
  assert.equal(describeSource('assistant'), 'left by the assistant');
  assert.equal(describeSource('0f8c2a41-6b3e-4f21-9d77-2a1b4c5e6f70'), 'left by an automation');
});
