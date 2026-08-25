import { swarmsRepository } from '@chimera/store';
import { DEFAULT_CONCURRENCY } from '@chimera/core';
import type { Persona, RoundReport, SwarmGraph, SwarmResult } from '@chimera/core';
import { getStore } from '../store/lifecycle.ts';
import { report, runSwarm } from './service.ts';
import { SwarmThrottle } from './throttle.ts';

// A swarm thread: the population, and everything that has been asked of it.
//
// One question is one turn. The population is rebuilt from the thread's seed
// every time, so the same people answer the follow-up — which is the whole
// point of a thread rather than a series of runs. Asking "and if the price were
// double?" of a *different* crowd would answer a different question.

export interface SwarmSettings {
  connectionId: string;
  model: string;
  population: number;
  maxRounds: number;
  /** Above this, archetypes think and the rest follow. */
  everyoneUpTo: number;
}

export interface SwarmTurnView {
  id: string;
  seq: number;
  asked: string;
  answer: string;
  /** The whole simulation, for the panel that shows rounds and voices. */
  result: SwarmResult | null;
  createdAt: string;
}

export interface SwarmThreadView {
  id: string;
  name: string;
  question: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  turns: SwarmTurnView[];
}

/** A name to show before the model has written a better one. */
function provisionalName(question: string): string {
  const words = question.trim().split(/\s+/).slice(0, 6).join(' ');
  return words === '' ? 'New swarm' : words.length > 48 ? `${words.slice(0, 45)}…` : words;
}

export function listThreads(): {
  threads: { id: string; name: string; updatedAt: string; source: string }[];
} {
  return {
    threads: swarmsRepository.list(getStore()).map((row) => ({
      id: row.id,
      name: row.name,
      updatedAt: row.updatedAt,
      source: row.source,
    })),
  };
}

export function getThread(id: string): { thread: SwarmThreadView | null } {
  const db = getStore();
  const row = swarmsRepository.get(db, id);
  if (!row) return { thread: null };

  return {
    thread: {
      id: row.id,
      name: row.name,
      question: row.question,
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      turns: swarmsRepository.turnsOf(db, id).map((turn) => ({
        id: turn.id,
        seq: turn.seq,
        asked: turn.asked,
        answer: turn.answer,
        result: parseResult(turn.resultJson),
        createdAt: turn.createdAt,
      })),
    },
  };
}

function parseResult(json: string): SwarmResult | null {
  try {
    return JSON.parse(json) as SwarmResult;
  } catch {
    // A turn whose simulation will not read back still has its answer, which is
    // the part somebody came to read.
    return null;
  }
}

export function renameThread(input: { id: string; name: string }): { renamed: boolean } {
  swarmsRepository.rename(getStore(), input.id, input.name.trim() || 'Untitled swarm');
  return { renamed: true };
}

export function archiveThread(input: { id: string }): { archived: boolean } {
  swarmsRepository.archive(getStore(), input.id);
  return { archived: true };
}

/**
 * One thing happening inside a running swarm, small enough to send often.
 *
 * Flat and fully populated rather than a union with optional halves. The IPC
 * boundary validates with `z.object`, which drops any key its schema does not
 * name — silently, with no error at either end — and that has already cost
 * this section a whole feature once. A shape with no optional fields cannot
 * lose one.
 */
export interface SwarmActivity {
  swarmId: string;
  /** Which part of the run this is: writing the cast, thinking, writing up. */
  stage: 'casting' | 'thinking' | 'writing' | 'done';
  /** The agent this concerns. Empty when the event is only about the stage. */
  personaId: string;
  round: number;
  state: 'asking' | 'answered' | 'failed' | 'none';
  position: number;
  confidence: number;
  said: string;
}

export interface AskDeps {
  onPopulation?: (graph: SwarmGraph & { swarmId: string }) => void;
  onRound?: (report: RoundReport & { swarmId: string }) => void;
  /** Per-agent and per-stage progress, as it happens. */
  onActivity?: (activity: SwarmActivity) => void;
  cancellation?: { readonly cancelled: boolean };
}

/**
 * Asks a population something, in a thread.
 *
 * With no `threadId` this starts one; with one, the same population answers
 * again. Either way the answer, the whole simulation and what it cost are
 * stored before this returns — a swarm that ran and was not written down is a
 * swarm somebody paid for twice.
 */
