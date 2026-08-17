import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import './memory.css';

// Everything the agents and the user know, in one place.
//
// Grouped by kind rather than listed by date, because "what does it know about
// my goals" is a question a person actually has and "what did it learn on
// Tuesday" is not. Every entry shows who wrote it and how sure they were: a
// memory store that renders an agent's inference the same as a user's statement
// teaches the next agent to trust a guess.

interface Memory {
  id: string;
  kind: string;
  subject: string;
  body: string;
  source: string;
  runId: string | null;
  confidence: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface Backend {
  name: string;
  available: boolean;
  detail: string;
}

const KINDS = [
  { id: 'goal', label: 'Goals', blurb: 'What you are trying to achieve' },
  { id: 'project', label: 'Projects', blurb: 'What you are working on' },
  { id: 'preference', label: 'Preferences', blurb: 'How you want things done' },
  { id: 'habit', label: 'Habits', blurb: 'What you do regularly' },
  { id: 'decision', label: 'Decisions', blurb: 'What was settled, and why' },
  { id: 'person', label: 'People', blurb: 'Who matters, and how' },
  { id: 'tool', label: 'Tools', blurb: 'What you use' },
  { id: 'fact', label: 'Facts', blurb: 'Everything else worth keeping' },
];

function relative(iso: string): string {
  const seconds = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

function confidenceLabel(value: number): string {
  if (value >= 0.99) return 'stated';
  if (value >= 0.75) return 'confident';
  if (value >= 0.5) return 'likely';
  return 'unsure';
}

export function MemoryView(): JSX.Element {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [backend, setBackend] = useState<Backend | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ kind: 'fact', subject: '', body: '' });

  const load = useCallback(async (search: string) => {
    try {
      const result = await bridge().invoke<{
        memories: Memory[];
        counts: Record<string, number>;
        backend: Backend;
      }>('memory:list', search === '' ? {} : { query: search });
      setMemories(result.memories);
      setCounts(result.counts);
      setBackend(result.backend);
      setError(null);
    } catch (err) {
      setError(describeError(err).message);
    }
  }, []);

  useEffect(() => {
    // Debounced, so typing a search does not fire a query per keystroke against
    // a store that will grow.
    const timer = setTimeout(() => void load(query), query === '' ? 0 : 200);
    return () => {
      clearTimeout(timer);
    };
  }, [load, query]);

  const grouped = useMemo(() => {
    const byKind = new Map<string, Memory[]>();
    for (const memory of memories) {
      byKind.set(memory.kind, [...(byKind.get(memory.kind) ?? []), memory]);
    }
    return KINDS.map((kind) => ({ ...kind, items: byKind.get(kind.id) ?? [] })).filter(
      (kind) => active === null || active === kind.id,
    );
  }, [memories, active]);

  const total = memories.length;

  const add = useCallback(async () => {
    if (draft.subject.trim() === '' || draft.body.trim() === '') return;
    try {
      await bridge().invoke('memory:write', {
        kind: draft.kind,
        subject: draft.subject.trim(),
        body: draft.body.trim(),
      });
      setDraft({ kind: 'fact', subject: '', body: '' });
      setAdding(false);
      await load(query);
    } catch (err) {
      setError(describeError(err).message);
    }
  }, [draft, load, query]);

  const forget = useCallback(
    async (id: string) => {
      try {
        await bridge().invoke('memory:forget', { id });
        await load(query);
      } catch (err) {
        setError(describeError(err).message);
      }
    },
    [load, query],
  );

