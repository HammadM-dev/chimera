import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError, type ChatDelta, type ConnectionSummary } from './useChimera.ts';
import { recordExchange } from '../shell/sessionMeter.ts';
import './chat.css';

// M1-10's minimal chat panel: pick a connection, send a message, watch the
// answer stream in with a live token and cost readout. Not the workflow canvas
// — that is M4. This exists to prove the provider layer works end to end from
// the renderer, and to be the surface M1-11 demos.

interface Usage {
  inputTokens: number;
  outputTokens: number;
}

type Phase = 'idle' | 'streaming' | 'done' | 'failed';

interface Props {
  /** Bumped by the connection form so a new connection appears without a reload. */
  refreshToken: number;
}

export function ChatPanel({ refreshToken }: Props): JSX.Element {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [localOnlyMode, setLocalOnlyMode] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState('');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  // The stream this panel is currently listening for. Deltas carry a streamId
  // so a late event from an abandoned request cannot overwrite a newer answer.
  const activeStream = useRef<string | null>(null);
  // The usage object already counted towards the session total. Identity, not
  // value: two identical exchanges are still two exchanges, and editing the
  // model box after a run must not bill the session a second time.
  const countedUsage = useRef<Usage | null>(null);

  const refreshConnections = useCallback(async () => {
    try {
      const result = await bridge().invoke<{
        connections: ConnectionSummary[];
        localOnlyMode: boolean;
      }>('connection:list', {});
      setConnections(result.connections);
      setLocalOnlyMode(result.localOnlyMode);
      setSelectedId((current) => current || (result.connections[0]?.id ?? ''));
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections, refreshToken]);

  // Subscribed once for the panel's lifetime rather than per send: attaching a
  // listener after the invoke resolves would race the first delta, which on a
  // fast local model is the difference between seeing the answer and not.
  useEffect(() => {
    return bridge().on<ChatDelta>('chat:delta', (delta) => {
      if (delta.streamId !== activeStream.current) return;

      if (delta.type === 'text') {
        setAnswer((current) => current + (delta.text ?? ''));
      } else if (delta.type === 'finish') {
        setUsage({
          inputTokens: delta.inputTokens ?? 0,
          outputTokens: delta.outputTokens ?? 0,
        });
        setPhase('done');
      } else if (delta.type === 'error') {
        setError({
          code: delta.errorCode ?? 'UNKNOWN',
          message: delta.errorMessage ?? 'The provider stopped without explanation.',
        });
        setPhase('failed');
      }
    });
  }, []);

  // Cost is recomputed from usage rather than accumulated as deltas arrive:
  // only the finish event carries authoritative token counts, and a running
  // total derived from character counts would be a guess presented as a figure.
  useEffect(() => {
    if (!usage || model === '') {
      setCost(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await bridge().invoke<{ cost: number | null }>('chat:estimateCost', {
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        if (cancelled) return;
        setCost(result.cost);
        if (countedUsage.current !== usage) {
          countedUsage.current = usage;
          recordExchange(result.cost);
        }
      } catch {
        if (!cancelled) setCost(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [usage, model]);

  const send = useCallback(async () => {
    if (selectedId === '' || model.trim() === '' || prompt.trim() === '') return;

    setAnswer('');
    setUsage(null);
    setCost(null);
    setError(null);
    setPhase('streaming');

    try {
      const { streamId } = await bridge().invoke<{ streamId: string }>('chat:send', {
        connectionId: selectedId,
        model: model.trim(),
        prompt: prompt.trim(),
      });
      activeStream.current = streamId;
    } catch (err) {
      // An invalid key surfaces here as ProviderAuthError. Rendered inline as
      // an ordinary result, not thrown — an unhandled rejection would take the
      // panel out and tell the user nothing.
      setError(describeError(err));
      setPhase('failed');
    }
  }, [selectedId, model, prompt]);

  return (
    <section className="chat" data-testid="chat-panel" data-phase={phase}>
      <header className="chat__header">
        <h2 className="chat__title">Chat</h2>
        {localOnlyMode && (
          <span className="chat__badge" data-testid="local-only-badge">
            Local-only mode
          </span>
        )}
      </header>

      <div className="chat__controls">
        <label className="chat__label" htmlFor="chat-connection">
          Connection
        </label>
        <select
          id="chat-connection"
          className="chat__control"
          data-testid="connection-select"
          value={selectedId}
          onChange={(event) => {
            setSelectedId(event.target.value);
          }}
        >
          {connections.length === 0 && <option value="">No connections yet</option>}
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.label} ({connection.healthState})
            </option>
          ))}
        </select>

        <label className="chat__label" htmlFor="chat-model">
          Model
        </label>
        <input
          id="chat-model"
          className="chat__control"
          data-testid="model-input"
          value={model}
          onChange={(event) => {
            setModel(event.target.value);
          }}
          placeholder="claude-opus-5"
        />
      </div>

      <textarea
        className="chat__prompt"
        data-testid="prompt-input"
        value={prompt}
        onChange={(event) => {
          setPrompt(event.target.value);
        }}
        placeholder="Ask something"
        rows={3}
      />

      <button
        type="button"
        className="chat__send"
        data-testid="send-button"
        onClick={() => void send()}
        disabled={phase === 'streaming'}
      >
        {phase === 'streaming' ? 'Sending' : 'Send message'}
      </button>

      {error && (
        <p className="chat__error" data-testid="chat-error" role="alert">
          {error.message}
        </p>
      )}

      <pre className="chat__answer" data-testid="chat-answer">
        {answer}
      </pre>

      <footer className="chat__meter" data-testid="chat-meter">
        <span data-testid="token-count">
          {usage
            ? `${String(usage.inputTokens)} in · ${String(usage.outputTokens)} out`
            : '— tokens'}
        </span>
        <span data-testid="cost-estimate">
          {/* An unpriced model shows "not priced", never $0.00: reading "free"
              off a model nobody has a rate for is the one wrong answer here
              that costs money. */}
          {cost === null ? (usage ? 'Not priced' : '— cost') : `$${cost.toFixed(6)}`}
        </span>
      </footer>
    </section>
  );
}
