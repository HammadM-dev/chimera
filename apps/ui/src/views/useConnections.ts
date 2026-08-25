import { useEffect, useState } from 'react';
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

  return { choices, loaded };
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
