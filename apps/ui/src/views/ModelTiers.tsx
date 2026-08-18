import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import { useConnections, type ModelChoice } from './useConnections.ts';

// M5-4. Which model this workspace means by cheap, standard and frontier.
//
// The point is that an automation can say "cheap" instead of naming a model.
// The same file then runs for somebody on hosted keys and somebody running
// everything locally, with no edit — and a fan-out over a thousand items can
// use the cheap tier for the workers and the frontier tier for the check
// without the workflow knowing what either one is.

interface TierBinding {
  connectionId: string;
  model: string;
}

type Tiers = Record<'cheap' | 'standard' | 'frontier', TierBinding>;

const EMPTY: Tiers = {
  cheap: { connectionId: '', model: '' },
  standard: { connectionId: '', model: '' },
  frontier: { connectionId: '', model: '' },
};

const TIER_BLURB: Record<keyof Tiers, string> = {
  cheap: 'The one you would run a thousand times. Fan-out workers, extraction, classification.',
  standard: 'The everyday one. Most steps in most automations.',
  frontier: 'The best one you have. Planning, review, and the final check.',
};

interface CachePolicy {
  exact: boolean;
  semantic: boolean;
  threshold: number;
  embeddingModel: string;
  embeddingConnectionId: string;
}

/**
 * Whether this workspace reuses answers it has already paid for.
 *
 * Beside the tiers because both are the same kind of decision — how runs behave
 * here, rather than what any one automation does. Off by default, and the two
 * kinds are separate controls: reusing an identical prompt is a claim about
 * determinism, and reusing a similar one is a claim about meaning.
 */
export function AnswerCache({ refreshToken }: { refreshToken: number }): JSX.Element {
  const { choices } = useConnections(refreshToken);
  const [policy, setPolicy] = useState<CachePolicy | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{ policy: CachePolicy }>('cache:get', {});
        setPolicy(result.policy);
      } catch (err) {
        setNote(describeError(err).message);
      }
    })();
  }, [refreshToken]);

  const save = useCallback(async (next: CachePolicy) => {
    setPolicy(next);
    try {
      await bridge().invoke('cache:set', { policy: next });
      setNote('Saved.');
    } catch (err) {
      setNote(describeError(err).message);
    }
  }, []);

  if (policy === null) return <p className="agent-card__prompt">Loading.</p>;

  return (
    <div data-testid="answer-cache">
      <label className="canvas__check">
        <input
          type="checkbox"
          data-testid="cache-exact"
          checked={policy.exact}
          onChange={(event) => {
            void save({ ...policy, exact: event.target.checked });
          }}
        />
        <span>
          Reuse an answer when the question is word for word the same, on the same model. Safe:
          nothing about the question changed.
        </span>
      </label>

      <label className="canvas__check">
        <input
          type="checkbox"
          data-testid="cache-semantic"
          checked={policy.semantic}
          onChange={(event) => {
            void save({ ...policy, semantic: event.target.checked });
          }}
        />
        <span>
          Reuse an answer when the question is only similar. Cheaper, and a judgement call: a close
          match is not the same question.
        </span>
      </label>

      {policy.semantic && (
        <div className="field">
          <label className="field__label" htmlFor="cache-embedding">
            Model used to compare questions
          </label>
          <select
            id="cache-embedding"
            className="control"
            data-testid="cache-embedding"
            value={
              policy.embeddingConnectionId === ''
                ? ''
                : `${policy.embeddingConnectionId}::${policy.embeddingModel}`
            }
            onChange={(event) => {
              const choice = choices.find((candidate) => candidate.key === event.target.value);
              void save({
                ...policy,
                embeddingConnectionId: choice?.connectionId ?? '',
                embeddingModel: choice?.model ?? '',
              });
            }}
          >
            <option value="">Not set — similar questions will not be matched</option>
            {choices.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.connectionLabel} · {choice.model}
              </option>
            ))}
          </select>
          <p className="agent-card__prompt">
            Only a model that produces embeddings will work here. Without one, nothing is reused on
            similarity — which is the safe way for it to fail.
          </p>
        </div>
      )}

      {note !== '' && <p className="agent-card__prompt">{note}</p>}
    </div>
  );
}

interface Telemetry {
  enabled: boolean;
  endpoint: string;
  headersJson: string;
  includePayloads: boolean;
}

