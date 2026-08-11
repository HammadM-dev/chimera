import type { JsonSchema } from '@chimera/providers';

// A bounded JSON Schema validator.
//
// Deliberately not ajv. CLAUDE.md requires asking before adding a dependency,
// and this is the smallest thing that satisfies F2.4: the keywords below cover
// every construct docs/WORKFLOW_SCHEMA.md's own `outputContract` examples use.
// The subset is documented there rather than left to be discovered, and the
// validator fails *closed* on a keyword it does not implement — an unsupported
// keyword is reported as an error rather than silently ignored, because a
// contract that quietly stops checking a field is worse than one that refuses.
//
// If a real workflow needs draft-2020 in full, that is a concrete case for
// adding ajv, and it is a question for the project owner rather than a decision
// to take quietly here.

export interface SchemaViolation {
  /** JSON-pointer-ish path to the offending value, e.g. `/items/0/name`. */
  path: string;
  message: string;
}

const SUPPORTED = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'description',
  'title',
  'default',
  'examples',
  '$schema',
  'nullable',
]);

type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

function typeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'object';
  }
}

function matchesType(value: unknown, expected: JsonType): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path = '',
): SchemaViolation[] {
  const violations: SchemaViolation[] = [];

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) {
      violations.push({
        path,
        message: `Schema keyword "${keyword}" is not supported by this validator, so the value could not be checked.`,
      });
    }
  }

  const declaredType = schema.type;
  if (typeof declaredType === 'string') {
    if (!matchesType(value, declaredType as JsonType)) {
      violations.push({
        path,
        message: `expected ${declaredType}, got ${typeOf(value)}`,
      });
      // No point checking constraints of a type this value does not have.
      return violations;
    }
  } else if (Array.isArray(declaredType)) {
    const options = declaredType as JsonType[];
    if (!options.some((option) => matchesType(value, option))) {
      violations.push({
        path,
        message: `expected one of ${options.join(', ')}, got ${typeOf(value)}`,
      });
      return violations;
    }
  }

  if (schema.enum !== undefined && Array.isArray(schema.enum)) {
    const allowed = schema.enum;
    if (!allowed.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
      violations.push({ path, message: `expected one of ${JSON.stringify(allowed)}` });
    }
  }

  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    violations.push({ path, message: `expected ${JSON.stringify(schema.const)}` });
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      violations.push({ path, message: `shorter than minLength ${String(schema.minLength)}` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      violations.push({ path, message: `longer than maxLength ${String(schema.maxLength)}` });
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      violations.push({ path, message: `does not match pattern ${schema.pattern}` });
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      violations.push({ path, message: `below minimum ${String(schema.minimum)}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      violations.push({ path, message: `above maximum ${String(schema.maximum)}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      violations.push({ path, message: `fewer than minItems ${String(schema.minItems)}` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      violations.push({ path, message: `more than maxItems ${String(schema.maxItems)}` });
    }
    if (schema.items !== undefined && typeof schema.items === 'object') {
      value.forEach((item, index) => {
        violations.push(
          ...validateAgainstSchema(item, schema.items as JsonSchema, `${path}/${String(index)}`),
        );
      });
    }
  }

  if (typeOf(value) === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;

    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in record)) {
          violations.push({ path: `${path}/${key}`, message: 'required property is missing' });
        }
      }
    }

    for (const [key, child] of Object.entries(record)) {
      const childSchema = properties[key];
      if (childSchema) {
        violations.push(...validateAgainstSchema(child, childSchema, `${path}/${key}`));
      } else if (schema.additionalProperties === false) {
        violations.push({ path: `${path}/${key}`, message: 'unexpected property' });
      }
    }
  }

  return violations;
}

/** One line per violation, in the form a model can act on. */
export function describeViolations(violations: readonly SchemaViolation[]): string {
  return violations
    .map(
      (violation) => `- ${violation.path === '' ? '(root)' : violation.path}: ${violation.message}`,
    )
    .join('\n');
}
