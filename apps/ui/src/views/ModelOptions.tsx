import type { JSX } from 'react';
import { usePinnedModels, type ModelChoice } from './useConnections.ts';
import './picker.css';

// One model picker, used everywhere there is one.
//
// A workspace that connects OpenRouter gets four hundred models in a dropdown,
// and the two anybody actually uses are somewhere in the middle of it. Pinning
// puts those at the top; this is the control that shows them there and the
// button that puts them there, kept together so the two cannot disagree.
//
// Deliberately one component rather than a copy per section. The pickers had
// already drifted — three of them rendered the same list three slightly
// different ways — and a pin that worked in the canvas but not in the swarm
// would be a worse version of no pinning at all.

export function ModelOptions({
  choices,
  value,
  onChange,
  testId,
  tiers = false,
  placeholder = 'Choose a model',
}: {
  choices: readonly ModelChoice[];
  value: string;
  onChange: (value: string) => void;
  testId: string;
  /** Offer the workspace's tiers as well. Only the canvas wants them. */
  tiers?: boolean;
  placeholder?: string;
}): JSX.Element {
  const pinned = choices.filter((choice) => choice.pinned === true);
  const rest = choices.filter((choice) => choice.pinned !== true);

  const option = (choice: ModelChoice): JSX.Element => (
    <option key={choice.key} value={choice.key}>
      {choice.connectionLabel} · {choice.model}
    </option>
  );

  return (
    <select
      className="control picker__select"
      data-testid={testId}
      aria-label="Model"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      {placeholder !== '' && <option value="">{placeholder}</option>}
      {tiers && (
        <>
          <option value="tier:cheap">Cheap tier — whatever this workspace calls cheap</option>
          <option value="tier:standard">Standard tier</option>
          <option value="tier:frontier">Frontier tier</option>
        </>
      )}
      {/* Grouped rather than merely sorted. A pinned model at the top of an
          otherwise identical list is indistinguishable from the provider
          happening to return it first; a labelled group says why it is there. */}
      {pinned.length > 0 && <optgroup label="Pinned">{pinned.map(option)}</optgroup>}
      {rest.length > 0 &&
        (pinned.length > 0 ? (
          <optgroup label="All models">{rest.map(option)}</optgroup>
        ) : (
          rest.map(option)
        ))}
    </select>
  );
}

/**
 * Pins whatever the picker beside it currently holds.
 *
 * Next to the control rather than inside it: a `<select>` cannot carry a button
 * per option, and putting the pin in a separate settings screen would mean
 * leaving the thing you are configuring to say which model you use for it.
 *
 * Disabled for a tier, which is not a model — pinning "whatever this workspace
 * calls cheap" would be pinning a rule rather than a choice.
 */
export function PinButton({ modelKey }: { modelKey: string }): JSX.Element | null {
  const { isPinned, toggle } = usePinnedModels();
  const real = modelKey !== '' && !modelKey.startsWith('tier:');
  if (!real) return null;

  const on = isPinned(modelKey);
  return (
    <button
      type="button"
      className={`picker__pin${on ? ' picker__pin--on' : ''}`}
      data-testid="model-pin"
      aria-pressed={on}
      title={on ? 'Unpin this model' : 'Pin this model to the top of every picker'}
      onClick={() => {
        toggle(modelKey);
      }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        {/* A drawing pin seen from the side: head, shaft, point. Not a star —
            a star means "favourite" and this is closer to "keep this to hand". */}
        <path
          d="M6 2h4l-.6 3.2 2.1 2.3H4.5l2.1-2.3z"
          fill={on ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
        <path d="M8 7.5V14" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
      <span className="picker__pinLabel">{on ? 'Pinned' : 'Pin'}</span>
    </button>
  );
}
