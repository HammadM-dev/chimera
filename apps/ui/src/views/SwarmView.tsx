import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import { useConnections } from './useConnections.ts';
import './swarm.css';
import { SwarmGraph, type GraphData, type Stance } from './SwarmGraph.tsx';

// The swarm section: a population, and every question ever put to it.
//
// Laid out as a conversation because that is what it is. You ask a crowd
// something, they argue, you read what happened, and then you ask them the
// follow-up — the same crowd, which is the whole point of a thread rather than
// a series of runs. Asking "and if the price were double?" of a *different*
// population would be answering a different question.

interface Thread {
  id: string;
  name: string;
  updatedAt: string;
  source: string;
}

interface Distribution {
  for: number;
  against: number;
  undecided: number;
  weighted: number;
}

interface Round {
  round: number;
  movement: number;
  distribution: Distribution;
  said: { name: string; position: number; said: string }[];
  /** Absent on rounds recorded before the graph existed. */
  stances?: Stance[];
}

interface Result {
  mode: 'everyone' | 'archetypes';
  population: number;
  thinking: number;
  stopped: 'settled' | 'rounds' | 'cancelled';
  final: Distribution;
  rounds: Round[];
  personas: { id: string; name: string; description: string; kind: string; influence: number }[];
  /** Absent on threads recorded before the graph existed. */
  graph?: GraphData;
}

interface Turn {
  id: string;
  seq: number;
  asked: string;
  answer: string;
  result: Result | null;
  createdAt: string;
}

interface ThreadDetail extends Thread {
  question: string;
  createdAt: string;
  turns: Turn[];
}

/**
 * The split, as a bar.
 *
 * A number nobody can picture is a number nobody checks. The weighted reading
 * sits under it as a separate mark, because it is a different claim from the
 * headcount and reading them as one is the mistake this section exists to
 * avoid.
 */
function Split({ split }: { split: Distribution }): JSX.Element {
  const total = Math.max(1, split.for + split.against + split.undecided);
  const share = (value: number): string => `${String((value / total) * 100)}%`;

  return (
    <div className="split" data-testid="swarm-split">
      <div className="split__bar" role="img" aria-label="How the population divided">
        <span className="split__part split__part--for" style={{ width: share(split.for) }} />
        <span
          className="split__part split__part--undecided"
          style={{ width: share(split.undecided) }}
        />
        <span
          className="split__part split__part--against"
          style={{ width: share(split.against) }}
        />
      </div>
      <p className="split__legend">
        <span className="split__key split__key--for" /> {split.for} for
        <span className="split__key split__key--undecided" /> {split.undecided} undecided
        <span className="split__key split__key--against" /> {split.against} against
        <span className="split__weighted">
          weighted {split.weighted > 0 ? '+' : ''}
          {split.weighted.toFixed(2)}
        </span>
      </p>
    </div>
  );
}

/** Where a persona stands, as a dot on a line from against to for. */
function Voice({
  voice,
}: {
  voice: { name: string; position: number; said: string };
}): JSX.Element {
  const at = `${String(((voice.position + 1) / 2) * 100)}%`;
  return (
    <li className="voice">
      <span className="voice__name">{voice.name}</span>
      <span className="voice__line" aria-hidden="true">
        <span
          className="voice__dot"
          style={{ left: at }}
          data-side={voice.position >= 0 ? 'for' : 'against'}
        />
      </span>
      <span className="voice__said">{voice.said}</span>
    </li>
  );
}

export interface SwarmViewProps {
  /** A thread to open on arrival, when the canvas sent somebody here. */
  openId?: string;
  /** Called once that thread has been opened, so it is not reopened for good. */
  onOpened?: () => void;
}

