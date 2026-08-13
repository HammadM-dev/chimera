import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import './onboarding.css';

// First launch: welcome, choose where models come from, connect one.
//
// It stops at exactly one connected provider. An onboarding that also explained
// agents, the canvas and the Governor would be a manual, and nobody reads a
// manual before they have seen the thing work once.

type Step = 'welcome' | 'choose' | 'omniroute' | 'cloud' | 'local' | 'done';

interface Props {
  onDone: () => void;
}

const CLOUD_KINDS = [
  { kind: 'anthropic', label: 'Anthropic' },
  { kind: 'openai', label: 'OpenAI' },
  { kind: 'google', label: 'Google' },
  { kind: 'openrouter', label: 'OpenRouter' },
];

const LOCAL_KINDS = [
  { kind: 'ollama', label: 'Ollama' },
  { kind: 'lmstudio', label: 'LM Studio' },
];

/** The step order, for the progress pips. `done` is an outcome, not a stop. */
const ORDER: Step[] = ['welcome', 'choose', 'omniroute'];

export function Onboarding({ onDone }: Props): JSX.Element {
  const [step, setStep] = useState<Step>('welcome');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // OmniRoute
  const [detected, setDetected] = useState<{
    found: boolean;
    models: number;
    baseUrl: string;
  } | null>(null);

  // Cloud and local
  const [kind, setKind] = useState('anthropic');
  const [label, setLabel] = useState('Anthropic');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [connected, setConnected] = useState('');

  // Armed after mount, so the entrance runs when the element is on screen
  // rather than ticking while the window is still hidden — the same trap the
  // splash fell into, where a zero-delay animation was already in its active
  // phase at mount.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setArmed(true);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  const check = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await bridge().invoke<{
        state: 'detected' | 'not-detected';
        baseUrl: string;
        modelCount: number;
      }>('omniroute:detect', {});
      setDetected({
        found: result.state === 'detected',
        models: result.modelCount,
        baseUrl: result.baseUrl,
      });
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const importOmniRoute = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await bridge().invoke<{ connectionId: string; modelCount: number }>(
        'omniroute:import',
        {},
      );
      if (result.connectionId === '') {
        setError('OmniRoute stopped answering before the import finished. Check it is running.');
        return;
      }
      setConnected(`OmniRoute · ${String(result.modelCount)} models`);
      setStep('done');
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const createConnection = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await bridge().invoke('connection:create', {
        label: label.trim() === '' ? kind : label.trim(),
        kind,
        ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
        ...(apiKey === '' ? {} : { inlineKey: apiKey }),
      });
      // Cleared the moment it has been handed to the vault. This component has
      // no further use for it and should not be holding one in state.
      setApiKey('');
      setConnected(label.trim() === '' ? kind : label.trim());
      setStep('done');
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }, [kind, label, baseUrl, apiKey]);

  const pip = (index: number): string =>
    `intro__pip ${ORDER.indexOf(step) >= index || step === 'done' ? 'intro__pip--on' : ''}`;

  return (
    <div className="intro" data-armed={armed} data-testid="onboarding" data-step={step}>
      <div className="intro__card">
        {step === 'welcome' && (
          <div className="intro__step" key="welcome">
            <p className="intro__eyebrow">Welcome</p>
            <h1 className="intro__title">Build teams of agents that do the work.</h1>
            <p className="intro__body">
              CHIMERA runs agents against your own model providers, inside limits you set. Every
              model call and every tool call goes through one checkpoint, so a run can be stopped by
              a budget rather than by you noticing.
            </p>
            <p className="intro__note">
              One thing first: where your models come from. It takes a minute, and nothing works
              without it.
            </p>
            <div className="intro__actions">
              <button
                type="button"
                className="button button--ghost"
                data-testid="intro-skip"
                onClick={onDone}
              >
                Skip for now
              </button>
              <button
                type="button"
                className="button button--primary"
                data-testid="intro-start"
                onClick={() => {
                  setStep('choose');
                }}
              >
                Choose a provider
              </button>
            </div>
          </div>
        )}

        {step === 'choose' && (
          <div className="intro__step" key="choose">
            <p className="intro__eyebrow">Step 1 of 2</p>
            <h1 className="intro__title">Where should models come from?</h1>
            <div className="intro__choices">
              <button
                type="button"
                className="intro__choice"
                data-testid="choose-omniroute"
                onClick={() => {
                  setStep('omniroute');
                  void check();
                }}
              >
                <span className="intro__choice-title">OmniRoute</span>
                <span className="intro__choice-detail">
                  A gateway you run and sign in to yourself. One connection, every model it serves.
                </span>
              </button>
              <button
                type="button"
                className="intro__choice"
                data-testid="choose-cloud"
                onClick={() => {
                  setStep('cloud');
                }}
              >
                <span className="intro__choice-title">A provider API key</span>
                <span className="intro__choice-detail">
                  Anthropic, OpenAI, Google or OpenRouter. The key goes to your OS keychain, never
                  the database.
                </span>
              </button>
              <button
                type="button"
                className="intro__choice"
                data-testid="choose-local"
                onClick={() => {
                  setStep('local');
                  setKind('ollama');
                  setLabel('Ollama');
                }}
              >
                <span className="intro__choice-title">A model on this machine</span>
                <span className="intro__choice-detail">
                  Ollama or LM Studio. Nothing leaves the machine, and nothing costs anything.
                </span>
              </button>
            </div>
            <div className="intro__actions">
              <button
                type="button"
                className="button button--ghost"
                data-testid="intro-skip"
                onClick={onDone}
              >
                Skip for now
              </button>
              <div className="intro__progress">
                <span className={pip(0)} />
                <span className={pip(1)} />
                <span className={pip(2)} />
              </div>
            </div>
          </div>
        )}

        {step === 'omniroute' && (
          <div className="intro__step" key="omniroute">
            <p className="intro__eyebrow">Step 2 of 2 · OmniRoute</p>
            <h1 className="intro__title">Set OmniRoute up, then CHIMERA will find it.</h1>
            <ol className="intro__steps">
              <li>
                <span>
                  Install OmniRoute and start it. CHIMERA does not install or update it for you.
                </span>
              </li>
              <li>
                <span>
                  Sign in to your own provider accounts inside OmniRoute. CHIMERA never supplies
                  tokens — the accounts and the billing stay yours.
                </span>
              </li>
              <li>
                <span>
                  Leave it running on its default address,{' '}
                  <code className="intro__code">
                    {detected?.baseUrl ?? 'http://localhost:20128'}
                  </code>
                  .
                </span>
              </li>
              <li>
                <span>
                  Come back here and check. Its whole model catalogue imports in one step.
                </span>
              </li>
            </ol>

            {detected !== null && (
              <p className="intro__status" data-testid="intro-detect-result">
                {detected.found ? (
                  <>
                    <span className="chip chip--ok" />
                    Found it — {detected.models} models ready to import.
                  </>
                ) : (
                  <>
                    <span className="chip chip--warn" />
                    Nothing answering yet on {detected.baseUrl}.
                  </>
                )}
              </p>
            )}

            {error !== null && <p className="intro__error">{error}</p>}

            <div className="intro__actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  setStep('choose');
                }}
              >
                Back
              </button>
              {detected?.found === true ? (
                <button
                  type="button"
                  className="button button--primary"
                  data-testid="intro-import"
                  disabled={busy}
                  onClick={() => void importOmniRoute()}
                >
                  {busy ? 'Importing' : 'Import models'}
                </button>
              ) : (
                <button
                  type="button"
                  className="button button--primary"
                  data-testid="intro-check"
                  disabled={busy}
                  onClick={() => void check()}
                >
                  {busy ? 'Checking' : 'Check for OmniRoute'}
                </button>
              )}
            </div>
          </div>
        )}

        {(step === 'cloud' || step === 'local') && (
          <div className="intro__step" key={step}>
            <p className="intro__eyebrow">Step 2 of 2</p>
            <h1 className="intro__title">
              {step === 'cloud' ? 'Connect a provider.' : 'Point CHIMERA at your local model.'}
            </h1>

            <div className="field">
              <label className="field__label" htmlFor="intro-kind">
                Provider
              </label>
              <select
                id="intro-kind"
                className="control"
                data-testid="intro-kind"
                value={kind}
                onChange={(event) => {
                  const chosen = event.target.value;
                  setKind(chosen);
                  setLabel(
                    [...CLOUD_KINDS, ...LOCAL_KINDS].find((entry) => entry.kind === chosen)
                      ?.label ?? chosen,
                  );
                }}
              >
                {(step === 'cloud' ? CLOUD_KINDS : LOCAL_KINDS).map((entry) => (
                  <option key={entry.kind} value={entry.kind}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>

            {step === 'cloud' ? (
              <div className="field">
                <label className="field__label" htmlFor="intro-key">
                  API key
                </label>
                <input
                  id="intro-key"
                  className="control"
                  data-testid="intro-key"
                  type="password"
                  value={apiKey}
                  placeholder="Pasted here, stored in your OS keychain"
                  onChange={(event) => {
                    setApiKey(event.target.value);
                  }}
                />
              </div>
            ) : (
              <div className="field">
                <label className="field__label" htmlFor="intro-base-url">
                  Address
                </label>
                <input
                  id="intro-base-url"
                  className="control"
                  data-testid="intro-base-url"
                  value={baseUrl}
                  placeholder="Leave empty for the provider default"
                  onChange={(event) => {
                    setBaseUrl(event.target.value);
                  }}
                />
              </div>
            )}

            {error !== null && <p className="intro__error">{error}</p>}

            <div className="intro__actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  setStep('choose');
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="button button--primary"
                data-testid="intro-connect"
                disabled={busy || (step === 'cloud' && apiKey === '')}
                onClick={() => void createConnection()}
              >
                {busy ? 'Connecting' : 'Connect'}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="intro__step" key="done">
            <p className="intro__eyebrow">Ready</p>
            <h1 className="intro__title">{connected} is connected.</h1>
            <p className="intro__body">
              Open Automations to drag agents onto the canvas and choose which model runs each one.
              Test a model first if you want to see one answer before you build anything.
            </p>
            <div className="intro__actions">
              <span className="intro__status" data-testid="intro-connected">
                <span className="chip chip--ok" />
                {connected}
              </span>
              <button
                type="button"
                className="button button--primary"
                data-testid="intro-finish"
                onClick={onDone}
              >
                Start building
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