/**
 * Where runs are exported, if anywhere.
 *
 * Two switches again, and the second one matters more than it looks: timings
 * and token counts are observability, and the prompts and answers are the
 * user's business. Sending the second is a separate thing to agree to.
 */
export function TelemetryPanel({ refreshToken }: { refreshToken: number }): JSX.Element {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{ telemetry: Telemetry }>('telemetry:get', {});
        setTelemetry(result.telemetry);
      } catch (err) {
        setNote(describeError(err).message);
      }
    })();
  }, [refreshToken]);

  const save = useCallback(async (next: Telemetry) => {
    setTelemetry(next);
    try {
      await bridge().invoke('telemetry:set', { telemetry: next });
      setNote('Saved.');
    } catch (err) {
      setNote(describeError(err).message);
    }
  }, []);

  if (telemetry === null) return <p className="agent-card__prompt">Loading.</p>;

  return (
    <div data-testid="telemetry">
      <label className="canvas__check">
        <input
          type="checkbox"
          data-testid="telemetry-enabled"
          checked={telemetry.enabled}
          onChange={(event) => {
            void save({ ...telemetry, enabled: event.target.checked });
          }}
        />
        <span>Send each finished run to an OpenTelemetry collector.</span>
      </label>

      {telemetry.enabled && (
        <>
          <div className="field">
            <label className="field__label" htmlFor="telemetry-endpoint">
              Collector
            </label>
            <input
              id="telemetry-endpoint"
              className="control"
              data-testid="telemetry-endpoint"
              placeholder="http://localhost:4318"
              value={telemetry.endpoint}
              onChange={(event) => {
                void save({ ...telemetry, endpoint: event.target.value });
              }}
            />
          </div>

          <label className="canvas__check">
            <input
              type="checkbox"
              data-testid="telemetry-payloads"
              checked={telemetry.includePayloads}
              onChange={(event) => {
                void save({ ...telemetry, includePayloads: event.target.checked });
              }}
            />
            <span>
              Include what was asked and answered. Without this, only timings, token counts and
              costs are sent — the prompts and the outputs stay on this machine.
            </span>
          </label>
        </>
      )}

      {note !== '' && <p className="agent-card__prompt">{note}</p>}
    </div>
  );
}

export function ModelTiers({ refreshToken }: { refreshToken: number }): JSX.Element {
  const { choices } = useConnections(refreshToken);
  const [tiers, setTiers] = useState<Tiers>(EMPTY);
  const [note, setNote] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{ tiers: Tiers }>('tiers:get', {});
        setTiers(result.tiers);
      } catch (err) {
        setNote(describeError(err).message);
      }
    })();
  }, [refreshToken]);

  const bind = useCallback(
    async (tier: keyof Tiers, key: string) => {
      const choice: ModelChoice | undefined = choices.find((candidate) => candidate.key === key);
      const next: Tiers = {
        ...tiers,
        [tier]: choice
          ? { connectionId: choice.connectionId, model: choice.model }
          : { connectionId: '', model: '' },
      };
      setTiers(next);
      try {
        await bridge().invoke('tiers:set', { tiers: next });
        setNote('Saved.');
      } catch (err) {
        setNote(describeError(err).message);
      }
    },
    [choices, tiers],
  );

  return (
    <div data-testid="model-tiers">
      {choices.length === 0 ? (
        <p className="agent-card__prompt">
          Connect a provider first, and its models appear here to assign.
        </p>
      ) : (
        (['cheap', 'standard', 'frontier'] as const).map((tier) => (
          <div key={tier} className="field">
            <label className="field__label" htmlFor={`tier-${tier}`}>
              {tier}
            </label>
            <select
              id={`tier-${tier}`}
              className="control"
              data-testid={`tier-${tier}`}
              value={
                choices.find(
                  (choice) =>
                    choice.connectionId === tiers[tier].connectionId &&
                    choice.model === tiers[tier].model,
                )?.key ?? ''
              }
              onChange={(event) => {
                void bind(tier, event.target.value);
              }}
            >
              <option value="">Not set</option>
              {choices.map((choice) => (
                <option key={choice.key} value={choice.key}>
                  {choice.connectionLabel} · {choice.model}
                </option>
              ))}
            </select>
            <p className="agent-card__prompt">{TIER_BLURB[tier]}</p>
          </div>
        ))
      )}
      {note !== '' && <p className="agent-card__prompt">{note}</p>}
    </div>
  );
}
