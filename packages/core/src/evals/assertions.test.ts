import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAssertion, checkCase, readPath } from './assertions.ts';
import type { EvalCase } from './assertions.ts';

// M9-2. The assertion vocabulary, and what each op does with something missing.

test('a path reads through objects and arrays, and is undefined for what is not there', () => {
  const value = { total: 3, exceptions: [{ reason: 'no PO number' }] };
  assert.equal(readPath(value, 'total'), 3);
  assert.equal(readPath(value, 'exceptions[0].reason'), 'no PO number');
  assert.equal(readPath(value, ''), value);
  assert.equal(readPath(value, 'exceptions[4].reason'), undefined);
  assert.equal(readPath(value, 'nothing.here'), undefined);
});

test('each op decides the same way about a missing value: it fails', () => {
  const output = { total: 3 };
  for (const op of ['exists', 'equals', 'contains', 'matches', 'gte', 'lte', 'length'] as const) {
    const result = checkAssertion({ path: 'missing', op, value: '1' }, output);
    assert.equal(result.passed, false, `${op} passed on a missing value`);
  }
});

test('the text ops compare what a person would expect', () => {
  const output = { note: 'Invoice 4471 is missing a PO number.' };
  assert.equal(checkAssertion({ path: 'note', op: 'contains', value: 'PO' }, output).passed, true);
  assert.equal(
    checkAssertion({ path: 'note', op: 'matches', value: '\\d{4}' }, output).passed,
    true,
  );
  // A malformed pattern is a failing assertion, not a thrown error: it came out
  // of a saved file, and a bad test should fail rather than break the runner.
  assert.equal(checkAssertion({ path: 'note', op: 'matches', value: '([' }, output).passed, false);
});

test('the numeric ops work on numbers and on numeric text', () => {
  assert.equal(checkAssertion({ path: 'n', op: 'gte', value: '3' }, { n: 3 }).passed, true);
  assert.equal(checkAssertion({ path: 'n', op: 'lte', value: '2' }, { n: 3 }).passed, false);
  assert.equal(checkAssertion({ path: 'n', op: 'gte', value: '3' }, { n: '4' }).passed, true);
  assert.equal(
    checkAssertion({ path: 'xs', op: 'length', value: '2' }, { xs: [1, 2] }).passed,
    true,
  );
});

test('plain text output is assertable without being JSON', () => {
  const outcome = checkCase(
    {
      id: 'c1',
      name: 'says what it found',
      input: 'go',
      scriptedAnswer: '',
      assertions: [{ path: '', op: 'contains', value: 'ready' }],
    },
    'The report is ready to send.',
  );
  assert.equal(outcome.passed, true);
});

test('a run that did not finish fails whatever its half-output satisfies', () => {
  const evalCase: EvalCase = {
    id: 'c2',
    name: 'finishes',
    input: 'go',
    scriptedAnswer: '',
    assertions: [{ path: '', op: 'contains', value: 'ready' }],
  };

  const outcome = checkCase(evalCase, 'The report is ready', 'Stopped: the run reached its cap.');
  assert.equal(outcome.passed, false);
  assert.match(outcome.runProblem, /reached its cap/);
  // The assertion itself did pass — the case still fails, and the report says
  // which of the two things went wrong.
  assert.equal(outcome.results[0]?.passed, true);
});
