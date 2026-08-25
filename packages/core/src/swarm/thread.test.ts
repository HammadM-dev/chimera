import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, type SwarmSpec } from './simulate.ts';
import type { Persona } from './population.ts';

// What makes a thread a thread.
//
// A follow-up has to reach the same crowd. This is easy to get wrong in a way
// that looks right: the answers stay plausible, the numbers stay in range, and
// nothing in the output says the second question went to different people. It
// went wrong here exactly once — a per-turn seed, added on the belief that it
// varied the starting stances, when starting stances are fixed and all it
// varied was the population.

const CAST: Persona[] = [
  {
    id: 'a0',
    name: 'careful accountant',
    description: 'Watches the margin.',
    traits: ['cautious'],
    susceptibility: 0.3,
    influence: 0.8,
    kind: 'archetype',
    follows: '',
  },
  {
    id: 'a1',
    name: 'loyal regular',
    description: 'Has been coming for years.',
    traits: ['attached'],
    susceptibility: 0.7,
    influence: 0.4,
    kind: 'archetype',
    follows: '',
  },
];

function spec(question: string): SwarmSpec {
  return {
    question,
    background: '',
    population: 200,
    maxRounds: 1,
    everyoneUpTo: 50,
    settleAt: 0.03,
  };
}

/** Runs a simulation over a fixed cast, so only the seed varies. */
async function run(seed: string, question: string) {
  return simulate(spec(question), {
    seed,
    buildPersonas: ({ count }) => Promise.resolve(CAST.slice(0, count)),
    ask: ({ persona }) =>
      Promise.resolve({
        position: persona.name === 'careful accountant' ? -0.6 : 0.5,
        confidence: 0.7,
        said: 'As you would expect.',
      }),
  });
}

test('the same seed and the same cast rebuild the same crowd', async () => {
  const first = await run('thread-7', 'Should we raise prices?');
  const second = await run('thread-7', 'And if we doubled them?');

  // Same people, down to how suggestible each one is. Who follows whom is
  // deterministic from the cast alone, so it is the jittered traits that
  // actually test the seed here.
  assert.deepEqual(fingerprint(first.personas), fingerprint(second.personas));
  assert.equal(first.population, second.population);
});

test('a different seed is a different crowd, which is why threads hold theirs', async () => {
  const first = await run('thread-7', 'Should we raise prices?');
  const other = await run('thread-8', 'Should we raise prices?');

  // Same archetypes — those are the cast, and they are given — but the crowd
  // grown around them differs in how far each follower drifts from the person
  // they came from. Identical here would mean the seed does nothing, and the
  // test above would prove nothing.
  assert.notDeepEqual(fingerprint(first.personas), fingerprint(other.personas));
});

/**
 * Enough of a population to tell two of them apart.
 *
 * Ids and `follows` are derived from the cast and the headcount, so they match
 * across any two runs of the same size — fingerprinting on those would make the
 * sameness test pass for a reason that has nothing to do with the seed.
 */
function fingerprint(people: Persona[]): string[] {
  return people.map(
    (person) =>
      `${person.id}:${person.follows}:${person.susceptibility.toFixed(4)}:${person.influence.toFixed(4)}`,
  );
}
