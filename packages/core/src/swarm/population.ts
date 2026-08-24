// The population a swarm simulates, and the social graph it lives in.
//
// MiroFish's shape, and the part that makes a swarm a swarm rather than a
// committee: agents are not specialists assigned a subtask, they are *people* —
// a persona, a memory of what they have seen, and a position among others whose
// views reach them. Nobody is told what to conclude. The answer is whatever the
// population arrives at once the event has propagated.
//
// Two things here are deliberately not model calls. Building the graph is
// arithmetic, and so is propagation; only *thinking* costs money. That
// separation is what lets a run choose between a small population where every
// agent is a real model call and a large one where a few archetypes think and
// the rest follow — see `modes.ts` for why both exist.

export interface Persona {
  id: string;
  /** A name a person reading the report can hold onto. */
  name: string;
  /** One line: who this is. Written by the model during setup. */
  description: string;
  /** The traits that decide how they react. Free text, from the model. */
  traits: string[];
  /**
   * How much this persona moves when the people they listen to move.
   *
   * 0 is immovable, 1 is a weathervane. Drawn from the persona's own
   * description rather than assigned at random, so a "sceptical retired
   * engineer" is stubborn because of who they are.
   */
  susceptibility: number;
  /**
   * How much weight this persona carries with the people who listen to them.
   *
   * The reason a swarm is not an average: a loud, well-connected persona moves
   * the population further than a quiet one, which is how real opinion works
   * and why the median is the wrong summary.
   */
  influence: number;
  /** Whether this persona thinks for itself, or follows those it listens to. */
  kind: 'archetype' | 'follower';
  /** Which archetype a follower is drawn from. Empty for an archetype. */
  follows: string;
}

/** Who hears whom. Directed: `to` listens to `from`. */
export interface Tie {
  from: string;
  to: string;
  /** How much of `from`'s position reaches `to` each round. */
  weight: number;
}

export interface Population {
  personas: Persona[];
  ties: Tie[];
}

/** Where one persona stands, this round. */
export interface Stance {
  personaId: string;
  /** -1 strongly against, 0 undecided, +1 strongly for. */
  position: number;
  /** How sure they are. Low confidence moves further when pushed. */
  confidence: number;
  /** What they would say, in their own words. Empty for a follower. */
  said: string;
}

/**
 * A deterministic pseudo-random source.
 *
 * Seeded from the run id so a simulation can be repeated exactly. A swarm whose
 * numbers change when you look again is one nobody can check, and "run it
 * twice and see" is the first thing anybody does with a prediction.
 */
