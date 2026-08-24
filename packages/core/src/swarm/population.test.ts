import test from 'node:test';
import assert from 'node:assert/strict';
import { grow, movement, propagate, seededRandom, wire } from './population.ts';
import type { Persona, Stance } from './population.ts';

// The arithmetic half of the swarm, which is the half that decides whether a
// simulation means anything.
//
// A population that always converges tells you nothing — every question gets
// "they agreed". One that never converges tells you nothing either. What has to
// be true is that the outcome depends on the *argument*: who is loud, who is
// stubborn, and who listens to whom. These tests are about that, not about the
// code running.

function archetype(id: string, over: Partial<Persona> = {}): Persona {
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

function stance(personaId: string, position: number, confidence = 0.5): Stance {
  return { personaId, position, confidence, said: '' };
}

test('a population of a thousand is a thousand different people', () => {
  const random = seededRandom('run-1');
  const people = grow([archetype('a'), archetype('b')], 1_000, random);

  assert.equal(people.length, 1_000);
  assert.equal(people.filter((person) => person.kind === 'archetype').length, 2);

  // Jittered, not copied. A thousand identical followers would move as one
  // person and the distribution would be two spikes.
  const susceptibilities = new Set(people.map((person) => person.susceptibility.toFixed(3)));
  assert.ok(susceptibilities.size > 50, `only ${String(susceptibilities.size)} distinct dials`);

  // And a follower carries less weight than the archetype it came from.
  const source = people.find((person) => person.id === 'a');
  const follower = people.find((person) => person.follows === 'a');
  assert.ok(follower && source && follower.influence < source.influence);
});

test('the same seed gives the same population, twice', () => {
  // A prediction whose numbers change when you look again is one nobody can
  // check, and "run it twice" is the first thing anybody does.
  const first = grow([archetype('a'), archetype('b')], 200, seededRandom('run-7'));
  const second = grow([archetype('a'), archetype('b')], 200, seededRandom('run-7'));

  assert.deepEqual(first, second);
});

test('a small population is just the archetypes, all thinking for themselves', () => {
  const people = grow([archetype('a'), archetype('b'), archetype('c')], 3, seededRandom('s'));

  assert.equal(people.length, 3);
  assert.equal(
    people.every((person) => person.kind === 'archetype'),
    true,
  );
});

test('nobody lives in a bubble of one voice', () => {
  const random = seededRandom('run-2');
  const people = grow([archetype('a'), archetype('b'), archetype('c')], 60, random);
  const ties = wire(people, random);

  for (const follower of people.filter((person) => person.kind === 'follower')) {
    const heard = ties.filter((tie) => tie.to === follower.id).map((tie) => tie.from);
    // Their own archetype, and at least one other. A follower who hears only
    // one view is not being persuaded, they are being told.
    assert.ok(heard.includes(follower.follows), `${follower.id} cannot hear its own archetype`);
    assert.ok(heard.length >= 2, `${follower.id} hears only ${String(heard.length)} voice`);
  }
});

test('a crowd moves the people who are unsure, and not the people who are certain', () => {
  const people = [
    archetype('loud', { influence: 1 }),
    { ...archetype('open'), kind: 'follower' as const, follows: 'loud', susceptibility: 0.9 },
    { ...archetype('stubborn'), kind: 'follower' as const, follows: 'loud', susceptibility: 0.05 },
  ];
  const ties = [
    { from: 'loud', to: 'open', weight: 0.8 },
    { from: 'loud', to: 'stubborn', weight: 0.8 },
  ];

  const before = [stance('loud', 1, 0.9), stance('open', -1, 0.1), stance('stubborn', -1, 0.1)];
  const after = propagate(people, ties, before);

  const open = after.find((s) => s.personaId === 'open');
  const stubborn = after.find((s) => s.personaId === 'stubborn');

  // Both were dragged toward the loud voice; the open one much further.
  assert.ok((open?.position ?? -1) > -1);
  assert.ok((stubborn?.position ?? -1) > -1);
  assert.ok(
    (open?.position ?? 0) > (stubborn?.position ?? 0) + 0.4,
    `open moved to ${String(open?.position)}, stubborn to ${String(stubborn?.position)}`,
  );
});

test('an archetype is never moved by propagation — it thought for itself', () => {
  const people = [archetype('a'), archetype('b')];
  const ties = [{ from: 'b', to: 'a', weight: 1 }];
  const before = [stance('a', 1, 0.9), stance('b', -1, 0.9)];

  const after = propagate(people, ties, before);
  assert.equal(after.find((s) => s.personaId === 'a')?.position, 1);
});

test('a louder voice moves the population further than a quiet one', () => {
  // The reason a swarm is not an average. If influence did not matter, the
  // whole social graph would be decoration.
  const build = (weight: number): number => {
    const people = [
      archetype('speaker'),
      { ...archetype('listener'), kind: 'follower' as const, follows: 'speaker' },
    ];
    const ties = [{ from: 'speaker', to: 'listener', weight }];
    const after = propagate(people, ties, [stance('speaker', 1, 1), stance('listener', -1, 0.2)]);
    return after.find((s) => s.personaId === 'listener')?.position ?? -1;
  };

  assert.ok(build(0.9) > build(0.2), 'a stronger tie should move a listener further');
});

test('agreement makes people surer, disagreement does not', () => {
  const people = [
    archetype('a'),
    { ...archetype('agrees'), kind: 'follower' as const, follows: 'a' },
    { ...archetype('differs'), kind: 'follower' as const, follows: 'a' },
  ];
  const ties = [
    { from: 'a', to: 'agrees', weight: 0.8 },
    { from: 'a', to: 'differs', weight: 0.8 },
  ];
  const before = [stance('a', 1, 0.9), stance('agrees', 0.95, 0.5), stance('differs', -1, 0.5)];
  const after = propagate(people, ties, before);

  assert.ok((after.find((s) => s.personaId === 'agrees')?.confidence ?? 0) > 0.5);
  assert.equal(after.find((s) => s.personaId === 'differs')?.confidence, 0.5);
});

test('movement reports how far the population travelled', () => {
  const before = [stance('a', 0, 0.5), stance('b', 0, 0.5)];
  assert.equal(movement(before, before), 0);
  assert.equal(movement(before, [stance('a', 1, 0.5), stance('b', -1, 0.5)]), 1);
  // An empty population has not moved, rather than dividing by zero.
  assert.equal(movement([], []), 0);
});

test('a population reaches a settled state rather than oscillating', () => {
  // Run it out and check it stops moving. A simulation that never settles has
  // no answer to report, and one that settles instantly never simulated
  // anything.
  const random = seededRandom('run-3');
  const people = grow(
    [archetype('for', { influence: 0.9 }), archetype('against', { influence: 0.6 })],
    300,
    random,
  );
  const ties = wire(people, random);

  let stances: Stance[] = people.map((person) =>
    stance(person.id, person.follows === 'against' || person.id === 'against' ? -0.8 : 0.8, 0.4),
  );

  const travelled: number[] = [];
  for (let round = 0; round < 8; round += 1) {
    const next = propagate(people, ties, stances);
    travelled.push(movement(stances, next));
    stances = next;
  }

  const first = travelled[0] ?? 0;
  const last = travelled.at(-1) ?? 0;
  assert.ok(first > 0.01, 'the first round should move the population');
  assert.ok(last < first / 2, `it did not settle: ${first.toFixed(3)} then ${last.toFixed(3)}`);
});