  return (
    <div className="memory" data-testid="memory-view">
      <header className="memory__bar">
        <input
          className="control memory__search"
          data-testid="memory-search"
          value={query}
          placeholder="Search everything remembered"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <button
          type="button"
          className="button"
          data-testid="memory-add"
          onClick={() => {
            setAdding((open) => !open);
          }}
        >
          {adding ? 'Cancel' : 'Add a memory'}
        </button>
      </header>

      {adding && (
        <div className="memory__composer">
          <select
            className="control memory__kind"
            data-testid="memory-draft-kind"
            value={draft.kind}
            onChange={(event) => {
              setDraft((current) => ({ ...current, kind: event.target.value }));
            }}
          >
            {KINDS.map((kind) => (
              <option key={kind.id} value={kind.id}>
                {kind.label}
              </option>
            ))}
          </select>
          <input
            className="control"
            data-testid="memory-draft-subject"
            value={draft.subject}
            placeholder="What is it about?"
            onChange={(event) => {
              setDraft((current) => ({ ...current, subject: event.target.value }));
            }}
          />
          <input
            className="control"
            data-testid="memory-draft-body"
            value={draft.body}
            placeholder="The thing itself"
            onChange={(event) => {
              setDraft((current) => ({ ...current, body: event.target.value }));
            }}
          />
          <button
            type="button"
            className="button button--primary"
            data-testid="memory-draft-save"
            onClick={() => void add()}
          >
            Remember
          </button>
        </div>
      )}

      <div className="memory__filters" data-testid="memory-filters">
        <button
          type="button"
          className={`memory__filter ${active === null ? 'memory__filter--on' : ''}`}
          onClick={() => {
            setActive(null);
          }}
        >
          Everything <span className="memory__count">{total}</span>
        </button>
        {KINDS.map((kind) => (
          <button
            key={kind.id}
            type="button"
            className={`memory__filter ${active === kind.id ? 'memory__filter--on' : ''}`}
            data-testid={`memory-filter-${kind.id}`}
            onClick={() => {
              setActive((current) => (current === kind.id ? null : kind.id));
            }}
          >
            {kind.label} <span className="memory__count">{counts[kind.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {error !== null && <p className="memory__error">{error}</p>}

      <div className="memory__body scroll">
        {total === 0 ? (
          <p className="memory__empty" data-testid="memory-empty">
            Nothing remembered yet. Agents write here as they work — what they learned, what you
            prefer, what was decided — and you can add anything yourself.
          </p>
        ) : (
          grouped
            .filter((kind) => kind.items.length > 0)
            .map((kind) => (
              <section key={kind.id} className="memory__group">
                <div className="memory__group-head">
                  <h3 className="memory__group-title">{kind.label}</h3>
                  <p className="memory__group-blurb">{kind.blurb}</p>
                </div>
                <div className="memory__cards">
                  {kind.items.map((memory) => (
                    <article key={memory.id} className="memory-card" data-testid="memory-card">
                      <header className="memory-card__head">
                        <h4 className="memory-card__subject">{memory.subject}</h4>
                        <button
                          type="button"
                          className="memory-card__forget"
                          aria-label={`Forget ${memory.subject}`}
                          onClick={() => void forget(memory.id)}
                        >
                          ×
                        </button>
                      </header>
                      <p className="memory-card__body">{memory.body}</p>
                      <footer className="memory-card__meta">
                        <span
                          className={`memory-card__source memory-card__source--${
                            memory.source === 'user' ? 'user' : 'agent'
                          }`}
                        >
                          {memory.source === 'user' ? 'You' : memory.source}
                        </span>
                        <span
                          className="memory-card__confidence"
                          title={`Confidence ${memory.confidence.toFixed(2)}`}
                        >
                          {confidenceLabel(memory.confidence)}
                        </span>
                        <span>{relative(memory.updatedAt)}</span>
                      </footer>
                    </article>
                  ))}
                </div>
              </section>
            ))
        )}
      </div>

      {backend && (
        <footer className="memory__backend" data-testid="memory-backend">
          <span className={`chip ${backend.available ? 'chip--ok' : 'chip--warn'}`} />
          {backend.name}
          {backend.detail !== '' && (
            <span className="memory__backend-detail">{backend.detail}</span>
          )}
        </footer>
      )}
    </div>
  );
}