export function SwarmView({ openId, onOpened }: SwarmViewProps = {}): JSX.Element {
  const { choices } = useConnections();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [open, setOpen] = useState<ThreadDetail | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [stances, setStances] = useState<Stance[]>([]);
  const [live, setLive] = useState<Round | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelKey, setModelKey] = useState('');
  const [population, setPopulation] = useState(300);
  const [maxRounds, setMaxRounds] = useState(4);
  const [everyoneUpTo, setEveryoneUpTo] = useState(24);
  const [renaming, setRenaming] = useState('');
  const tail = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await bridge().invoke<{ threads: Thread[] }>('swarm:list', {});
      setThreads(result.threads);
    } catch (err) {
      setError(describeError(err).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Rounds as they land. A population of two thousand takes a minute, and a
  // minute of spinner is a minute of wondering whether it broke.
  useEffect(() => {
    return bridge().on<GraphData & { swarmId: string }>('swarm:population', (population) => {
      setGraph(population);
      setStances([]);
    });
  }, []);

  useEffect(() => {
    return bridge().on<Round & { swarmId: string; stances?: Stance[] }>('swarm:round', (round) => {
      setLive(round);
      if (round.stances) setStances(round.stances);
    });
  }, []);

  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [open?.turns.length, live]);

  const openThread = useCallback(async (id: string) => {
    setLive(null);
    try {
      const result = await bridge().invoke<{ thread: ThreadDetail | null }>('swarm:get', { id });
      setOpen(result.thread);
    } catch (err) {
      setError(describeError(err).message);
    }
  }, []);

  // Sent here from a swarm step on the canvas, with the thread it made.
  useEffect(() => {
    if (openId === undefined || openId === '') return;
    void (async () => {
      await openThread(openId);
      onOpened?.();
    })();
  }, [openId, openThread, onOpened]);

  const ask = useCallback(async () => {
    const asked = question.trim();
    if (asked === '') return;

    const chosen = modelKey === '' ? choices[0] : choices.find((choice) => choice.key === modelKey);
    if (!chosen) {
      setError('Connect a provider first — Providers, then add one.');
      return;
    }

    setAsking(true);
    setError(null);
    setQuestion('');
    setLive(null);

    try {
      const answer = await bridge().invoke<{ threadId: string; name: string; turn: Turn }>(
        'swarm:ask',
        {
          ...(open === null ? {} : { threadId: open.id }),
          question: asked,
          settings: {
            connectionId: chosen.connectionId,
            model: chosen.model,
            population,
            maxRounds,
            everyoneUpTo,
          },
        },
      );

      await openThread(answer.threadId);
      await refresh();
    } catch (err) {
      setError(describeError(err).message);
      setQuestion(asked);
    } finally {
      setAsking(false);
      setLive(null);
    }
  }, [choices, everyoneUpTo, maxRounds, modelKey, open, openThread, population, question, refresh]);

  return (
    <div className="swarm" data-testid="swarm-view" data-list={listOpen ? 'open' : 'closed'}>
      <aside className={`swarm__list${listOpen ? '' : ' swarm__list--closed'}`} aria-label="Swarms">
        <button
          type="button"
          className="panel-toggle panel-toggle--palette"
          data-testid="swarm-list-toggle"
          aria-expanded={listOpen}
          aria-label={listOpen ? 'Hide swarms' : 'Show swarms'}
          onClick={() => {
            setListOpen((current) => !current);
          }}
        >
          {listOpen ? '‹' : '›'}
        </button>

        <button
          type="button"
          className="button button--primary swarm__new"
          data-testid="swarm-new"
          onClick={() => {
            setOpen(null);
            setLive(null);
            setQuestion('');
          }}
        >
          New swarm
        </button>

        <div className="swarm__threads scroll">
          {threads.length === 0 && <p className="swarm__empty">Nothing yet.</p>}
          {threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className={`swarm__thread${open?.id === thread.id ? ' swarm__thread--on' : ''}`}
              data-testid={`swarm-thread-${thread.id}`}
              onClick={() => void openThread(thread.id)}
            >
              <span className="swarm__threadName">{thread.name}</span>
              {thread.source !== 'manual' && (
                <span className="swarm__fromRun" title="Started by an automation">
                  from a run
                </span>
              )}
            </button>
          ))}
        </div>
      </aside>

      <main className="swarm__main">
        <header className="swarm__head">
          {open === null ? (
            <h1 className="swarm__title">Ask a crowd</h1>
          ) : renaming === open.id ? (
            <input
              className="control swarm__rename"
              data-testid="swarm-rename"
              defaultValue={open.name}
              autoFocus
              onBlur={(event) => {
                void (async () => {
                  await bridge().invoke('swarm:rename', { id: open.id, name: event.target.value });
                  setRenaming('');
                  await openThread(open.id);
                  await refresh();
                })();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          ) : (
            <h1
              className="swarm__title swarm__title--editable"
              data-testid="swarm-title"
              onDoubleClick={() => {
                setRenaming(open.id);
              }}
              title="Double-click to rename"
            >
              {open.name}
            </h1>
          )}
          <p className="swarm__sub">
            {open === null
              ? 'A population argues it out, and you read what they arrived at.'
              : `${String(open.turns.length)} question${open.turns.length === 1 ? '' : 's'} put to this crowd`}
          </p>
        </header>

        <div className="swarm__body scroll">
          {open === null && (
            <div className="swarm__blank">
              <p>
                Describe an event, a proposal or a price change. A population is written for it,
                given the news, and left to influence each other — what comes back is where they
                ended up and why.
              </p>
            </div>
          )}

          {open?.turns.map((turn) => (
            <section key={turn.id} className="swarm-turn" data-testid="swarm-turn">
              <p className="swarm-turn__asked" data-testid="swarm-asked">
                {turn.asked}
              </p>

              {turn.result && (
                <>
                  <Split split={turn.result.final} />
                  <p className="swarm-turn__how" data-testid="swarm-how">
                    {turn.result.mode === 'everyone'
                      ? `All ${String(turn.result.population)} were asked directly.`
                      : `${String(turn.result.thinking)} thought it through; the other ${String(
                          turn.result.population - turn.result.thinking,
                        )} followed them through who listens to whom.`}{' '}
                    {turn.result.stopped === 'settled'
                      ? `Settled after ${String(turn.result.rounds.length)} rounds.`
                      : turn.result.stopped === 'cancelled'
                        ? 'Stopped early.'
                        : `Still moving after ${String(turn.result.rounds.length)} rounds.`}
                  </p>
                </>
              )}

              {turn.result?.graph && turn.result.graph.nodes.length > 0 && (
                <SwarmGraph
                  graph={turn.result.graph}
                  stances={turn.result.rounds[turn.result.rounds.length - 1]?.stances ?? []}
                  said={
                    new Map(
                      (turn.result.rounds[turn.result.rounds.length - 1]?.said ?? []).map((one) => [
                        one.name,
                        one.said,
                      ]),
                    )
                  }
                  live={false}
                />
              )}

              <div className="swarm-turn__answer">{turn.answer}</div>

              {turn.result && turn.result.rounds.length > 0 && (
                <details className="swarm-turn__rounds">
                  <summary>What they said</summary>
                  {turn.result.rounds.map((round) => (
                    <div key={round.round} className="round">
                      <p className="round__head">
                        Round {round.round}
                        <span className="round__split">
                          {round.distribution.for} for · {round.distribution.against} against
                        </span>
                      </p>
                      <ul className="round__voices">
                        {round.said.map((voice, index) => (
                          <Voice key={`${voice.name}-${String(index)}`} voice={voice} />
                        ))}
                      </ul>
                    </div>
                  ))}
                </details>
              )}
            </section>
          ))}

          {asking && (
            <section className="swarm-turn swarm-turn--live" data-testid="swarm-live">
              {live === null && graph === null ? (
                <p className="swarm-turn__how">Writing the population…</p>
              ) : (
                <>
                  <p className="swarm-turn__how">
                    {live === null
                      ? 'The crowd is assembled — they are starting to think'
                      : `Round ${String(live.round)} — the population is still moving`}
                  </p>

                  {/* The crowd itself, while it argues. A number at the end is
                      a poor account of a few hundred people changing their
                      minds; this is the same information as a thing to watch. */}
                  {graph !== null && (
                    <SwarmGraph
                      graph={graph}
                      stances={stances}
                      said={new Map((live?.said ?? []).map((one) => [one.name, one.said]))}
                      live
                    />
                  )}

                  {live !== null && (
                    <>
                      <Split split={live.distribution} />
                      <ul className="round__voices">
                        {live.said.slice(0, 6).map((voice, index) => (
                          <Voice key={`${voice.name}-${String(index)}`} voice={voice} />
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </section>
          )}

          <div ref={tail} />
        </div>

        {error !== null && (
          <p className="connections__error" data-testid="swarm-error">
            {error}
          </p>
        )}

        <div className="swarm__composer">
          <textarea
            className="home__input"
            data-testid="swarm-input"
            rows={2}
            value={question}
            placeholder={
              open === null
                ? 'What should the crowd react to?'
                : 'Ask the same crowd something else…'
            }
            onChange={(event) => {
              setQuestion(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void ask();
              }
            }}
          />

          <div className="swarm__controls">
            <label className="swarm__dial">
              People
              <input
                type="number"
                className="control"
                data-testid="swarm-population"
                min={2}
                max={50_000}
                step={50}
                value={population}
                onChange={(event) => {
                  setPopulation(Math.max(2, Number(event.target.value) || 300));
                }}
              />
            </label>
            <label className="swarm__dial">
              Rounds
              <input
                type="number"
                className="control"
                data-testid="swarm-rounds"
                min={1}
                max={20}
                value={maxRounds}
                onChange={(event) => {
                  setMaxRounds(Math.max(1, Number(event.target.value) || 4));
                }}
              />
            </label>
            <label className="swarm__dial" title="Below this, every agent is a real model call">
              Ask everyone up to
              <input
                type="number"
                className="control"
                data-testid="swarm-everyone"
                min={0}
                max={200}
                value={everyoneUpTo}
                onChange={(event) => {
                  setEveryoneUpTo(Math.max(0, Number(event.target.value) || 24));
                }}
              />
            </label>

            {choices.length > 0 && (
              <select
                className="chat__control"
                data-testid="swarm-model"
                aria-label="Model"
                value={modelKey === '' ? (choices[0]?.key ?? '') : modelKey}
                onChange={(event) => {
                  setModelKey(event.target.value);
                }}
              >
                {choices.map((choice) => (
                  <option key={choice.key} value={choice.key}>
                    {choice.connectionLabel} · {choice.model}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              className="button button--primary swarm__ask"
              data-testid="swarm-ask"
              disabled={asking || question.trim() === ''}
              onClick={() => void ask()}
            >
              {asking ? 'Running' : open === null ? 'Run the swarm' : 'Ask again'}
            </button>
          </div>

          <p className="swarm__cost">
            {population <= everyoneUpTo
              ? `${String(population)} agents, each asked directly — ${String(population * maxRounds)} model calls.`
              : `${String(population)} agents; about ${String(Math.min(24, Math.max(6, Math.round(Math.sqrt(population) * 1.4))) * maxRounds)} model calls, because most of them follow rather than think.`}
          </p>
        </div>
      </main>
    </div>
  );
}
