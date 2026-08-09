import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChimeraError,
  GovernorLimitError,
  ProviderError,
  ProviderAuthError,
  ProviderRateLimitError,
  ToolError,
  ToolAllowlistError,
  ToolExecutionError,
  ValidationError,
  VaultError,
  SidecarError,
} from '@chimera/errors';

// "Throwing each subclass and catching it at a simulated IPC boundary
// produces the exact { code, message, details } shape" — docs/ROADMAP.md
// M0-7. One table entry per subclass named in the kernel.
const CASES: Array<{
  name: string;
  build: () => ChimeraError;
  expectedCode: string;
  expectedInstanceOf: (new (...args: never[]) => Error)[];
}> = [
  {
    name: 'ChimeraError (base)',
    build: () => new ChimeraError('BASE_CODE', 'base message', { k: 'v' }),
    expectedCode: 'BASE_CODE',
    expectedInstanceOf: [ChimeraError],
  },
  {
    name: 'GovernorLimitError',
    build: () =>
      new GovernorLimitError('GOVERNOR_BUDGET_EXCEEDED', 'budget exceeded', { limitUsd: 1 }),
    expectedCode: 'GOVERNOR_BUDGET_EXCEEDED',
    expectedInstanceOf: [ChimeraError, GovernorLimitError],
  },
  {
    name: 'ProviderError (base)',
    build: () => new ProviderError('PROVIDER_UNREACHABLE', 'unreachable', { connectionId: 'c1' }),
    expectedCode: 'PROVIDER_UNREACHABLE',
    expectedInstanceOf: [ChimeraError, ProviderError],
  },
  {
    name: 'ProviderAuthError',
    build: () => new ProviderAuthError('auth failed', { connectionId: 'c1' }),
    expectedCode: 'PROVIDER_AUTH_FAILED',
    expectedInstanceOf: [ChimeraError, ProviderError, ProviderAuthError],
  },
  {
    name: 'ProviderRateLimitError',
    build: () => new ProviderRateLimitError('rate limited', { retryAfterMs: 500 }),
    expectedCode: 'PROVIDER_RATE_LIMITED',
    expectedInstanceOf: [ChimeraError, ProviderError, ProviderRateLimitError],
  },
  {
    name: 'ToolError (base)',
    build: () => new ToolError('TOOL_UNKNOWN', 'unknown tool', { toolId: 't1' }),
    expectedCode: 'TOOL_UNKNOWN',
    expectedInstanceOf: [ChimeraError, ToolError],
  },
  {
    name: 'ToolAllowlistError',
    build: () => new ToolAllowlistError('not allowlisted', { toolId: 't1', roleId: 'r1' }),
    expectedCode: 'TOOL_NOT_ALLOWLISTED',
    expectedInstanceOf: [ChimeraError, ToolError, ToolAllowlistError],
  },
  {
    name: 'ToolExecutionError',
    build: () => new ToolExecutionError('execution failed', { toolId: 't1' }),
    expectedCode: 'TOOL_EXECUTION_FAILED',
    expectedInstanceOf: [ChimeraError, ToolError, ToolExecutionError],
  },
  {
    name: 'ValidationError',
    build: () =>
      new ValidationError('SCHEMA_RULE_7_VIOLATION', 'missing approval node', { nodeId: 'n1' }),
    expectedCode: 'SCHEMA_RULE_7_VIOLATION',
    expectedInstanceOf: [ChimeraError, ValidationError],
  },
  {
    name: 'VaultError',
    build: () =>
      new VaultError('VAULT_WRITE_FAILED', 'write failed', { handle: 'vault:connection:x' }),
    expectedCode: 'VAULT_WRITE_FAILED',
    expectedInstanceOf: [ChimeraError, VaultError],
  },
  {
    name: 'SidecarError',
    build: () => new SidecarError('SIDECAR_TIMEOUT', 'sidecar timed out', { commandId: 'cmd1' }),
    expectedCode: 'SIDECAR_TIMEOUT',
    expectedInstanceOf: [ChimeraError, SidecarError],
  },
];

for (const { name, build, expectedCode, expectedInstanceOf } of CASES) {
  test(`${name}: instanceof chain and toWireFormat() shape`, () => {
    let caught: unknown;
    try {
      throw build();
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof ChimeraError, `${name} must be a ChimeraError`);
    for (const ctor of expectedInstanceOf) {
      assert.ok(caught instanceof ctor, `${name} must be instanceof ${ctor.name}`);
    }

    const wire = (caught as ChimeraError).toWireFormat();
    assert.equal(typeof wire.code, 'string');
    assert.equal(wire.code, expectedCode);
    assert.equal(typeof wire.message, 'string');
    assert.equal(typeof wire.details, 'object');
    assert.deepEqual(Object.keys(wire).sort(), ['code', 'details', 'message']);
  });
}

test('details defaults to an empty object, not undefined', () => {
  const err = new ChimeraError('X', 'y');
  assert.deepEqual(err.details, {});
  assert.deepEqual(err.toWireFormat().details, {});
});

test('name is set to the concrete subclass name, not the generic "Error"', () => {
  assert.equal(new VaultError('X', 'y').name, 'VaultError');
  assert.equal(new ToolAllowlistError('y').name, 'ToolAllowlistError');
});
