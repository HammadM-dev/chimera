import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Entry } from '@napi-rs/keyring';
import { vaultHandlesAt } from '@chimera/store';

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

/**
 * Removes a test workspace, keychain entries included.
 *
 * Deleting the directory was the whole of this, and the directory is not where
 * the secrets are: every connection and every plugin credential a test creates
 * goes to the real OS keychain and stayed there afterwards. One entry per
 * connection per run, never collected, across a suite that creates dozens and
 * is run many times a day.
 *
 * On this machine that reached 1,218 orphaned entries — 99% of everything in
 * the login keyring — at which point gnome-keyring, which rewrites and
 * re-encrypts the collection on every write, took longer than DBus's 25s reply
 * timeout to answer. The symptom was every provider-connecting test failing
 * with "Did not receive a reply", and the daemon burning eighteen hours of CPU.
 * The suite degraded the machine it ran on, a little more each run.
 *
 * Read the handles out of the workspace before the file goes, then delete each
 * one. Best-effort throughout: a handle that will not delete must not fail the
 * test that is already over.
 */
export function removeProfile(profile: string): void {
  try {
    purgeSecrets(path.join(profile, 'chimera.sqlite'));
  } catch {
    // A workspace with no database, or one already gone. Nothing to collect.
  }
  fs.rmSync(profile, { recursive: true, force: true });
}

function purgeSecrets(dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;

  for (const handle of vaultHandlesAt(dbPath)) {
    try {
      new Entry('chimera', handle).deletePassword();
    } catch {
      // Already gone, or a keychain that is not answering. Either way the test
      // is finished and this is not its problem.
    }
  }
}

export interface LaunchOptions {
  profile: string;
  /** Absolute path to an `e2e/fixtures` page to load instead of the renderer. */
  fixture?: string;
  /** Extra environment for the main process, e.g. an OmniRoute stub URL. */
  env?: Record<string, string>;
  /**
   * Plays the splash, as production does on every launch.
   *
   * Off by default for the suite: a test about connections should not spend
   * 2.3s watching an animation, and one of them was pushed past its timeout by
   * exactly that. `splash.spec.ts` turns it on, so the thing under test is the
   * real behaviour rather than a test-only path.
   */
  splash?: boolean;
}

export function launchApp({
  profile,
  fixture,
  env,
  splash = false,
}: LaunchOptions): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry, `--user-data-dir=${profile}`],
    cwd: desktopRoot,
    env: {
      ...process.env,
      CHIMERA_E2E_FIXTURE: fixture ?? '',
      ...(splash ? {} : { CHIMERA_E2E_NO_SPLASH: '1' }),
      ...env,
    },
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
  view: 'home' | 'build' | 'runs' | 'agents' | 'memory' | 'providers' | 'chat',
): Promise<void> {
  await page.waitForSelector('[data-testid="app-shell"]');
  // The splash first, then setup. Both are full-screen overlays, and a nav
  // click made underneath either one is intercepted rather than delivered.
  await page.waitForSelector('.splash', { state: 'detached', timeout: 20_000 });
  await dismissOnboarding(page);
  await page.getByTestId(`nav-${view}`).click();
}

/**
 * Clears first-launch setup if it is showing.
 *
 * Every test starts on a fresh profile with no connections, which is exactly
 * the condition that triggers the guide — so a test that wants the app has to
 * get past it, the same way a person would. Tolerant of it being absent so the
 * helper stays usable from a test that has already connected something.
 */
export async function dismissOnboarding(page: Page): Promise<void> {
  const skip = page.getByTestId('intro-skip').first();
  // `count()` rather than a timed `waitFor`: absence is the normal case once a
  // test has connected something, and a five-second wait for an element that
  // is never coming, paid on every navigation, cost M1-11 twenty seconds of
  // its budget and made it fail under load. The guide mounts in the same React
  // commit that unmounts the splash, and `goTo` has already waited for that,
  // so there is no race left to wait out.
  if ((await skip.count()) === 0) return;
  await skip.click();
}
