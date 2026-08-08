import { Entry } from '@napi-rs/keyring';
import { randomUUID } from 'node:crypto';

const SERVICE_NAME = 'chimera';

export type VaultScope = 'connection' | 'licence';

// Nominal/branded type distinct from `string` — see docs/ARCHITECTURE.md
// section 5: a repository call site that tries to pass a raw key string
// instead of a vault handle fails to compile. TypeScript branding is
// compile-time only, so getSecret/deleteSecret still runtime-check the
// shape below as defence in depth for a value arriving via IPC, where
// nominal typing doesn't survive serialization (docs/ARCHITECTURE.md
// section 5, same paragraph).
declare const authRefBrand: unique symbol;
export type AuthRef = string & { readonly [authRefBrand]: true };

// docs/SECURITY.md section 3: "vault:<scope>:<uuid>", scope one of the two
// current callers. Extending this union is a deliberate, visible change,
// not a silent gap.
const AUTH_REF_PATTERN =
  /^vault:(connection|licence):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Stand-in for docs/ARCHITECTURE.md's VaultError, which packages/core/src/
// errors.ts doesn't define until M0-7 (this ticket lands first — M0-6
// depends only on M0-1). M0-7's own ticket text expects vault.ts to throw
// the real VaultError; that swap happens there, replacing this class,
// deliberately not before — see docs/ROADMAP.md M0-7.
export class VaultOperationError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'VaultOperationError';
    this.code = code;
    this.details = details;
  }
}

function assertAuthRef(value: string): asserts value is AuthRef {
  if (!AUTH_REF_PATTERN.test(value)) {
    // Never include `value` itself in `details` — logging.ts-style
    // redaction can't help here since this error's whole payload IS the
    // suspect value; only its shape is safe to report.
    throw new VaultOperationError('VAULT_INVALID_HANDLE', 'Value is not a valid vault handle', {
      length: value.length,
    });
  }
}

export function setSecret(scope: VaultScope, value: string): AuthRef {
  const handle = `vault:${scope}:${randomUUID()}`;
  try {
    new Entry(SERVICE_NAME, handle).setPassword(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new VaultOperationError(
      'VAULT_WRITE_FAILED',
      `Failed to write to OS keychain: ${message}`,
    );
  }
  return handle as AuthRef;
}

export function getSecret(handle: AuthRef): string | undefined {
  assertAuthRef(handle);
  let value: string | null;
  try {
    value = new Entry(SERVICE_NAME, handle).getPassword();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new VaultOperationError(
      'VAULT_READ_FAILED',
      `Failed to read from OS keychain: ${message}`,
      {
        handle,
      },
    );
  }
  return value ?? undefined;
}

export function deleteSecret(handle: AuthRef): void {
  assertAuthRef(handle);
  try {
    new Entry(SERVICE_NAME, handle).deletePassword();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new VaultOperationError(
      'VAULT_DELETE_FAILED',
      `Failed to delete from OS keychain: ${message}`,
      { handle },
    );
  }
}
