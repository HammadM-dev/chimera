import { grow, movement, propagate, seededRandom, wire } from './population.ts';
import type { Persona, Population, Stance, Tie } from './population.ts';

// A swarm: a population, an event dropped into it, and whatever they arrive at.
//
// The shape is MiroFish's, in five stages — build the world, populate it,
// simulate rounds, report, then let the user push on it. What is deliberately
// not MiroFish's is the claim about scale. Nobody runs a million agents through
// a language model; the arithmetic of that is a five-figure bill per question.
// So a run says which of two things it did, in the report, in the numbers, and
// in the trace:
//
//   `everyone`  — every agent is a real model call, every round. Honest, small,
//                 and expensive per head. Right for tens of agents.
//   `archetypes` — the archetypes think and the rest of the population follows
//                 them through the graph by arithmetic. Right for thousands,
//                 and the mode where a percentage is a model of a crowd rather
//                 than a count of one.
//
// The mode is chosen per run and the report never hides which was used. A
// prediction that will not say how it was produced is a prediction nobody
// should act on.

/**
 * Simultaneous model calls, unless the caller says otherwise.
 *
 * Six is comfortably under every consumer-tier rate limit seen so far and
 * still finishes a twenty-four persona round in four waves rather than
 * twenty-four.
 */
export const DEFAULT_CONCURRENCY = 6;

export type SwarmMode = 'everyone' | 'archetypes';

export interface SwarmSpec {
  /** What is being simulated: the event, question or proposal. */
  question: string;
  /** Anything the population should already know. Empty is fine. */
  background: string;
  /** How many agents in total. */
  population: number;
  /** How many rounds of influence at most. */
  maxRounds: number;
  /**
   * Above this population, follow rather than think.
   *
   * The one number that decides which mode a run uses, so the choice is a
   * setting rather than a hidden heuristic.
   */
  everyoneUpTo: number;
  /** Stop early once a round moves the population less than this. */
  settleAt: number;
}

export interface RoundReport {
  round: number;
  /** What each thinking agent said this round, for the transcript. */
  said: { name: string; position: number; said: string }[];
  /** How far the whole population moved. */
  movement: number;
  distribution: Distribution;
}

export interface Distribution {
  for: number;
  against: number;
  undecided: number;
  /** Mean position, weighted by influence — the loud count for more. */
  weighted: number;
}

export interface SwarmResult {
  mode: SwarmMode;
  population: number;
  thinking: number;
  rounds: RoundReport[];
  final: Distribution;
  stopped: 'settled' | 'rounds' | 'cancelled';
  personas: Persona[];
}

export interface SimulateDeps {
  /** Writes the cast. One model call. */
  buildPersonas: (input: {
    question: string;
    background: string;
    count: number;
  }) => Promise<Persona[]>;
  /**
   * Asks one agent where it stands, given what it has heard.
   *
   * Called once per thinking agent per round, and nowhere else — every other
   * agent is moved by arithmetic. This is the only thing in a swarm that costs
   * money, which is why the count of it is reported.
   */
  ask: (input: {
    persona: Persona;
    question: string;
    background: string;
    heard: { name: string; said: string }[];
    round: number;
  }) => Promise<{ position: number; confidence: number; said: string }>;
  cancellation?: { readonly cancelled: boolean };
  /** Told after every round, so a window can follow along. */
  onRound?: (report: RoundReport) => void;
  /** Seeds the deterministic jitter. The run id, so a run repeats exactly. */
  seed: string;
  /**
   * How many personas may be asked at once.
   *
   * They are independent within a round, so this is purely about what the
   * provider will tolerate rather than about correctness.
   */
  concurrency?: number;
}

/** How many archetypes to write for a population. Enough voices to disagree, few enough to afford. */
export function archetypeCountFor(population: number): number {
  if (population <= 12) return Math.max(2, population);
  return Math.min(24, Math.max(6, Math.round(Math.sqrt(population) * 1.4)));
}

export function distributionOf(
  people: readonly Persona[],
  stances: readonly Stance[],
): Distribution {
  const by = new Map(people.map((person) => [person.id, person]));
  let forCount = 0;
  let againstCount = 0;
  let undecided = 0;
  let weighted = 0;
  let weight = 0;

  for (const stance of stances) {
    if (stance.position > 0.2) forCount += 1;
    else if (stance.position < -0.2) againstCount += 1;
    else undecided += 1;

    // Weighted by influence: the loud count for more, which is the difference
    // between a swarm and a poll.
    const influence = by.get(stance.personaId)?.influence ?? 0.5;
    weighted += stance.position * influence;
    weight += influence;
  }

  return {
    for: forCount,
    against: againstCount,
    undecided,
    weighted: weight === 0 ? 0 : weighted / weight,
  };
}

