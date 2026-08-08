import test from 'node:test';
import assert from 'node:assert/strict';
import { Entry } from '@napi-rs/keyring';
import { VaultError } from '@chimera/core';
import { setSecret, getSecret, deleteSecret, type AuthRef } from './vault.ts';

// Real OS keychain, not a mock — the ticket asks for this to be "skipped,
// not faked" when no keychain daemon is available (e.g. some CI runners).
// Probed once, up front, with a throwaway entry cleaned up immediately.
function probeKeychainAvailable(): boolean {
  try {
    const probe = new Entry('chimera-vault-probe', `probe-${Date.now()}`);
    probe.setPassword('probe');
    probe.deletePassword();
    return true;
  } catch {
    return false;
  }
}

const keychainAvailable = probeKeychainAvailable();
const skip = keychainAvailable ? false : 'no OS keychain daemon available in this environment';

test('set then get round-trips the value through the real OS keychain', { skip }, () => {
  const handle = setSecret('connection', 'sk-test-round-trip-value');
  try {
    assert.equal(getSecret(handle), 'sk-test-round-trip-value');
  } finally {
    deleteSecret(handle);
  }
});

test('delete then get returns undefined, not a stale value', { skip }, () => {
  const handle = setSecret('licence', 'sk-test-delete-then-get');
  deleteSecret(handle);
  assert.equal(getSecret(handle), undefined);
});

test(
  'the returned handle matches the vault:<scope>:<uuid> format and never embeds the value',
  { skip },
  () => {
    const canary = 'sk-canary-should-never-appear-in-a-handle';
    const handle = setSecret('connection', canary);
    try {
      assert.match(
        handle,
        /^vault:connection:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      assert.ok(!handle.includes(canary), 'handle must not contain the secret value itself');
    } finally {
      deleteSecret(handle);
    }
  },
);

test(
  'a canary secret never appears in captured console output during a full set/get/delete cycle',
  { skip },
  () => {
    const canary = `sk-canary-${randomSuffix()}-must-not-leak-to-any-log-line`;
    const captured: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => captured.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => captured.push(args.map(String).join(' '));

    let handle: AuthRef | undefined;
    try {
      handle = setSecret('connection', canary);
      getSecret(handle);
      deleteSecret(handle);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      if (handle) {
        try {
          deleteSecret(handle);
        } catch {
          // already deleted above in the success path; ignore if so
        }
      }
    }

    const joined = captured.join('\n');
    assert.ok(!joined.includes(canary), `canary secret leaked into console output: ${joined}`);
  },
);

function randomSuffix(): string {
  return Math.random().toString(36).slice(2);
}

test('getSecret rejects a malformed handle without touching the keychain', () => {
  assert.throws(() => getSecret('not-a-real-handle' as AuthRef), VaultError);
});

test('deleteSecret rejects a malformed handle without touching the keychain', () => {
  assert.throws(() => deleteSecret('not-a-real-handle' as AuthRef), VaultError);
});

test('a malformed-handle rejection never includes the offending value in details', () => {
  const suspiciousLookingSecret = 'sk-this-looks-like-a-real-key-but-is-actually-a-bad-handle';
  try {
    getSecret(suspiciousLookingSecret as AuthRef);
    assert.fail('expected getSecret to throw for a malformed handle');
  } catch (err) {
    assert.ok(err instanceof VaultError);
    const serialized = JSON.stringify(err.details);
    assert.ok(!serialized.includes(suspiciousLookingSecret));
  }
});
