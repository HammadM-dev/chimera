import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // An Electron cold start is seconds, not milliseconds, and the splash suite
  // launches the app twice in one test. 30s is a web-test default that this
  // suite has no business inheriting.
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  fullyParallel: false, // one Electron app instance per test file, avoid launch contention
  // fullyParallel: false only serialises *within* a file — Playwright still
  // runs files across workers, so two Electron apps launch concurrently.
  // M0-8's splash tests assert on animation timing, and a second Electron cold
  // start on the same machine is exactly the kind of load that perturbs it.
  // One worker is the honest reading of the line above.
  workers: 1,
});