/** Who this persona has heard from, loudest first, capped so a prompt stays a prompt. */
function heardBy(
  persona: Persona,
  ties: readonly Tie[],
  stances: readonly Stance[],
  people: readonly Persona[],
): { name: string; said: string }[] {
  const names = new Map(people.map((person) => [person.id, person.name]));
  const said = new Map(stances.map((stance) => [stance.personaId, stance.said]));

  return ties
    .filter((tie) => tie.to === persona.id)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
    .map((tie) => ({ name: names.get(tie.from) ?? tie.from, said: said.get(tie.from) ?? '' }))
    .filter((entry) => entry.said !== '');
}

/**
 * Runs `work` over every item, at most `limit` at a time.
 *
 * The round used to be a plain `Promise.all` over every thinking persona,
 * which for a population in archetypes mode is two dozen simultaneous requests
 * and in everyone mode as many as the headcount. Providers answer that with
 * HTTP 429, so the swarm reported "rate limit reached" on a workspace whose
 * models were demonstrably fine — one call from the providers panel worked,
 * because one call is not two dozen.
 *
 * Order is preserved: the caller matches answers back to personas by index.
 */
async function mapWithLimit<In, Out>(
  items: readonly In[],
  limit: number,
  work: (item: In) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  let next = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index] as In);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => runner()),
  );
  return results;
}

export async function simulate(spec: SwarmSpec, deps: SimulateDeps): Promise<SwarmResult> {
  const random = seededRandom(deps.seed);

  // ---- stages one and two: the world, and the people in it -----------------
  const mode: SwarmMode = spec.population <= spec.everyoneUpTo ? 'everyone' : 'archetypes';
  const wanted = mode === 'everyone' ? spec.population : archetypeCountFor(spec.population);

  const archetypes = await deps.buildPersonas({
    question: spec.question,
    background: spec.background,
    count: wanted,
  });
  if (archetypes.length === 0) {
    return {
      mode,
      population: 0,
      thinking: 0,
      rounds: [],
      final: { for: 0, against: 0, undecided: 0, weighted: 0 },
      stopped: 'rounds',
      personas: [],
    };
  }

  const people = grow(archetypes, spec.population, random);
  const ties = wire(people, random);
  const thinkers = people.filter((person) => person.kind === 'archetype');

  // ---- stage three: rounds -------------------------------------------------
  let stances: Stance[] = people.map((person) => ({
    personaId: person.id,
    position: 0,
    confidence: 0.3,
    said: '',
  }));

  const rounds: RoundReport[] = [];
  let stopped: SwarmResult['stopped'] = 'rounds';

  for (let round = 1; round <= spec.maxRounds; round += 1) {
    if (deps.cancellation?.cancelled === true) {
      stopped = 'cancelled';
      break;
    }

    // The thinking agents, all at once. They are independent within a round —
    // each reacts to what it heard *last* round, which is what makes a round a
    // round rather than a queue.
    const thought = await mapWithLimit(
      thinkers,
      deps.concurrency ?? DEFAULT_CONCURRENCY,
      async (persona) => {
        const answer = await deps.ask({
          persona,
          question: spec.question,
          background: spec.background,
          heard: heardBy(persona, ties, stances, people),
          round,
        });
        return {
          personaId: persona.id,
          position: Math.max(-1, Math.min(1, answer.position)),
          confidence: Math.max(0, Math.min(1, answer.confidence)),
          said: answer.said,
        };
      },
    );

    const merged = stances.map(
      (stance) => thought.find((one) => one.personaId === stance.personaId) ?? stance,
    );
    // And then everyone else moves, by arithmetic.
    const next = propagate(people, ties, merged);

    const report: RoundReport = {
      round,
      said: thought.map((one) => ({
        name: people.find((person) => person.id === one.personaId)?.name ?? one.personaId,
        position: one.position,
        said: one.said,
      })),
      movement: movement(stances, next),
      distribution: distributionOf(people, next),
    };

    rounds.push(report);
    deps.onRound?.(report);
    stances = next;

    // Settled: another round would cost money and move nothing.
    if (round > 1 && report.movement < spec.settleAt) {
      stopped = 'settled';
      break;
    }
  }

  return {
    mode,
    population: people.length,
    thinking: thinkers.length,
    rounds,
    final: distributionOf(people, stances),
    stopped,
    personas: people,
  };
}

/** The population, for a caller that wants to show the graph. */
export function populationOf(result: SwarmResult): Population {
  return { personas: result.personas, ties: [] };
}
