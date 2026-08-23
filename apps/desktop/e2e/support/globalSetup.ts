import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Runs before any test, however Playwright was invoked.
//
// `npm run test:e2e` builds first; `npx playwright test` does not, and that is
// the one a person reaches for when re-running a single spec. A whole session's
// fixes were verified that way against the previous night's bundle: the suite
// passed, two live runs passed, and none of it was evidence about the code that
// had just been written.

export default function globalSetup(): void {
  execFileSync(
    process.execPath,
    [path.join(import.meta.dirname, '..', '..', 'scripts', 'check-build-fresh.mjs')],
    { stdio: 'inherit' },
  );
}