export function seededRandom(seed: string): () => number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return () => {
    hash += 0x6d2b79f5;
    let value = Math.imul(hash ^ (hash >>> 15), 1 | hash);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Grows a population of `size` from the archetypes the model wrote.
 *
 * Each follower is a copy of an archetype with its dials jittered, so a
 * population of a thousand is a thousand *different* people rather than a
 * thousand copies of twenty. The jitter is deterministic.
 *
 * Returns the archetypes unchanged when `size` is at or below their count —
 * a small population is simply the archetypes themselves, every one of which
 * thinks for itself.
 */
export function grow(archetypes: Persona[], size: number, random: () => number): Persona[] {
  if (archetypes.length === 0) return [];
  if (size <= archetypes.length) return archetypes.slice(0, Math.max(1, size));

  const people = [...archetypes];
  const wanted = size - archetypes.length;

  for (let index = 0; index < wanted; index += 1) {
    const source = archetypes[index % archetypes.length] as Persona;
    const jitter = (value: number): number =>
      Math.min(1, Math.max(0, value + (random() - 0.5) * 0.4));

    people.push({
      id: `${source.id}-${String(index + 1)}`,
      name: `${source.name} #${String(Math.floor(index / archetypes.length) + 2)}`,
      description: source.description,
      traits: source.traits,
      susceptibility: jitter(source.susceptibility),
      // Followers carry less weight than the archetype they came from. A
      // population where everybody is as influential as the loudest person in
      // it is a population with no shape.
      influence: jitter(source.influence) * 0.4,
      kind: 'follower',
      follows: source.id,
    });
  }

  return people;
}

/**
 * Wires the population up.
 *
 * Every follower listens to its own archetype strongly and to one other
 * archetype weakly — enough for a competing view to reach them, which is what
 * makes the outcome depend on the argument rather than on the seating plan.
 * Archetypes listen to each other, so the loud ones can move each other.
 */
export function wire(people: Persona[], random: () => number): Tie[] {
  const archetypes = people.filter((person) => person.kind === 'archetype');
  const ties: Tie[] = [];

  for (const person of people) {
    if (person.kind === 'archetype') {
      for (const other of archetypes) {
        if (other.id === person.id) continue;
        ties.push({ from: other.id, to: person.id, weight: 0.35 * other.influence });
      }
      continue;
    }

    const home = archetypes.find((candidate) => candidate.id === person.follows);
    if (home) ties.push({ from: home.id, to: person.id, weight: 0.8 });

    // One cross-tie, so no follower lives in a bubble of one voice.
    const others = archetypes.filter((candidate) => candidate.id !== person.follows);
    const stranger = others[Math.floor(random() * others.length)];
    if (stranger) ties.push({ from: stranger.id, to: person.id, weight: 0.25 });
  }

  return ties;
}

/**
 * One round of influence, for the agents that do not think for themselves.
 *
 * A follower's new position is its own, dragged toward the weighted average of
 * the people it listens to, by an amount its susceptibility decides. No model
 * is called. This is the arithmetic half of the simulation and the reason a
 * population of ten thousand costs the same as a population of twenty.
 */
export function propagate(
  people: readonly Persona[],
  ties: readonly Tie[],
  stances: readonly Stance[],
): Stance[] {
  const by = new Map(stances.map((stance) => [stance.personaId, stance]));
  const incoming = new Map<string, Tie[]>();
  for (const tie of ties) {
    incoming.set(tie.to, [...(incoming.get(tie.to) ?? []), tie]);
  }

  return people.map((person) => {
    const own = by.get(person.id);
    if (!own) return { personaId: person.id, position: 0, confidence: 0.3, said: '' };
    // An archetype thought for itself this round; nothing here overrides that.
    if (person.kind === 'archetype') return own;

    const heard = incoming.get(person.id) ?? [];
    let weighted = 0;
    let total = 0;
    for (const tie of heard) {
      const source = by.get(tie.from);
      if (!source) continue;
      // A confident speaker carries further than an unsure one.
      const strength = tie.weight * (0.5 + source.confidence / 2);
      weighted += source.position * strength;
      total += strength;
    }
    if (total === 0) return own;

    const room = weighted / total - own.position;

    // How much of the gap actually closes.
    //
    // Three things decide it, and the third was missing. Susceptibility: how
    // movable this person is. Confidence: somebody unsure is who a crowd
    // actually moves. And *reach* — how much signal arrived at all.
    //
    // Without reach, `weighted / total` is a plain average, so a persona who
    // hears one voice at weight 0.2 moves exactly as far as one who hears the
    // same voice at 0.9: the average of one number is that number whatever its
    // weight. A weakly-connected person on the edge of the graph would have
    // been swung as hard as somebody in the middle of it, and the social graph
    // would have been decoration.
    const reach = Math.min(1, total);
    const pull = person.susceptibility * (1 - own.confidence) * reach;

    // Agreeing with the people you listen to makes you surer of yourself, and
    // being surrounded by disagreement does not.
    const settled = Math.abs(room) < 0.2;

    return {
      personaId: person.id,
      position: Math.max(-1, Math.min(1, own.position + room * pull)),
      confidence: Math.min(1, settled ? own.confidence + 0.1 : own.confidence),
      said: '',
    };
  });
}

/** How settled the population is. Two rounds this close is a swarm that has stopped moving. */
export function movement(before: readonly Stance[], after: readonly Stance[]): number {
  const by = new Map(before.map((stance) => [stance.personaId, stance.position]));
  let total = 0;
  for (const stance of after) total += Math.abs(stance.position - (by.get(stance.personaId) ?? 0));
  return after.length === 0 ? 0 : total / after.length;
}
