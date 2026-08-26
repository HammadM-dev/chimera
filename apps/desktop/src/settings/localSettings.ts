import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// Device-local, cosmetic preferences. Explicitly NOT SQLite and explicitly
// NOT reachable from `window.chimera.*` — docs/DESIGN.md section 5.2 requires
// `hasSeenSplash` be pinned as device-local at introduction, because F10
// anticipates a shared-workspace sync backend and anything sitting in the
// application store or on an IPC channel is a candidate for it later. A flag
// this trivial should never be able to become a synced, RBAC-relevant
// setting by accident.
//
// Everything here is best-effort by design: a corrupt or unreadable settings
// file must never stop the app from launching, so reads fall back to defaults
// and writes swallow their failure after logging. That is the correct
// trade-off for cosmetic state and the wrong one for application data, which
// is why application data does not live here.

export interface LocalSettings {
  hasSeenSplash: boolean;
  /**
   * Whether the guided tour has been offered on this machine.
   *
   * Device-local for the same reason the splash flag is: it is about what this
   * person has seen on this screen, not about the workspace. Somebody who opens
   * the same workspace on a new machine has not taken the tour there.
   *
   * Set once the tour is finished *or* skipped — being asked again after
   * declining is the behaviour people mean when they call something nagging.
   */
  hasSeenTour: boolean;
}

const DEFAULTS: LocalSettings = {
  hasSeenSplash: false,
  hasSeenTour: false,
};

const FILE_NAME = 'local-settings.json';

function settingsPath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

export function readLocalSettings(): LocalSettings {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath(), 'utf8');
  } catch {
    // Missing file is the normal first-launch case, not an error.
    return { ...DEFAULTS };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS };
    const record = parsed as Record<string, unknown>;
    return {
      hasSeenSplash:
        typeof record['hasSeenSplash'] === 'boolean'
          ? record['hasSeenSplash']
          : DEFAULTS.hasSeenSplash,
      hasSeenTour:
        typeof record['hasSeenTour'] === 'boolean'
          ? record['hasSeenTour']
          : DEFAULTS.hasSeenTour,
    };
  } catch {
    console.warn(`[settings] ${FILE_NAME} is not valid JSON; falling back to defaults`);
    return { ...DEFAULTS };
  }
}

export function writeLocalSettings(settings: LocalSettings): void {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[settings] could not persist ${FILE_NAME}: ${message}`);
  }
}

/**
 * Answers "does this launch play the splash?" and records that it did, in one
 * step. Called once, at window creation.
 *
 * The flag is written before the splash has actually finished playing, which
 * is deliberate: the alternative is an IPC channel for the renderer to report
 * completion, which is exactly the surface docs/DESIGN.md section 5.2 says
 * this preference must not have. The failure mode of writing early is that a
 * crash mid-splash costs the user one replay of a 2.3s animation; the failure
 * mode of the alternative is a synced-preferences bug in a year.
 */
export function consumeSplashDecision(): boolean {
  const settings = readLocalSettings();
  if (settings.hasSeenSplash) return false;
  writeLocalSettings({ ...settings, hasSeenSplash: true });
  return true;
}

/** Whether to offer the tour, and the setter for once it has been. */
export function getTourState(): { seen: boolean } {
  return { seen: readLocalSettings().hasSeenTour };
}

export function setTourSeen(seen: boolean): { seen: boolean } {
  writeLocalSettings({ ...readLocalSettings(), hasSeenTour: seen });
  return getTourState();
}
