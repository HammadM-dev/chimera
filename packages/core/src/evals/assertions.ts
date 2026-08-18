// M9-2's golden tests: what a run has to produce for an automation to count as
// working.
//
// The assertion vocabulary is deliberately small and declared, for the third
// time in this codebase and the same reason as the other two: an eval is data
// in a saved file, a file gets shared, and an assertion language with an
// `eval()` in it is a code-execution surface with a reassuring name.

export type AssertOp = 'exists' | 'equals' | 'contains' | 'matches' | 'gte' | 'lte' | 'length';

export interface Assertion {
  /** Dotted path into the run's output — `total`, `exceptions[0].reason`, or empty for the whole thing. */
  path: string;
  op: AssertOp;
  /** Compared as text for the text ops, as a number for the numeric ones. */
  value: string;
}

export interface EvalCase {
  id: string;
  name: string;
  /** What the automation is told for this case. Replaces the brief's instruction. */
  input: string;
  /**
   * What the stand-in model answers, so the eval tests the automation rather
   * than the weather. A case with no script gets the mock provider's default.
   */
  scriptedAnswer: string;
  assertions: Assertion[];
}

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  /** What was actually there, for the failure line. */
  actual: string;
}

/**
 * Reads a dotted path out of a value.
 *
 * Undefined for anything missing, which every op then treats as a failure
 * except `exists`, whose whole job is to say so.
 */
export function readPath(value: unknown, path: string): unknown {
  if (path.trim() === '') return value;

  let current: unknown = value;
  for (const rawSegment of path.split('.')) {
    const match = /^([^[]*)((\[\d+\])*)$/.exec(rawSegment.trim());
    if (!match) return undefined;

    const [, key = '', indexes = ''] = match;
    if (key !== '') {
      if (current === null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[key];
    }

    for (const indexToken of indexes.match(/\d+/g) ?? []) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(indexToken)];
    }
  }
  return current;
}

/** The output as something a path can be read out of: JSON if it is JSON, else text. */
export function parseOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function asText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function checkAssertion(assertion: Assertion, output: unknown): AssertionResult {
  const found = readPath(output, assertion.path);
  const actual = asText(found);
  const expected = assertion.value.trim();

  // Nothing there fails every op, including the ones that would otherwise say
  // yes by accident: `lte 1` against a missing value reads the empty string as
  // zero, and an assertion that passes because the field is absent is worse
  // than no assertion at all.
  if (found === undefined || found === null) {
    return { assertion, passed: false, actual: '' };
  }

  let passed = false;
  switch (assertion.op) {
    case 'exists':
      passed = found !== undefined && found !== null && actual !== '';
      break;
    case 'equals':
      passed = actual.trim() === expected;
      break;
    case 'contains':
      passed = actual.toLowerCase().includes(expected.toLowerCase());
      break;
    case 'matches':
      try {
        passed = new RegExp(assertion.value).test(actual);
      } catch {
        // A malformed pattern fails the assertion rather than the run. The
        // pattern came out of a saved file, and a bad one is a failing test,
        // not a crash.
        passed = false;
      }
      break;
    case 'gte':
    case 'lte': {
      const numeric = typeof found === 'number' ? found : Number(actual);
      const target = Number(expected);
      passed =
        Number.isFinite(numeric) &&
        Number.isFinite(target) &&
        (assertion.op === 'gte' ? numeric >= target : numeric <= target);
      break;
    }
    case 'length': {
      const size = Array.isArray(found)
        ? found.length
        : typeof found === 'string'
          ? found.length
          : NaN;
      passed = Number.isFinite(size) && size === Number(expected);
      break;
    }
  }

  return { assertion, passed, actual: actual.slice(0, 200) };
}

export interface EvalOutcome {
  caseId: string;
  name: string;
  passed: boolean;
  results: AssertionResult[];
  /** Set when the run itself did not finish — a failed eval, with a different reason. */
  runProblem: string;
}

/** Every assertion in a case, all of them, against one run's output. */
export function checkCase(evalCase: EvalCase, output: string, runProblem = ''): EvalOutcome {
  const parsed = parseOutput(output);
  const results = evalCase.assertions.map((assertion) => checkAssertion(assertion, parsed));

  return {
    caseId: evalCase.id,
    name: evalCase.name,
    // A run that did not finish fails whatever its partial output happens to
    // satisfy: an automation that halts halfway is not passing its tests.
    passed: runProblem === '' && results.every((result) => result.passed),
    results,
    runProblem,
  };
}
