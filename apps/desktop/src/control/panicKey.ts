import { panic } from './session.ts';

// M8-3's panic key. The one place in this codebase permitted to register an
// OS-level hotkey — `scripts/check-no-global-hotkey.mjs` forbids it everywhere
// else, and forbade it here too until this milestone.
//
// OS-level rather than a button in the window, because the moment somebody
// needs it is the moment the app does not have focus: an agent is typing into
// something else, or a browser has taken the foreground, and a keystroke that
// only works when CHIMERA is in front is a stop that arrives after the thing it
// was meant to stop.

export const DEFAULT_PANIC_ACCELERATOR = 'Control+Alt+Escape';

/**
 * Electron's shortcut API, held from the moment it is first used.
 *
 * Imported inside the function rather than at module scope. A top-level
 * `import { globalShortcut } from 'electron'` drags Electron into everything
 * that loads the IPC graph, and the registry's own test runs under plain
 * `node --test` where that import fails outright — the same trap
 * `store/lifecycle.ts` hit at M1-10 and `files/service.ts` hit at M4-11. Kept
 * afterwards so unregistering at quit needs no await.
 */
let shortcuts: typeof import('electron').globalShortcut | undefined;

let registered = '';
let onPanic: ((result: { cancelledRuns: number; controlRevoked: boolean }) => void) | undefined;

/**
 * Registers the panic key, replacing any previous one.
 *
 * Returns what actually happened rather than throwing. Another application may
 * already hold the combination — on some desktops `Control+Alt+Escape` is the
 * window killer — and the honest response is to say the key is unavailable so
 * the user can pick another, not to fail startup over a hotkey.
 */
export async function registerPanicKey(accelerator = DEFAULT_PANIC_ACCELERATOR): Promise<{
  registered: boolean;
  accelerator: string;
  detail: string;
}> {
  unregisterPanicKey();

  try {
    const electron = await import('electron');
    shortcuts = electron.globalShortcut;
    const ok = shortcuts.register(accelerator, () => {
      const result = panic();
      onPanic?.(result);
    });

    if (!ok) {
      return {
        registered: false,
        accelerator,
        detail: `${accelerator} is already taken by something else on this machine. Choose another key.`,
      };
    }

    registered = accelerator;
    return { registered: true, accelerator, detail: '' };
  } catch (err) {
    return {
      registered: false,
      accelerator,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function unregisterPanicKey(): void {
  if (registered === '' || !shortcuts) return;
  try {
    shortcuts.unregister(registered);
  } catch {
    // Quitting is not the time to care that a hotkey we are giving up could
    // not be given up cleanly.
  }
  registered = '';
}

/** Told when the key fires, so the window can say what it stopped. */
export function onPanicFired(
  listener: (result: { cancelledRuns: number; controlRevoked: boolean }) => void,
): void {
  onPanic = listener;
}

export function panicKeyAccelerator(): string {
  return registered;
}
