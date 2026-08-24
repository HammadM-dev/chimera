import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Who is sitting in front of this copy, and how they like it to look.
//
// A sibling of `localSettings.ts` rather than a few more fields on it, and the
// difference is deliberate. That file is pinned as unreachable from
// `window.chimera.*` so a trivial flag can never drift into a synced,
// RBAC-relevant setting by accident. These have to reach the renderer — a
// greeting nobody can read is not a greeting — so they get their own file and
// their own channel, and the pin on the other one stays intact.
//
// Device-local and staying that way. The name is never written to SQLite, so it
// cannot be swept into a shared workspace by F10's sync; it is never sent
// anywhere, so nobody operating this product can read it. It exists to put a
// name on the home screen and for nothing else.

export type Theme = 'dark' | 'light';

export interface Profile {
  /** Required at setup. Empty only before the person has been asked. */
  firstName: string;
  /** Optional, and genuinely optional — plenty of people do not give one. */
  lastName: string;
  theme: Theme;
  /**
   * A random identifier for this installation.
   *
   * Not a user id and not derived from anything about the machine or the
   * person: a UUID made once, here, and kept. It answers "how many copies are
   * in use" and cannot answer anything else. Deleting the file makes a new one,
   * which is the correct behaviour — a fresh install is a fresh install.
   */
  installId: string;
  /** Whether this copy reports that it is running. Never what it is running. */
  usageStats: boolean;
  /** Millis of the last successful report, so it happens daily rather than hourly. */
  lastReportedAt: number;
  /** Whether setup has asked for the above yet. */
  onboarded: boolean;
}

function defaults(): Profile {
  return {
    firstName: '',
    lastName: '',
    theme: 'dark',
    installId: randomUUID(),
    // On, and said plainly at setup with one control to turn it off. An
    // anonymous count that most people never find the switch to enable is not
    // a count of anything.
    usageStats: true,
    lastReportedAt: 0,
    onboarded: false,
  };
}

const FILE_NAME = 'profile.json';

/**
 * Where the file lives, set once by `main.ts`.
 *
 * Passed in rather than read from Electron's `app` here, for the reason
 * `store/lifecycle.ts` records: one `import { app } from 'electron'` at the top
 * of a module is enough to make everything that reaches it unrunnable under
 * plain `node --test`, and the IPC handler-coverage test reaches this one
 * through `handlers.ts`. Unset — which is every unit test — reads return
 * defaults and writes do nothing.
 */
let directory = '';

export function setProfileDirectory(dir: string): void {
  directory = dir;
}

function profilePath(): string {
  return path.join(directory, FILE_NAME);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function readProfile(): Profile {
  const base = defaults();
  if (directory === '') return base;

  let raw: string;
  try {
    raw = fs.readFileSync(profilePath(), 'utf8');
  } catch {
    // First launch. Write the install id now rather than making a new one on
    // every read, which would report every start as a new installation.
    writeProfile(base);
    return base;
  }

  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return base;
    record = parsed as Record<string, unknown>;
  } catch {
    console.warn(`[profile] ${FILE_NAME} is not valid JSON; falling back to defaults`);
    return base;
  }

  const theme = record['theme'];
  const installId = asString(record['installId'], '');

  const profile: Profile = {
    firstName: asString(record['firstName'], base.firstName),
    lastName: asString(record['lastName'], base.lastName),
    theme: theme === 'light' || theme === 'dark' ? theme : base.theme,
    installId: installId === '' ? base.installId : installId,
    usageStats: typeof record['usageStats'] === 'boolean' ? record['usageStats'] : base.usageStats,
    lastReportedAt:
      typeof record['lastReportedAt'] === 'number' ? record['lastReportedAt'] : base.lastReportedAt,
    onboarded: typeof record['onboarded'] === 'boolean' ? record['onboarded'] : base.onboarded,
  };

  // A file that had no install id now has one, kept rather than regenerated.
  if (installId === '') writeProfile(profile);
  return profile;
}

export function writeProfile(profile: Profile): void {
  if (directory === '') return;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(profilePath(), `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  } catch (err) {
    // Cosmetic state, so a failure to save a preference must never stop the
    // app. Application data does not live here, for exactly this reason.
    console.warn(`[profile] could not write ${FILE_NAME}:`, err);
  }
}

export function updateProfile(patch: Partial<Profile>): Profile {
  const next = { ...readProfile(), ...patch };
  writeProfile(next);
  return next;
}
