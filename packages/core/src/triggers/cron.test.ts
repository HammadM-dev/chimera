import test from 'node:test';
import assert from 'node:assert/strict';
import { firedInLastMinute, nextFireAfter, parseCron } from './cron.ts';

// M9-1's scheduler arithmetic. A scheduler that misreads an expression fires at
// the wrong time forever and nobody notices for a week, so this is tested
// against the cases that actually differ between implementations.

function next(expression: string, fromIso: string): string | null {
  const { fields, problem } = parseCron(expression);
  assert.ok(fields, problem);
  const fired = nextFireAfter(fields, new Date(fromIso));
  return fired === null ? null : fired.toISOString();
}

test('every minute, every hour, and a fixed time', () => {
  assert.equal(next('* * * * *', '2026-03-01T09:15:30Z'), '2026-03-01T09:16:00.000Z');
  assert.equal(next('0 * * * *', '2026-03-01T09:15:00Z'), '2026-03-01T10:00:00.000Z');
  // Local time, because a person setting "9am" means their 9am.
  const fired = next('30 9 * * *', '2026-03-01T00:00:00Z');
  assert.ok(fired);
  assert.equal(new Date(fired).getHours(), 9);
  assert.equal(new Date(fired).getMinutes(), 30);
});

test('lists, ranges and steps', () => {
  assert.equal(next('0,30 * * * *', '2026-03-01T09:05:00Z'), '2026-03-01T09:30:00.000Z');
  assert.equal(next('*/15 * * * *', '2026-03-01T09:01:00Z'), '2026-03-01T09:15:00.000Z');

  // A range with a step counts from the start of the range: 1-9/2 is 1,3,5,7,9.
  const { fields } = parseCron('1-9/2 * * * *');
  assert.ok(fields);
  assert.deepEqual(
    [...fields.minutes].sort((a, b) => a - b),
    [1, 3, 5, 7, 9],
  );
});

test('names work for months and weekdays, and Sunday is both 0 and 7', () => {
  const week = parseCron('0 9 * * mon-fri').fields;
  assert.ok(week);
  assert.deepEqual(
    [...week.daysOfWeek].sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  );

  const sunday = parseCron('0 9 * * 7').fields;
  assert.ok(sunday);
  assert.equal(sunday.daysOfWeek.has(0), true);

  const march = parseCron('0 9 1 mar *').fields;
  assert.ok(march);
  assert.deepEqual([...march.months], [3]);
});

test('when both day fields are restricted, either one fires it', () => {
  // Cron's genuine oddity, and the one every reimplementation gets wrong:
  // "0 9 13 * 5" is the 13th *and* every Friday, not Friday the 13th.
  const { fields } = parseCron('0 9 13 * 5');
  assert.ok(fields);
  assert.equal(fields.bothDaysRestricted, true);

  // 2026-03-06 is a Friday; the 13th is also a Friday, so take a month where
  // they differ: the next fire from the 2nd should be Friday the 6th.
  const fired = nextFireAfter(fields, new Date(2026, 2, 2, 0, 0, 0));
  assert.ok(fired);
  assert.equal(fired.getDate(), 6);
});

test('an impossible date reports never rather than hanging', () => {
  // The 31st of February. A scheduler that looped forever looking for it would
  // hang the app; one that returned "soon" would lie.
  assert.equal(next('0 9 31 2 *', '2026-01-01T00:00:00Z'), null);
});

test('a malformed expression is refused with something a user can act on', () => {
  assert.match(parseCron('* * *').problem, /five parts/);
  assert.match(parseCron('61 * * * *').problem, /not a schedule/);
  assert.match(parseCron('* * * * bananas').problem, /not a schedule/);
  // Extended syntax this build deliberately does not implement, refused rather
  // than misread: `@daily` and `L` mean different things in different tools.
  assert.match(parseCron('@daily').problem, /five parts/);
  assert.match(parseCron('0 9 L * *').problem, /not a schedule/);
});

test('the ticker asks whether it fired in the minute that just ended', () => {
  const { fields } = parseCron('30 9 * * *');
  assert.ok(fields);

  // A ticker running at 09:30:07 must fire the 09:30 job…
  assert.equal(firedInLastMinute(fields, new Date(2026, 2, 2, 9, 30, 7)), true);
  // …and one running two minutes later must not, which is why the caller also
  // keeps a per-minute guard: between them, a ticker that runs three times a
  // minute fires the job once.
  assert.equal(firedInLastMinute(fields, new Date(2026, 2, 2, 9, 32, 0)), false);
  assert.equal(firedInLastMinute(fields, new Date(2026, 2, 2, 9, 29, 0)), false);
});

test('a schedule missed while the app was closed is not fired late', () => {
  // The other half of the same decision: this reports on the last minute, not
  // on everything since the app was last open. A nightly job that fired at
  // launch, six hours late, would be worse than one that waited for tonight.
  const { fields } = parseCron('0 3 * * *');
  assert.ok(fields);
  assert.equal(firedInLastMinute(fields, new Date(2026, 2, 2, 9, 0, 0)), false);
});
