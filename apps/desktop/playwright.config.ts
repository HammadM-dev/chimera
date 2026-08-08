import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  fullyParallel: false, // one Electron app instance per test file, avoid launch contention
});
