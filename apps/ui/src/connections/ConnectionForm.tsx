import { useCallback, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import './connections.css';

// M1-11 requires the three demo connections to be created "through the UI".
// This is that surface: the minimal honest form — a label, a kind, an optional
// base URL for anything self-hosted, and a key that goes straight to the vault.

interface Props {
  kinds: string[];
  onCreated: () => void;
}

export function ConnectionForm({ kinds, onCreated }: Props): JSX.Element {
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [inlineKey, setInlineKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (label.trim() === '' || kind === '') return;
    setBusy(true);
    setError(null);
    try {
      await bridge().invoke('connection:create', {
        label: label.trim(),
        kind,
        ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
        ...(inlineKey === '' ? {} : { inlineKey }),
      });
      // Cleared immediately: the key was handed to the vault and this component
      // has no further use for it, so it should not sit in renderer state.
      setInlineKey('');
      setLabel('');
      setBaseUrl('');
      onCreated();
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }, [label, kind, baseUrl, inlineKey, onCreated]);

  return (
    <div className="connections__body" data-testid="connection-form">
      <div className="field">
        <label className="field__label" htmlFor="connection-label">
          Label
        </label>
        <input
          id="connection-label"
          className="control"
          data-testid="connection-label"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
          placeholder="Anthropic"
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="connection-kind">
          Provider
        </label>
        <select
          id="connection-kind"
          className="control"
          data-testid="connection-kind"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value);
          }}
        >
          <option value="">Choose a provider</option>
          {kinds.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="connection-base-url">
          Base URL
        </label>
        <input
          id="connection-base-url"
          className="control"
          data-testid="connection-base-url"
          value={baseUrl}
          onChange={(event) => {
            setBaseUrl(event.target.value);
          }}
          placeholder="Provider default"
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="connection-key">
          API key
        </label>
        <input
          id="connection-key"
          className="control"
          data-testid="connection-key"
          type="password"
          value={inlineKey}
          onChange={(event) => {
            setInlineKey(event.target.value);
          }}
          placeholder="Leave empty for a local provider"
        />
      </div>

      <button
        type="button"
        className="button connections__action"
        data-testid="connection-create"
        onClick={() => void submit()}
        disabled={busy}
      >
        {busy ? 'Adding' : 'Add connection'}
      </button>

      {error !== null && (
        <p className="connections__error" data-testid="connection-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
