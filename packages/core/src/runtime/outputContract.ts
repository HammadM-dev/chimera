import { ValidationError } from '@chimera/errors';
import type { JsonSchema } from '@chimera/providers';
import { describeViolations, validateAgainstSchema, type SchemaViolation } from './jsonSchema.ts';

// F2.4's structured output contracts. A node declares the shape it needs, the
// model's answer is validated against it, and a failure gets a bounded number
// of repair turns before the node fails cleanly.
//
// "Bounded" is the whole point. Retrying until the budget runs out turns a
// model that cannot produce the shape into a bill, and the attempt limit here
// is enforced locally rather than by the Governor: it is a property of the
// contract, not of the run's money, and it has to hold before M3 exists.

export type OnInvalid = 'repair_once' | 'repair_until_attempts' | 'fail';

export interface OutputContractSpec {
  schema: JsonSchema;
  onInvalid: OnInvalid;
  /** Total attempts allowed under `repair_until_attempts`, including the first. */
  maxAttempts?: number;
}

export interface ContractAttempt {
  attempt: number;
  raw: string;
  violations: SchemaViolation[];
}

export interface ContractResult {
  value: unknown;
  attempts: number;
}

/** The shipped schemas the starter roles reference by id. */
export const BUILTIN_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  plan: {
    type: 'object',
    required: ['steps'],
    properties: {
      steps: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['action', 'check'],
          properties: {
            action: { type: 'string', minLength: 1 },
            check: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
  review: {
    type: 'object',
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['file', 'summary'],
          properties: {
            file: { type: 'string', minLength: 1 },
            line: { type: 'integer' },
            summary: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
  verification: {
    type: 'object',
    required: ['verified', 'evidence'],
    properties: {
      verified: { type: 'boolean' },
      evidence: { type: 'string', minLength: 1 },
    },
  },
  extraction: {
    type: 'object',
    required: ['records'],
    properties: { records: { type: 'array' } },
  },
};

/**
 * The largest JSON value in a model's reply.
 *
 * Models wrap JSON in prose and fences however they feel; taking the outermost
 * braces is the pragmatic read. A reply with no JSON at all is a contract
 * violation like any other, not a crash.
 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const start = text.indexOf('{');
  const finish = text.lastIndexOf('}');
  const arrayStart = text.indexOf('[');
  const arrayFinish = text.lastIndexOf(']');

  const candidates: string[] = [];
  if (start !== -1 && finish > start) candidates.push(text.slice(start, finish + 1));
  if (arrayStart !== -1 && arrayFinish > arrayStart) {
    candidates.push(text.slice(arrayStart, arrayFinish + 1));
  }

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Try the next shape.
    }
  }
  return { ok: false };
}

function attemptLimit(contract: OutputContractSpec): number {
  switch (contract.onInvalid) {
    case 'fail':
      return 1;
    case 'repair_once':
      return 2;
    case 'repair_until_attempts':
      // Defaults to two rather than being unbounded: an absent limit under a
      // policy whose entire purpose is a limit is a mistake, not permission.
      return Math.max(1, contract.maxAttempts ?? 2);
  }
}

export function repairInstruction(raw: string, violations: readonly SchemaViolation[]): string {
  return [
    'Your previous answer did not satisfy the required output shape.',
    '',
    'Problems:',
    describeViolations(violations),
    '',
    'Return the corrected value as JSON and nothing else. Do not explain the correction.',
    '',
    'Your previous answer was:',
    raw,
  ].join('\n');
}

/**
 * Runs `attempt` until the contract is satisfied or the attempt limit is spent.
 *
 * `attempt` receives the repair instruction on every call after the first, and
 * null on the first. Keeping the model call outside this function is what lets
 * it be used from the agent loop, from a node runner, and from a test without
 * any of them sharing a provider.
 */
export async function enforceOutputContract(
  contract: OutputContractSpec,
  attempt: (repair: string | null, attemptIndex: number) => Promise<string>,
): Promise<ContractResult> {
  const limit = attemptLimit(contract);
  const history: ContractAttempt[] = [];
  let repair: string | null = null;

  for (let index = 0; index < limit; index += 1) {
    const raw = await attempt(repair, index);
    const parsed = extractJson(raw);

    if (!parsed.ok) {
      const violations: SchemaViolation[] = [
        { path: '', message: 'the answer contained no JSON value' },
      ];
      history.push({ attempt: index + 1, raw, violations });
      repair = repairInstruction(raw, violations);
      continue;
    }

    const violations = validateAgainstSchema(parsed.value, contract.schema);
    if (violations.length === 0) {
      return { value: parsed.value, attempts: index + 1 };
    }

    history.push({ attempt: index + 1, raw, violations });
    repair = repairInstruction(raw, violations);
  }

  // Every attempt's failures travel in `details`, not just the last one: an
  // agent that fails the same way twice and one that fails differently each
  // time are different problems, and the difference is invisible if only the
  // final attempt is reported.
  throw new ValidationError(
    'OUTPUT_CONTRACT_UNSATISFIED',
    `The output contract was not satisfied after ${String(history.length)} attempt(s).`,
    {
      onInvalid: contract.onInvalid,
      attempts: history.map((entry) => ({
        attempt: entry.attempt,
        violations: entry.violations,
        raw: entry.raw,
      })),
    },
  );
}
