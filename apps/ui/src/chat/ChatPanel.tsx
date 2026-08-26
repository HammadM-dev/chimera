import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError, type ChatDelta, type ConnectionSummary } from './useChimera.ts';
import { recordExchange } from '../shell/sessionMeter.ts';
import './chat.css';
import { PinButton } from '../views/ModelOptions.tsx';
import { usePinnedModels } from '../views/useConnections.ts';

// A conversation, not a text box.
//
// The first version replaced the answer in place and left the prompt sitting in
// the composer, so there was no record that you had asked anything and no way
// to see what you had asked two turns ago. What you said and what came back are
// both turns, they both stay on screen, and the composer empties when you send
// — which is what every person who has used a messaging app expects.

interface Usage {
  inputTokens: number;
  outputTokens: number;
}

type Phase = 'idle' | 'streaming' | 'done' | 'failed';

interface Turn {
  id: string;
  author: 'you' | 'agent';
  text: string;
}

export function ChatPanel(): JSX.Element {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [localOnlyMode, setLocalOnlyMode] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const { pinned } = usePinnedModels();
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  // The stream this panel is currently listening for. Deltas carry a streamId
  // so a late event from an abandoned request cannot overwrite a newer answer.
  const activeStream = useRef<string | null>(null);
  // The usage object already counted towards the session total. Identity, not
  // value: two identical exchanges are still two exchanges.
  const countedUsage = useRef<Usage | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

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
  }, [refreshConnections]);

  // Subscribed once for the panel's lifetime rather than per send: attaching a
  // listener after the invoke resolves would race the first delta, which on a
  // fast local model is the difference between seeing the answer and not.
  useEffect(() => {
    return bridge().on<ChatDelta>('chat:delta', (delta) => {
      if (delta.streamId !== activeStream.current) return;

      if (delta.type === 'text') {
        const text = delta.text ?? '';
        // Appended to the open agent turn. A new turn per delta would render
        // one bubble per token.
        setTurns((current) =>
          current.map((turn, index) =>
            index === current.length - 1 && turn.author === 'agent'
              ? { ...turn, text: turn.text + text }
              : turn,
          ),
        );
      } else if (delta.type === 'finish') {
        setUsage({ inputTokens: delta.inputTokens ?? 0, outputTokens: delta.outputTokens ?? 0 });
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

  // Keep the chosen model valid for the chosen connection. Switching to one
  // that does not serve the current model would send a request guaranteed to
  // fail, and the failure would look like ours.
  useEffect(() => {
    const models = connections.find((entry) => entry.id === selectedId)?.models ?? [];
    if (models.length === 0) return;
    setModel((current) => (models.includes(current) ? current : (models[0] ?? '')));
  }, [connections, selectedId]);

  // Follow the conversation as it grows, the way a message list does.
  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns]);

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (selectedId === '' || model.trim() === '' || text === '') return;

    const stamp = String(Date.now());
    setTurns((current) => [
      ...current,
      { id: `you-${stamp}`, author: 'you', text },
      { id: `agent-${stamp}`, author: 'agent', text: '' },
    ]);
    // Cleared on send. Leaving the prompt in the box is why the first version
    // felt like a form rather than a conversation.
    setPrompt('');
    setUsage(null);
    setCost(null);
    setError(null);
    setPhase('streaming');

    try {
      const { streamId } = await bridge().invoke<{ streamId: string }>('chat:send', {
        connectionId: selectedId,
        model: model.trim(),
        prompt: text,
      });
      activeStream.current = streamId;
    } catch (err) {
      // An invalid key surfaces here. Rendered inline as an ordinary result,
      // not thrown — an unhandled rejection would take the panel out.
      setError(describeError(err));
      setPhase('failed');
    }
  }, [selectedId, model, prompt]);

  // Pinned first here too. This picker lists one connection's models rather
  // than every choice in the workspace, so it cannot reuse `useConnections`'s
  // ordering — but a pin that worked in the canvas and not here would be
  // exactly the inconsistency pinning exists to remove.
  const availableModels = (() => {
    const all = connections.find((entry) => entry.id === selectedId)?.models ?? [];
    const keyOf = (one: string): string => `${selectedId}::${one}`;
    const kept = pinned.filter((key) => all.some((one) => keyOf(one) === key));
    return [
      ...kept.flatMap((key) => all.filter((one) => keyOf(one) === key)),
      ...all.filter((one) => !pinned.includes(keyOf(one))),
    ];
  })();
  const pinnedHere = availableModels.filter((one) => pinned.includes(`${selectedId}::${one}`));
  const restHere = availableModels.filter((one) => !pinned.includes(`${selectedId}::${one}`));
  const lastAgentTurn = [...turns].reverse().find((turn) => turn.author === 'agent');

  return (
    <section className="chat" data-testid="chat-panel" data-phase={phase}>
      <header className="chat__header">
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
          {/* A picker when the connection has an imported catalogue, a text box
              when it does not. Typing an exact model id from memory is not a
              thing anyone can do against a gateway serving hundreds. */}
          {availableModels.length > 0 ? (
            <div className="picker">
              <select
                id="chat-model"
                className="chat__control picker__select"
                data-testid="model-input"
                value={model}
                onChange={(event) => {
                  setModel(event.target.value);
                }}
              >
                {pinnedHere.length > 0 && (
                  <optgroup label="Pinned">
                    {pinnedHere.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </optgroup>
                )}
                {restHere.length > 0 &&
                  (pinnedHere.length > 0 ? (
                    <optgroup label="All models">
                      {restHere.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    restHere.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))
                  ))}
              </select>
              <PinButton modelKey={model === '' ? '' : `${selectedId}::${model}`} />
            </div>
          ) : (
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
          )}
        </div>

        {localOnlyMode && (
          <span className="chat__badge" data-testid="local-only-badge">
            Local-only mode
          </span>
        )}
      </header>

      <div className="chat__transcript scroll" ref={transcriptRef}>
        <div className="chat__column">
          {turns.length === 0 && (
            <p className="chat__placeholder">
              {connections.length === 0
                ? 'Add a provider, or import OmniRoute, to start.'
                : 'Send a message to try a provider before you put it in an automation.'}
            </p>
          )}

          {turns.map((turn) => (
            <article
              key={turn.id}
              className={`turn turn--${turn.author === 'you' ? 'you' : 'agent'}`}
            >
              <p className="turn__author">{turn.author === 'you' ? 'You' : 'Agent'}</p>
              <p
                className="turn__text"
                {...(turn.id === lastAgentTurn?.id ? { 'data-testid': 'chat-answer' } : {})}
              >
                {turn.text}
              </p>
            </article>
          ))}

          {error && (
            <p className="chat__error" data-testid="chat-error" role="alert">
              {error.message}
            </p>
          )}
        </div>
      </div>

      <div className="chat__composer">
        <div className="chat__composer-inner">
          <textarea
            className="chat__prompt"
            data-testid="prompt-input"
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
            }}
            onKeyDown={(event) => {
              // Enter sends, shift-Enter breaks the line — the convention every
              // messaging app shares, and the one people try first.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Ask something"
            rows={2}
          />

          <div className="chat__actions">
            <footer className="chat__meter" data-testid="chat-meter">
              <span data-testid="token-count">
                {usage
                  ? `${String(usage.inputTokens)} in · ${String(usage.outputTokens)} out`
                  : '— tokens'}
              </span>
              <span data-testid="cost-estimate">
                {/* An unpriced model shows "not priced", never $0.00: reading
                    "free" off a model nobody has a rate for is the one wrong
                    answer here that costs money. */}
                {cost === null ? (usage ? 'Not priced' : '— cost') : `$${cost.toFixed(6)}`}
              </span>
            </footer>

            <button
              type="button"
              className="button button--primary"
              data-testid="send-button"
              onClick={() => void send()}
              disabled={phase === 'streaming'}
            >
              {phase === 'streaming' ? 'Sending' : 'Send message'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
