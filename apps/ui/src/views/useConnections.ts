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

export function useConnections(): { choices: ModelChoice[]; loaded: boolean } {
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
  }, []);

  return { choices, loaded };
}
