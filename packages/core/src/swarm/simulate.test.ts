import test from 'node:test';
import assert from 'node:assert/strict';
import { archetypeCountFor, distributionOf, simulate } from './simulate.ts';
import type { SimulateDeps, SwarmSpec } from './simulate.ts';
import type { Persona } from './population.ts';

// The simulation, with the model stubbed out.
//
// What is worth asserting is not that it runs — it is what it *costs* and what
// it *claims*. A swarm that quietly makes ten thousand model calls, or that
// reports a percentage without saying whether the people behind it thought or
// followed, is the failure mode. Both are checked here by counting.

function persona(id: string, over: Partial<Persona> = {}): Persona {
  return {
    id,
    name: id,
    description: `a ${id}`,
    traits: [],
    susceptibility: 0.5,
    influence: 0.5,
    kind: 'archetype',
    follows: '',
    ...over,
  };
}

function spec(over: Partial<SwarmSpec> = {}): SwarmSpec {
  return {
    question: 'Should the price go up?',
    background: '',
    population: 8,
    maxRounds: 3,
    everyoneUpTo: 40,
    settleAt: 0.01,
    ...over,
  };
}

/** Counts every model call, which is the only thing a swarm spends money on. */
function stubbed(
  answer: (
    persona: Persona,
    round: number,
  ) => { position: number; confidence: number; said: string },
): SimulateDeps & { calls: () => number; built: () => number } {
  let asks = 0;
  let builds = 0;
  return {
    seed: 'run-1',
    buildPersonas: ({ count }) => {
      builds += 1;
      return Promise.resolve(
        Array.from({ length: count }, (_, index) => persona(`p${String(index)}`)),
      );
    },
    ask: ({ persona: who, round }) => {
      asks += 1;
      return Promise.resolve(answer(who, round));
    },
    calls: () => asks,
    built: () => builds,
  };
}

test('a small population is simulated in full, and says so', async () => {
  const deps = stubbed(() => ({ position: 0.6, confidence: 0.7, said: 'yes' }));
  const result = await simulate(spec({ population: 8, maxRounds: 2 }), deps);

  assert.equal(result.mode, 'everyone');
  assert.equal(result.population, 8);
  // Everybody thought, so everybody cost a call.
  assert.equal(result.thinking, 8);
  assert.equal(deps.calls(), 16);
});

test('a large population thinks with a few and follows with the rest', async () => {
  const deps = stubbed(() => ({ position: 0.6, confidence: 0.7, said: 'yes' }));
  const result = await simulate(spec({ population: 2_000, maxRounds: 3 }), deps);

  assert.equal(result.mode, 'archetypes');
  assert.equal(result.population, 2_000);
  // The whole point: two thousand agents, two dozen model calls a round. A
  // swarm that called a model per agent would be a five-figure question.
  assert.ok(result.thinking <= 24, `${String(result.thinking)} thinkers is too many`);
  assert.ok(deps.calls() <= 24 * 3, `${String(deps.calls())} calls for 2,000 agents`);
});

test('the threshold is a setting, not a hidden rule', async () => {
  const under = await simulate(
    spec({ population: 40, everyoneUpTo: 40 }),
    stubbed(() => ({ position: 0, confidence: 0.5, said: '' })),
  );
  const over = await simulate(
    spec({ population: 41, everyoneUpTo: 40 }),
    stubbed(() => ({ position: 0, confidence: 0.5, said: '' })),
  );

  assert.equal(under.mode, 'everyone');
  assert.equal(over.mode, 'archetypes');
});

test('a settled population stops early instead of paying for rounds that move nothing', async () => {
  // Everybody says the same thing every round, so after the first there is
  // nothing left to happen.
  const deps = stubbed(() => ({ position: 0.8, confidence: 0.9, said: 'yes' }));
  const result = await simulate(spec({ population: 6, maxRounds: 10, settleAt: 0.05 }), deps);

  assert.equal(result.stopped, 'settled');
  assert.ok(result.rounds.length < 10, `ran all ${String(result.rounds.length)} rounds`);
});

test('a population that keeps arguing runs its rounds and says it ran out', async () => {
  // Alternating every round: never settles.
  const deps = stubbed((_who, round) => ({
    position: round % 2 === 0 ? 1 : -1,
    confidence: 0.2,
    said: 'it depends',
  }));
  const result = await simulate(spec({ population: 6, maxRounds: 4, settleAt: 0.01 }), deps);

  assert.equal(result.stopped, 'rounds');
  assert.equal(result.rounds.length, 4);
});

test('a round reports what was said, not only a number', async () => {
  const deps = stubbed((who) => ({
    position: 0.5,
    confidence: 0.6,
    said: `${who.name} thinks so`,
  }));
  const result = await simulate(spec({ population: 4, maxRounds: 1 }), deps);

  const first = result.rounds[0];
  assert.equal(first?.said.length, 4);
  assert.match(first?.said[0]?.said ?? '', /thinks so/);
  // A swarm whose transcript is missing is a swarm nobody can argue with.
});

test('the loud count for more than the quiet', async () => {
  const people = [persona('loud', { influence: 1 }), persona('quiet', { influence: 0.1 })];
  const split = distributionOf(people, [
    { personaId: 'loud', position: 1, confidence: 1, said: '' },
    { personaId: 'quiet', position: -1, confidence: 1, said: '' },
  ]);

  // One each way, so a headcount is a tie — and the weighted reading is not,
  // which is the difference between a swarm and a poll.
  assert.equal(split.for, 1);
  assert.equal(split.against, 1);
  assert.ok(split.weighted > 0.5, `weighted came out ${split.weighted.toFixed(2)}`);
});

