import os from 'node:os';
import { readProfile, updateProfile } from '../settings/profile.ts';

// "How many people are using this?" — and nothing else.
//
// Not to be confused with the telemetry in `apps/desktop/src/runs`: that
// exports finished runs to a collector the *user* configures, for the user's
// own observability, and is off by default. This is one line a day to one
// endpoint, so the number of installs is a number somebody can quote rather
// than guess.
//
// What goes: a random install id, the app version, the platform, and the
// architecture. What never goes: the person's name, the workspace, automation
// names, prompts, answers, file paths, run counts, which models they use, or
// anything else. The list is short enough to write out in full, which is the
// test of whether it is short enough.
//
// The install id is deliberately not derived from anything — not a machine id,
// not a hash of the hostname, not an email. It is a UUID made once on this
// computer and kept in `profile.json`. It cannot be joined to anything, which
// is precisely what makes it possible to count installs without identifying
// anybody, and what makes "I can see the stats but not the users" true rather
// than promised.

/** Where the counts go. Set at build time; empty means nothing is sent, ever. */
const ENDPOINT = process.env['CHIMERA_USAGE_ENDPOINT'] ?? '';

/** Once a day. A ping per launch would count a restart as a person. */
const INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Long enough to cross a slow link, short enough that nobody is kept waiting. */
const TIMEOUT_MS = 8_000;

/**
 * The app version, set by `main.ts`.
 *
 * Passed in for the same reason the profile directory is: `import { app } from
 * 'electron'` here would drag Electron into every test that reaches this file.
 */
let version = '0.0.0';

export function setAppVersion(value: string): void {
  version = value;
}

export interface UsagePing {
  installId: string;
  version: string;
  platform: string;
  arch: string;
}

export function pingBody(installId: string): UsagePing {
  return {
    installId,
    version,
    platform: process.platform,
    arch: os.arch(),
  };
}

/**
 * Reports that this copy is running, if it is due and if the user agreed.
 *
 * Never throws and never blocks anything: an endpoint that is down, slow or
 * firewalled must have no effect a user could notice. A failure is not retried
 * and not queued — the next launch after the interval tries again, and a count
 * that is a day late is not worth a retry buffer on somebody's disk.
 */
export async function reportUsage(now: number = Date.now()): Promise<'sent' | 'skipped'> {
  if (ENDPOINT === '') return 'skipped';

  const profile = readProfile();
  if (!profile.usageStats) return 'skipped';
  // Not before setup has asked. A copy opened once and closed before answering
  // has not agreed to anything, and a default is not an answer.
  if (!profile.onboarded) return 'skipped';
  if (now - profile.lastReportedAt < INTERVAL_MS) return 'skipped';

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pingBody(profile.installId)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return 'skipped';
  } catch {
    return 'skipped';
  }

  // Written only on success, so a fortnight offline does not read afterwards as
  // a fortnight of somebody having stopped.
  updateProfile({ lastReportedAt: now });
  return 'sent';
}

/**
 * Starts reporting.
 *
 * After the window is up rather than during startup: nothing about this is
 * worth a millisecond of the time between clicking the icon and seeing
 * something. The interval covers a copy left open for days.
 */
export function startUsageReporting(): void {
  setTimeout(() => {
    void reportUsage();
  }, 30_000).unref();

  setInterval(
    () => {
      void reportUsage();
    },
    6 * 60 * 60 * 1000,
  ).unref();
}
