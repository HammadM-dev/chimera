import { EventEmitter } from 'node:events';

// Keeping CHIMERA up to date, for real.
//
// The bar this had to clear was set plainly: not a banner that tells somebody a
// version exists and leaves them to go and find it. This downloads the release
// and installs it, and the button that says "Restart and update" does exactly
// that.
//
// `electron-updater` against GitHub Releases, which is where this project
// publishes. It handles the parts that are genuinely fiddly and easy to get
// subtly wrong — reading the channel feed, resuming a partial download,
// swapping an AppImage while it is running, handing a Windows installer the
// right arguments — and none of that is worth reimplementing badly.
//
// Deliberately quiet by default. It checks, it downloads when asked, and it
// says so once. An app that interrupts somebody mid-run to talk about itself
// has misjudged whose time matters.

export type UpdateStage =
  'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error';

export interface UpdateState {
  stage: UpdateStage;
  /** The version on offer. Empty until there is one. */
  version: string;
  /** What is running now. */
  current: string;
  /** 0–100 while downloading. */
  percent: number;
  /** Why it failed, in words. Empty otherwise. */
  reason: string;
  /** Whether an update can be installed from here at all — see `updatable`. */
  supported: boolean;
}

const events = new EventEmitter();

let state: UpdateState = {
  stage: 'idle',
  version: '',
  current: '0.0.0',
  percent: 0,
  reason: '',
  supported: false,
};

function set(next: Partial<UpdateState>): void {
  state = { ...state, ...next };
  events.emit('changed', state);
}

export function getUpdateState(): UpdateState {
  return state;
}

export function onUpdateChanged(listener: (next: UpdateState) => void): () => void {
  events.on('changed', listener);
  return () => {
    events.off('changed', listener);
  };
}

/**
 * Whether this build can install an update over itself.
 *
 * A checkout run with `electron .` has no packaged artefact to replace, and
 * `electron-updater` throws rather than no-ops when asked — so the honest
 * answer is to say so in the UI and not offer a button that cannot work.
 * `app.isPackaged` is exactly that question.
 */
async function updatable(): Promise<boolean> {
  const { app } = await import('electron');
  return app.isPackaged;
}

let wired = false;

interface AutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on: (event: string, listener: (...args: never[]) => void) => unknown;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => void;
}

async function updater(): Promise<AutoUpdater> {
  // Imported here rather than at the top of the file. `electron-updater` pulls
  // in `electron` itself, which is a CommonJS module with no named exports and
  // fails to instantiate under Node's ESM loader — the one that runs the unit
  // tests. The same trap `openExternal` and `localSettings` already fell into.
  const mod = (await import('electron-updater')) as unknown as {
    autoUpdater?: AutoUpdater;
    default?: { autoUpdater: AutoUpdater };
  };
  const auto = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!auto) throw new Error('electron-updater did not expose an autoUpdater.');

  if (!wired) {
    wired = true;
    // Downloading is ours to trigger, not the library's to do behind our back:
    // somebody on a metered connection should be asked before a hundred
    // megabytes moves. Installing on quit is off for the same reason — a quit
    // that silently becomes an install is a quit that lied.
    auto.autoDownload = false;
    auto.autoInstallOnAppQuit = false;

    auto.on('checking-for-update', () => {
      set({ stage: 'checking', reason: '' });
    });
    auto.on('update-available', ((info: { version: string }) => {
      set({ stage: 'available', version: info.version, reason: '' });
    }) as never);
    auto.on('update-not-available', () => {
      set({ stage: 'current', version: '', percent: 0, reason: '' });
    });
    auto.on('download-progress', ((progress: { percent: number }) => {
      set({ stage: 'downloading', percent: Math.round(progress.percent) });
    }) as never);
    auto.on('update-downloaded', ((info: { version: string }) => {
      set({ stage: 'ready', version: info.version, percent: 100 });
    }) as never);
    auto.on('error', ((err: Error) => {
      // A failed check is not a broken app. It is reported where somebody
      // asked for it and nowhere else.
      set({ stage: 'error', reason: err.message });
    }) as never);
  }
  return auto;
}

/** Looks for a newer release. Safe to call on a build that cannot install one. */
export async function checkForUpdate(): Promise<UpdateState> {
  const { app } = await import('electron');
  set({ current: app.getVersion(), supported: await updatable() });

  if (!state.supported) {
    set({ stage: 'idle', reason: '' });
    return state;
  }

  try {
    const auto = await updater();
    await auto.checkForUpdates();
  } catch (err) {
    set({ stage: 'error', reason: err instanceof Error ? err.message : String(err) });
  }
  return state;
}

/** Fetches the release the check found. Progress arrives on the event. */
export async function downloadUpdate(): Promise<UpdateState> {
  if (!state.supported || state.stage === 'downloading') return state;
  try {
    set({ stage: 'downloading', percent: 0, reason: '' });
    const auto = await updater();
    await auto.downloadUpdate();
  } catch (err) {
    set({ stage: 'error', reason: err instanceof Error ? err.message : String(err) });
  }
  return state;
}

/**
 * Quits and installs what was downloaded.
 *
 * Only from `ready`: calling this without a downloaded artefact quits the app
 * and installs nothing, which from the outside is indistinguishable from a
 * crash on a button press.
 */
export async function installUpdate(): Promise<UpdateState> {
  if (state.stage !== 'ready') return state;
  const auto = await updater();
  // `isSilent: false` so a Windows installer shows its own progress;
  // `isForceRunAfter: true` so the app comes back rather than leaving somebody
  // looking at their desktop wondering whether it worked.
  setImmediate(() => {
    auto.quitAndInstall(false, true);
  });
  return state;
}

/**
 * How often to look, after the one at startup.
 *
 * Six hours. Often enough that somebody who leaves it open for a week hears
 * about a release, rare enough that it is never the reason a request is slow.
 */
const EVERY_MS = 6 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export function startUpdateChecks(): void {
  if (timer !== null) return;
  // Not immediately on launch: the first seconds belong to the window opening,
  // not to a network call about the app itself.
  setTimeout(() => void checkForUpdate(), 8_000).unref();
  timer = setInterval(() => void checkForUpdate(), EVERY_MS);
  timer.unref();
}

export function stopUpdateChecks(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