test('cancelling stops it between rounds', async () => {
  let cancelled = false;
  const deps = {
    ...stubbed(() => ({ position: 0.1, confidence: 0.3, said: 'x' })),
    cancellation: {
      get cancelled() {
        return cancelled;
      },
    },
  };

  const result = await simulate(
    { ...spec({ population: 4, maxRounds: 5 }), settleAt: 0 },
    {
      ...deps,
      onRound: () => {
        cancelled = true;
      },
    },
  );

  assert.equal(result.stopped, 'cancelled');
  assert.equal(result.rounds.length, 1);
});

test('a model that writes no personas does not produce a confident answer', async () => {
  const deps = {
    ...stubbed(() => ({ position: 1, confidence: 1, said: 'yes' })),
    buildPersonas: () => Promise.resolve([]),
  };
  const result = await simulate(spec(), deps);

  assert.equal(result.population, 0);
  assert.equal(result.rounds.length, 0);
  assert.equal(result.final.weighted, 0);
});

test('the archetype count grows slowly, so a bigger question is not a bigger bill', () => {
  assert.equal(archetypeCountFor(6), 6);
  assert.ok(archetypeCountFor(100) < 20);
  assert.ok(archetypeCountFor(10_000) <= 24);
  // Ten thousand agents must not cost ten times what a thousand does.
  assert.equal(archetypeCountFor(10_000), archetypeCountFor(100_000));
});

test('a round asks a few at a time, not the whole population at once', async () => {
  // The bug this covers reported itself as "rate limit reached" on a workspace
  // whose models worked perfectly well from the providers panel. One call is
  // not two dozen: a round was a plain `Promise.all` over every thinking
  // persona, so a population in archetypes mode opened twenty-odd simultaneous
  // connections and the provider answered the way providers answer that.
  let inFlight = 0;
  let peak = 0;

  await simulate(
    {
      question: 'Should we raise prices?',
      background: '',
      population: 400,
      maxRounds: 1,
      everyoneUpTo: 50,
      settleAt: 0.03,
    },
    {
      seed: 'concurrency',
      concurrency: 4,
      buildPersonas: ({ count }) =>
        Promise.resolve(
          Array.from({ length: count }, (_, index) => ({
            id: `a${String(index)}`,
            name: `person ${String(index)}`,
            description: '',
            traits: [],
            susceptibility: 0.5,
            influence: 0.5,
            kind: 'archetype' as const,
            follows: '',
          })),
        ),
      ask: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return { position: 0.2, confidence: 0.6, said: 'fine' };
      },
    },
  );

  assert.ok(peak > 1, `expected some parallelism, saw ${String(peak)}`);
  assert.ok(peak <= 4, `expected at most 4 at once, saw ${String(peak)}`);
});

test('every persona is still asked, and answers land on the right one', async () => {
  // A worker pool that loses or misorders results would be a much quieter bug
  // than the one it replaced: the numbers would still look plausible.
  const asked: string[] = [];

  const result = await simulate(
    {
      question: 'Should we raise prices?',
      background: '',
      population: 12,
      maxRounds: 1,
      everyoneUpTo: 50,
      settleAt: 0.03,
    },
    {
      seed: 'pool-order',
      concurrency: 3,
      buildPersonas: ({ count }) =>
        Promise.resolve(
          Array.from({ length: count }, (_, index) => ({
            id: `a${String(index)}`,
            name: `person ${String(index)}`,
            description: '',
            traits: [],
            susceptibility: 0.5,
            influence: 0.5,
            kind: 'archetype' as const,
            follows: '',
          })),
        ),
      // Each persona says its own name back, and staggered so a pool that
      // matched by completion order rather than by index would scramble them.
      ask: async ({ persona }) => {
        asked.push(persona.id);
        await new Promise((resolve) => setTimeout(resolve, persona.id === 'a0' ? 8 : 1));
        return { position: 0.3, confidence: 0.6, said: persona.name };
      },
    },
  );

  assert.equal(asked.length, 12);
  assert.equal(new Set(asked).size, 12);

  for (const spoke of result.rounds[0]?.said ?? []) {
    assert.equal(spoke.said, spoke.name, 'an answer landed on the wrong persona');
  }
});

test('one persona failing does not throw away the whole round', async () => {
  // On a rate-limited free model this was the common case rather than the
  // rare one: a single refused call ended the simulation and discarded every
  // answer already gathered, so the user saw an error instead of a result the
  // run had very nearly finished producing.
  let asked = 0;

  const result = await simulate(
    {
      question: 'Should we raise prices?',
      background: '',
      population: 12,
      maxRounds: 1,
      everyoneUpTo: 50,
      settleAt: 0.03,
    },
    {
      seed: 'one-bad-apple',
      concurrency: 2,
      buildPersonas: ({ count }) =>
        Promise.resolve(
          Array.from({ length: count }, (_, index) => ({
            id: `a${String(index)}`,
            name: `person ${String(index)}`,
            description: '',
            traits: [],
            susceptibility: 0.5,
            influence: 0.5,
            kind: 'archetype' as const,
            follows: '',
          })),
        ),
      ask: ({ persona }) => {
        asked += 1;
        if (persona.id === 'a3') return Promise.reject(new Error('rate limited'));
        return Promise.resolve({ position: 0.6, confidence: 0.7, said: 'in favour' });
      },
    },
  );

  assert.equal(asked, 12, 'every persona should still have been asked');
  assert.equal(result.rounds.length, 1);
  // Eleven spoke; the twelfth held its position and said nothing.
  assert.equal(result.rounds[0]?.said.filter((one) => one.said !== '').length, 11);
  assert.ok(result.final.for > 0, 'the round still produced a distribution');
});
