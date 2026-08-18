import { Entry } from '@napi-rs/keyring';
import { randomUUID } from 'node:crypto';
import { VaultError } from '@chimera/errors';

const SERVICE_NAME = 'chimera';

// A plugin's credentials are secrets like any other: an MCP server for an
// email account holds the same kind of thing a provider connection does, and
// it goes in the same place rather than into the plugin's row.
export type VaultScope = 'connection' | 'licence' | 'plugin';

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
// Every scope in `VaultScope` appears here. They are two halves of one fact,
// and they were briefly not: `plugin` was added to the type and not to this
// pattern, so every plugin secret was written happily and refused on read — the
// plugin then ran with none of its environment, and the only symptom was a tool
// that did nothing. A test that checked the *effect* rather than the report is
// what caught it.
const AUTH_REF_PATTERN =
  /^vault:(connection|licence|plugin):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Exported so the repositories that persist handles (connections, licence)
// can reject a raw secret at their own write boundary without duplicating the
// pattern. Deliberately a *shape allowlist*, not a "does this look like an API
// key" blocklist: a blocklist has to be updated every time a provider invents
// a new key prefix, and it silently passes the ones nobody thought of. Only
// something already shaped like a vault handle gets through here.
export function isAuthRef(value: string): value is AuthRef {
  return AUTH_REF_PATTERN.test(value);
}

function assertAuthRef(value: string): asserts value is AuthRef {
  if (!isAuthRef(value)) {
    // Never include `value` itself in `details` — logging.ts-style
    // redaction can't help here since this error's whole payload IS the
    // suspect value; only its shape is safe to report.
    throw new VaultError('VAULT_INVALID_HANDLE', 'Value is not a valid vault handle', {
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
    throw new VaultError('VAULT_WRITE_FAILED', `Failed to write to OS keychain: ${message}`);
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
    throw new VaultError('VAULT_READ_FAILED', `Failed to read from OS keychain: ${message}`, {
      handle,
    });
  }
  return value ?? undefined;
}

export function deleteSecret(handle: AuthRef): void {
  assertAuthRef(handle);
  try {
    new Entry(SERVICE_NAME, handle).deletePassword();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new VaultError('VAULT_DELETE_FAILED', `Failed to delete from OS keychain: ${message}`, {
      handle,
    });
  }
}
