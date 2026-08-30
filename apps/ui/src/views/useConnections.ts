import { useCallback, useEffect, useState } from 'react';
import { bridge, type ConnectionSummary } from '../chat/useChimera.ts';

// Every model the workspace can actually reach, flattened across connections.
// A step is bound to a connection *and* a model, not a model name floating free:
// two providers can serve the same model id, and which one a run uses is a
// decision with a bill and a data-residency answer attached.

export interface ModelChoice {
  key: string;
  connectionId: string;
  connectionLabel: string;
  model: string;
  /** Kept at the top of every picker. See `usePinnedModels`. */
  pinned?: boolean;
}

/**
 * The models this workspace keeps at the top of every picker.
 *
 * A workspace that connects OpenRouter gets four hundred models in a dropdown
 * and the two anybody uses are somewhere in the middle. This is one list, read
 * and written in one place, so a model pinned in the canvas is pinned in the
 * swarm and in the chat as well — a pin that only applied to the picker you
 * happened to be looking at would be a worse version of no pinning at all.
 */
/**
 * The pinned list, once for the whole window.
 *
 * Module state rather than per-hook state, and that is the entire point: there
 * are five model pickers in this app and each one calls the hook. With a
 * `useState` apiece, pinning a model in the canvas left the swarm's picker
 * showing the old order until it happened to remount — which is the version of
 * this feature that would have shipped looking finished and been wrong
 * everywhere except the control you were touching.
 *
 * A store rather than a context because there is no tree to scope it to: this
 * is one workspace-wide fact, and a provider would only be somewhere else to
 * forget to wrap.
 */
const pinnedStore = (() => {
  let current: string[] = [];
  let loaded = false;
  const listeners = new Set<(next: string[]) => void>();

  const announce = (): void => {
    for (const listener of listeners) listener(current);
  };

  return {
    get current(): string[] {
      return current;
    },
    subscribe(listener: (next: string[]) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load(): Promise<void> {
      // Once per window. Five pickers mounting at once should not be five
      // reads of the same row.
      if (loaded) return;
      loaded = true;
      try {
        const result = await bridge().invoke<{ pinned: string[] }>('pinned:get', {});
        current = result.pinned;
        announce();
      } catch {
        // Nothing pinned is the same experience as before pinning existed.
        loaded = false;
      }
    },
    toggle(key: string): void {
      if (key === '' || key.startsWith('tier:')) return;
      // Newest first: the thing you just pinned is the thing you are about to
      // use, and burying it under three older pins is the problem this exists
      // to solve.
      current = current.includes(key) ? current.filter((one) => one !== key) : [key, ...current];
      announce();
      void bridge()
        .invoke('pinned:set', { pinned: current })
        .catch(() => undefined);
    },
  };
})();

export function usePinnedModels(): {
  pinned: string[];
  isPinned: (key: string) => boolean;
  toggle: (key: string) => void;
} {
  const [pinned, setPinned] = useState<string[]>(pinnedStore.current);

  useEffect(() => pinnedStore.subscribe(setPinned), []);
  useEffect(() => {
    void pinnedStore.load();
  }, []);

  return {
    pinned,
    isPinned: useCallback((key: string) => pinned.includes(key), [pinned]),
    toggle: useCallback((key: string) => {
      pinnedStore.toggle(key);
    }, []),
  };
}

/**
 * @param refreshToken Bumped by the shell when a connection is added or a
 * catalogue imported. Without it this hook reads once on mount, and a panel
 * that opened before the import would offer an empty list forever — the exact
 * shape of the defect that made a working OmniRoute import look like it had
 * done nothing.
 */
export function useConnections(refreshToken = 0): { choices: ModelChoice[]; loaded: boolean } {
  const [choices, setChoices] = useState<ModelChoice[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { pinned } = usePinnedModels();

  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{ connections: ConnectionSummary[] }>(
          'connection:list',
          {},
        );
        setChoices(
          result.connections.flatMap((connection) =>
            connection.models.map((model) => ({
              key: `${connection.id}::${model}`,
              connectionId: connection.id,
              connectionLabel: connection.label,
              model,
            })),
          ),
        );
      } catch {
        // An empty list renders as "connect a provider first", which is the
        // honest reading of both no connections and a failed read.
      } finally {
        setLoaded(true);
      }
    })();
  }, [refreshToken]);

  // Pinned first, in the order they were pinned; everything else keeps the
  // provider's own order after them. Sorted here rather than in each picker so
  // there is one answer to "what order are models in" for the whole app.
  //
  // A pin naming a model this workspace can no longer reach simply does not
  // match anything and disappears from the list without being deleted: a
  // provider that is briefly unreachable should come back with its pins
  // intact.
  const ordered = [
    ...pinned.flatMap((key) => {
      const found = choices.find((choice) => choice.key === key);
      return found === undefined ? [] : [{ ...found, pinned: true }];
    }),
    ...choices.filter((choice) => !pinned.includes(choice.key)),
  ];

  return { choices: ordered, loaded };
}

/**
 * Whether this workspace has said what it means by "standard".
 *
 * Only the one tier, and only whether it is set — the canvas needs to know that
 * a swarm has somewhere to run, not what it will run on. `loaded` matters:
 * treating "not read yet" as "not set" would flash a blocking message on every
 * open of a workspace that is perfectly well configured.
 */
export function useStandardTier(): { set: boolean; loaded: boolean } {
  const [state, setState] = useState({ set: false, loaded: false });

  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{
          tiers: Record<string, { connectionId: string; model: string }>;
        }>('tiers:get', {});
        const standard = result.tiers['standard'];
        setState({
          set: standard !== undefined && standard.connectionId !== '' && standard.model !== '',
          loaded: true,
        });
      } catch {
        // Unreadable settings are not a reason to refuse to run. The step says
        // the same thing if it turns out the tier really is unset.
        setState({ set: true, loaded: true });
      }
    })();
  }, []);

  return state;
}
