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

/** Applied to the document so every token swap follows one attribute. */
function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
}

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
