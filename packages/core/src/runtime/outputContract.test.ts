import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError } from '@chimera/errors';
import {
  BUILTIN_SCHEMAS,
  enforceOutputContract,
  extractJson,
  type OutputContractSpec,
} from './outputContract.ts';
import { validateAgainstSchema } from './jsonSchema.ts';

const PLAN_SCHEMA = BUILTIN_SCHEMAS.plan;
if (!PLAN_SCHEMA) throw new Error('the plan schema is missing');

const GOOD_PLAN = JSON.stringify({
  steps: [{ action: 'read the file', check: 'the contents are non-empty' }],
});

test('a valid first answer costs exactly one attempt', async () => {
  let calls = 0;
  const result = await enforceOutputContract(
    { schema: PLAN_SCHEMA, onInvalid: 'repair_once' },
    async () => {
      calls += 1;
      return Promise.resolve(GOOD_PLAN);
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.value, JSON.parse(GOOD_PLAN));
});

test('repair_once makes exactly one repair attempt, and no more', async () => {
  const answers = ['{"steps": []}', GOOD_PLAN, GOOD_PLAN];
  let calls = 0;
  const repairs: (string | null)[] = [];

  const result = await enforceOutputContract(
    { schema: PLAN_SCHEMA, onInvalid: 'repair_once' },
    async (repair) => {
      repairs.push(repair);
      const answer = answers[calls] ?? '';
      calls += 1;
      return Promise.resolve(answer);
    },
  );

  // Once for the original, once for the repair. This is the criterion's
  // "called exactly twice for this node".
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(repairs[0], null);
  assert.match(repairs[1] ?? '', /did not satisfy the required output shape/);
  // The repair carries the actual violation, not a generic "try again".
  assert.match(repairs[1] ?? '', /minItems/);
});

test('a repair that also fails raises ValidationError carrying both attempts', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      enforceOutputContract({ schema: PLAN_SCHEMA, onInvalid: 'repair_once' }, async () => {
        calls += 1;
        return Promise.resolve(calls === 1 ? '{"steps": []}' : '{"steps": "not an array"}');
      }),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, 'OUTPUT_CONTRACT_UNSATISFIED');

      const attempts = err.details.attempts as { attempt: number; violations: unknown[] }[];
      // Both failures, not just the last: failing the same way twice and
      // failing differently each time are different problems, and the
      // difference is invisible if only the final attempt is reported.
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0]?.attempt, 1);
      assert.equal(attempts[1]?.attempt, 2);
      assert.ok((attempts[0]?.violations.length ?? 0) > 0);
      assert.ok((attempts[1]?.violations.length ?? 0) > 0);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test('fail makes no repair attempt at all', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      enforceOutputContract({ schema: PLAN_SCHEMA, onInvalid: 'fail' }, async () => {
        calls += 1;
        return Promise.resolve('{"steps": []}');
      }),
    ValidationError,
  );
  assert.equal(calls, 1);
});

test('repair_until_attempts respects maxAttempts rather than looping', async () => {
  let calls = 0;
  const contract: OutputContractSpec = {
    schema: PLAN_SCHEMA,
    onInvalid: 'repair_until_attempts',
    maxAttempts: 4,
  };

  await assert.rejects(
    () =>
      enforceOutputContract(contract, async () => {
        calls += 1;
        return Promise.resolve('nope');
      }),
    ValidationError,
  );
  // The cap is enforced here, locally, not by the Governor: it is a property of
  // the contract rather than of the run's money, and it has to hold before M3
  // exists at all.
  assert.equal(calls, 4);
});

test('repair_until_attempts without maxAttempts is bounded, not unbounded', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      enforceOutputContract(
        { schema: PLAN_SCHEMA, onInvalid: 'repair_until_attempts' },
        async () => {
          calls += 1;
          return Promise.resolve('nope');
        },
      ),
    ValidationError,
  );
  // An absent limit under a policy whose whole purpose is a limit is a mistake,
  // not permission to run forever.
  assert.equal(calls, 2);
});

test('an answer with no JSON at all is a violation, not a crash', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      enforceOutputContract({ schema: PLAN_SCHEMA, onInvalid: 'fail' }, async () => {
        calls += 1;
        return Promise.resolve('I have completed the plan, as requested.');
      }),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      const attempts = err.details.attempts as { violations: { message: string }[] }[];
      assert.match(attempts[0]?.violations[0]?.message ?? '', /no JSON value/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('JSON is found inside prose and code fences', () => {
  const wrapped = 'Here you go:\n```json\n{"steps": []}\n```\nLet me know.';
  const found = extractJson(wrapped);
  assert.equal(found.ok, true);
  if (found.ok) assert.deepEqual(found.value, { steps: [] });

  assert.equal(extractJson('nothing here').ok, false);
});

test('the validator reports paths a person can act on', () => {
  const violations = validateAgainstSchema({ steps: [{ action: 'do it' }] }, PLAN_SCHEMA);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.path, '/steps/0/check');
  assert.match(violations[0]?.message ?? '', /required/);
});

test('an unsupported schema keyword is reported, never silently ignored', () => {
  // A contract that quietly stops checking a field is worse than one that
  // refuses: the user believes a constraint is being enforced when it is not.
  const violations = validateAgainstSchema(
    { a: 1 },
    { type: 'object', oneOf: [{ type: 'object' }] },
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]?.message ?? '', /"oneOf" is not supported/);
});

test('the shipped schemas accept a well-formed value and reject a malformed one', () => {
  const cases: [string, unknown, unknown][] = [
    ['plan', { steps: [{ action: 'a', check: 'b' }] }, { steps: [] }],
    ['review', { findings: [{ file: 'a.ts', summary: 's' }] }, { findings: [{ file: 'a.ts' }] }],
    ['verification', { verified: true, evidence: 'saw it' }, { verified: 'yes', evidence: 'x' }],
    ['extraction', { records: [] }, { records: 'none' }],
  ];

  for (const [id, good, bad] of cases) {
    const schema = BUILTIN_SCHEMAS[id];
    assert.ok(schema, id);
    assert.deepEqual(validateAgainstSchema(good, schema), [], `${id} rejected a good value`);
    assert.ok(validateAgainstSchema(bad, schema).length > 0, `${id} accepted a bad value`);
  }
});
