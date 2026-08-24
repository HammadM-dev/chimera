import test from 'node:test';
import assert from 'node:assert/strict';
import { greeting, greetingFor } from './greeting.ts';

// The hour is the local hour on the machine in front of the person, which is
// the only hour that matters: somebody starting at six in the morning in
// Karachi should not be wished good evening because a server is in California.

test('every hour of the day gets a greeting that fits it', () => {
  const expected: [number, string][] = [
    [0, 'Still up'],
    [3, 'Still up'],
    [4, 'Still up'],
    [5, 'Good morning'],
    [9, 'Good morning'],
    [11, 'Good morning'],
    [12, 'Good afternoon'],
    [17, 'Good afternoon'],
    [18, 'Good evening'],
    [21, 'Good evening'],
    [22, 'Working late'],
    [23, 'Working late'],
  ];

  for (const [hour, want] of expected) {
    assert.equal(greeting(hour), want, `hour ${String(hour)}`);
  }
});

test('no hour falls through to nothing', () => {
  for (let hour = 0; hour < 24; hour += 1) {
    assert.notEqual(greeting(hour).trim(), '', `hour ${String(hour)} had no greeting`);
  }
});

test('one in the morning is not the evening', () => {
  // Three bands used to cover eighteen hundred to five hundred with one line,
  // so a third of the day was told "Good evening" — including all of the night.
  assert.notEqual(greeting(1), greeting(19));
});

test('a name is added with a comma, and its absence leaves none behind', () => {
  assert.equal(greetingFor(9, 'Hammad'), 'Good morning, Hammad');
  assert.equal(greetingFor(9, ''), 'Good morning');
  // A field somebody tabbed through is empty, whatever it contains.
  assert.equal(greetingFor(9, '   '), 'Good morning');
  assert.equal(greetingFor(23, ' Hammad '), 'Working late, Hammad');
});