export async function askSwarm(
  input: { threadId?: string; question: string; settings: SwarmSettings; source?: string },
  deps: AskDeps = {},
): Promise<{ threadId: string; turn: SwarmTurnView; name: string }> {
  const db = getStore();

  const thread =
    input.threadId === undefined || input.threadId === ''
      ? swarmsRepository.create(db, {
          name: provisionalName(input.question),
          question: input.question,
          ...(input.source === undefined ? {} : { source: input.source }),
        })
      : swarmsRepository.get(db, input.threadId);

  if (!thread) throw new Error('That swarm is not in this workspace.');

  // Everything asked so far, so a follow-up is a follow-up. The population is
  // the same — same seed — and it remembers the conversation, not just the
  // question in front of it.
  const before = swarmsRepository.turnsOf(db, thread.id);
  const background =
    before.length === 0
      ? ''
      : before
          .map((turn) => `Earlier they were asked: ${turn.asked}\nWhat happened: ${turn.answer}`)
          .join('\n\n');

  // The cast the first turn produced, if there was one.
  //
  // This is what actually makes a follow-up a follow-up. `buildPersonas` is a
  // model call, so without a stored cast every turn hired new people: the
  // second question went to a crowd the first one had never met, and nothing in
  // the output said so — the answers stayed plausible, which is what made it
  // hard to see.
  //
  // The seed is the thread's, unchanged, for the same reason. It was the
  // thread's seed plus the turn number, on the belief that reusing it exactly
  // would give the follow-up the same starting positions; it would not, since
  // every stance starts at position 0 and confidence 0.3 either way. All the
  // changing seed varied was how far each follower drifts from the archetype it
  // came from, and how strongly the ties between them carry — which is to say,
  // it made the crowd subtly different people for no benefit.
  const cast = castOf(before);

  const spec = {
    connectionId: input.settings.connectionId,
    model: input.settings.model,
    question: input.question,
    background,
    population: input.settings.population,
    maxRounds: input.settings.maxRounds,
    everyoneUpTo: input.settings.everyoneUpTo,
    seed: thread.seed,
    ...(cast.length === 0 ? {} : { cast }),
  };

  // One throttle for the whole ask. The write-up is the fiftieth request in a
  // minute, not the first, and treating it as a fresh start is how a swarm
  // came to do all its thinking successfully and then fail writing it up.
  const throttle = new SwarmThrottle({ permits: DEFAULT_CONCURRENCY });

  const say = (activity: Omit<SwarmActivity, 'swarmId'>): void => {
    deps.onActivity?.({ ...activity, swarmId: thread.id });
  };
  const quiet = { personaId: '', round: 0, state: 'none' as const, position: 0, confidence: 0, said: '' };

  say({ stage: 'casting', ...quiet });

  const result = await runSwarm(spec, {
    throttle,
    ...(deps.cancellation ? { cancellation: deps.cancellation } : {}),
    ...(deps.onPopulation
      ? {
          onPopulation: (graph: SwarmGraph) =>
            deps.onPopulation?.({ ...graph, swarmId: thread.id }),
        }
      : {}),
    ...(deps.onRound
      ? { onRound: (round: RoundReport) => deps.onRound?.({ ...round, swarmId: thread.id }) }
      : {}),
    ...(deps.onActivity
      ? {
          onThinking: (event) => {
            say({
              stage: 'thinking',
              personaId: event.personaId,
              round: event.round,
              state: event.state,
              position: event.position ?? 0,
              confidence: event.confidence ?? 0,
              said: event.said ?? '',
            });
          },
        }
      : {}),
  });

  // The write-up is one model call over the whole transcript, and on a
  // rate-limited provider it is minutes on its own. Without this the window
  // went silent right after the last round — the point at which a person who
  // had been watching the crowd move would reasonably conclude it had hung.
  say({ stage: 'writing', ...quiet });

  const written = await report(spec, result, throttle);

  say({ stage: 'done', ...quiet });

  const turn = swarmsRepository.addTurn(db, {
    swarmId: thread.id,
    asked: input.question,
    answer: written.answer,
    resultJson: JSON.stringify(result),
  });

  // The model's title beats the first six words of the question, and only on
  // the first turn — renaming a thread under somebody mid-conversation is
  // worse than a plain name.
  let name = thread.name;
  if (before.length === 0 && written.title !== '') {
    name = written.title;
    swarmsRepository.rename(db, thread.id, name);
  }

  return {
    threadId: thread.id,
    name,
    turn: {
      id: turn.id,
      seq: turn.seq,
      asked: turn.asked,
      answer: turn.answer,
      result,
      createdAt: turn.createdAt,
    },
  };
}

/** The thread an automation run created, for the button on a swarm node. */
export function threadForRun(input: { runId: string }): { threadId: string } {
  return { threadId: swarmsRepository.bySource(getStore(), input.runId)?.id ?? '' };
}

/**
 * The archetypes an earlier turn wrote, newest first.
 *
 * Read from the stored result rather than kept in a column of its own: the
 * whole simulation is already persisted for the panel that draws rounds and
 * voices, and a second copy of the cast is a second thing that can disagree
 * with the first.
 */
function castOf(turns: { resultJson: string }[]): Persona[] {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const stored = turns[index]?.resultJson;
    const personas = stored === undefined ? [] : (parseResult(stored)?.personas ?? []);
    const archetypes = personas.filter((persona) => persona.kind === 'archetype');
    if (archetypes.length > 0) return archetypes;
  }
  return [];
}
