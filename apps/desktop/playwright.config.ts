import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // Refuses to start against a bundle older than the source. See the file.
  globalSetup: './e2e/support/globalSetup.ts',
  // An Electron cold start is seconds, not milliseconds, and the splash suite
  // launches the app twice in one test. 30s was a web-test default this suite
  // had no business inheriting, and 60s became the same thing as the suite grew
  // past a hundred tests: measured 2026-08-24, the only failures in two
  // otherwise-green full runs were `m1-demo` and two splash specs, all of them
  // "test timeout exceeded" rather than a failed assertion, and all of them
  // passing on their own a minute later. By the eighty-fifth Electron launch a
  // cold start is not what it was at the first.
  //
  // This hides nothing: a genuinely broken test fails on an assertion, not by
  // taking two minutes. What it stops is a suite that reports the machine being
  // busy as the product being broken — which is the failure mode that gets a
  // real failure ignored.
  timeout: 120_000,
  retries: 0,
  reporter: [['list']],
  // A picture and a trace, kept only when something failed.
  //
  // Costs nothing on a green run and is the difference between diagnosing a
  // CI-only failure and guessing at it. Three canvas tests fail on a runner
  // and pass on every desktop here; the assertion says a join did not draw,
  // and what the canvas looked like at that moment is the whole question.
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  fullyParallel: false, // one Electron app instance per test file, avoid launch contention
  // fullyParallel: false only serialises *within* a file — Playwright still
  // runs files across workers, so two Electron apps launch concurrently.
  // M0-8's splash tests assert on animation timing, and a second Electron cold
  // start on the same machine is exactly the kind of load that perturbs it.
  // One worker is the honest reading of the line above.
  workers: 1,
});
