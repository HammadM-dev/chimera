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
