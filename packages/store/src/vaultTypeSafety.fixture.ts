// Type-checked by tsc --noEmit like any other file under src/. Proves the
// AuthRef brand (vault.ts) actually blocks a plain string at compile time —
// docs/ARCHITECTURE.md section 5: "a repository call site that tries to
// pass a raw key string instead of a handle fails to compile."
import { getSecret, deleteSecret, type AuthRef } from './vault.ts';

const plainString = 'sk-this-is-a-raw-string-not-a-vault-handle';

// @ts-expect-error a plain string is not assignable to the branded AuthRef type.
getSecret(plainString);

// @ts-expect-error same for deleteSecret.
deleteSecret(plainString);

// Sanity check: an explicitly-cast AuthRef compiles fine — proves the
// directives above are catching the missing brand specifically, not some
// unrelated break in vault.ts's exports.
getSecret(plainString as AuthRef);
deleteSecret(plainString as AuthRef);
