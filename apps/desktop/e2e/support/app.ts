import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const desktopRoot = path.resolve(import.meta.dirname, '..', '..');
export const mainEntry = path.join(desktopRoot, 'dist', 'main.js');
export const fixturesDir = path.join(desktopRoot, 'e2e', 'fixtures');

/**
 * A throwaway `userData` directory for one test.
 *
 * Every launch below gets one. Two reasons, both load-bearing: the splash
 * plays once per profile (M0-8), so a shared profile would leave every test
 * after the first silently exercising the already-seen path; and without it
 * the suite writes into the developer's own application profile, so running
 * the tests changes the state of the app they use.
 */
export function freshProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-e2e-'));
}

export function removeProfile(profile: string): void {
  fs.rmSync(profile, { recursive: true, force: true });
}

export interface LaunchOptions {
  profile: string;
  /** Absolute path to an `e2e/fixtures` page to load instead of the renderer. */
  fixture?: string;
  /** Extra environment for the main process, e.g. an OmniRoute stub URL. */
  env?: Record<string, string>;
}

export function launchApp({ profile, fixture, env }: LaunchOptions): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry, `--user-data-dir=${profile}`],
    cwd: desktopRoot,
    env: { ...process.env, CHIMERA_E2E_FIXTURE: fixture ?? '', ...env },
  });
}

/**
 * Navigates to one of the shell's views.
 *
 * The app is an automation builder, so it opens on Home and the chat and
 * provider surfaces live behind sidebar entries. Tests take the same route a
 * person does rather than asserting against something that happens to be
 * mounted.
 */
export async function goTo(
  page: Page,
  view: 'home' | 'build' | 'agents' | 'providers' | 'chat',
): Promise<void> {
  await page.waitForSelector('[data-testid="app-shell"]');
  await page.getByTestId(`nav-${view}`).click();
}
