import { useCallback, useEffect, useState } from 'react';
import { bridge } from './chat/useChimera.ts';

// The person's own preferences, read once and shared.
//
// Device-local, never in the workspace database, never sent anywhere. The name
// is here so the home screen can say it; the theme is here so the whole shell
// can follow it.

export type Theme = 'dark' | 'light';

export interface Profile {
  firstName: string;
  lastName: string;
  theme: Theme;
  usageStats: boolean;
  onboarded: boolean;
}

/**
 * Every mounted hook, so a change made in one place reaches the others.
 *
 * A module-level set rather than a context provider: the theme toggle lives in
 * the shell and the greeting lives in a view several levels down, and threading
 * a provider between them to move two strings is more machinery than the
 * problem deserves.
 */
const listeners = new Set<(profile: Profile) => void>();
let cached: Profile | null = null;

/**
 * Where the theme is remembered a second time, for one job only.
 *
 * `profile.json` is the record. Reading it costs an IPC round trip, and the
 * round trip finishes several frames after the window paints — so somebody on
 * the light theme saw the app open dark and then flip, on every single launch.
 * A mirror in `localStorage` can be read synchronously before React renders,
 * which is the only way to have the first paint be the right one.
 *
 * Never the source of truth. If the two disagree, the profile wins the moment
 * it arrives; this only decides what is on screen for the first few frames.
 */
const THEME_KEY = 'chimera.theme';

/** Applied to the document so every token swap follows one attribute. */
function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A renderer with storage disabled still works; it just flashes.
  }
}

/**
 * Sets the theme before the first paint, from the mirror.
 *
 * Called at module load rather than in an effect: an effect runs after the
 * paint it is meant to precede.
 */
function applyRememberedTheme(): void {
  try {
    const remembered = localStorage.getItem(THEME_KEY);
    document.documentElement.dataset['theme'] = remembered === 'light' ? 'light' : 'dark';
  } catch {
    document.documentElement.dataset['theme'] = 'dark';
  }
}

applyRememberedTheme();

export function useProfile(): {
  profile: Profile | null;
  save: (patch: Partial<Profile>) => Promise<void>;
} {
  const [profile, setProfile] = useState<Profile | null>(cached);

  useEffect(() => {
    listeners.add(setProfile);
    if (cached === null) {
      void (async () => {
        try {
          const loaded = await bridge().invoke<Profile>('profile:get', {});
          cached = loaded;
          applyTheme(loaded.theme);
          for (const listener of listeners) listener(loaded);
        } catch {
          // A preference that will not load is not a reason to show nothing.
          // The greeting drops the name and the shell stays on its default.
        }
      })();
    } else {
      applyTheme(cached.theme);
    }
    return () => {
      listeners.delete(setProfile);
    };
  }, []);

  const save = useCallback(async (patch: Partial<Profile>) => {
    // Applied before the round trip: a theme that fades in after the write
    // confirms feels like the app hesitating.
    if (patch.theme !== undefined) applyTheme(patch.theme);
    const saved = await bridge().invoke<Profile>('profile:set', patch);
    cached = saved;
    applyTheme(saved.theme);
    for (const listener of listeners) listener(saved);
  }, []);

  return { profile, save };
}
