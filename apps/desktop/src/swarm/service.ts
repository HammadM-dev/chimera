import {
  DEFAULT_CONCURRENCY,
  Governor,
  simulate,
  type Persona,
  type RoundReport,
  type SwarmGraph,
  type SwarmResult,
} from '@chimera/core';
import {
  adapterFor,
  textOf,
  type ProviderAdapter,
  type AdapterCallOptions,
} from '@chimera/providers';
import { ProviderError, ProviderRateLimitError, isRetryable } from '@chimera/errors';
import { SwarmThrottle } from './throttle.ts';
import { connectionFor } from '../providers/service.ts';

// The swarm, driven by real models.
//
// `packages/core/src/swarm` is the simulation and knows nothing about
// providers; this is the half that spends money, and every call on it goes
// through the Governor like every other call in this product.
//
// Two model calls exist here and no others: one that writes the cast, and one
// that asks a persona where it stands. Everything else a swarm does — growing
// the population, wiring the graph, propagating a round — is arithmetic. That
// division is the whole cost story, and it is why a swarm of ten thousand costs
// what a swarm of two hundred costs.

export interface SwarmRunSpec {
  connectionId: string;
  model: string;
  question: string;
  background: string;
  population: number;
  maxRounds: number;
  everyoneUpTo: number;
  seed: string;
  /** Simultaneous model calls. Lowered automatically when limits are hit. */
  concurrency?: number;
  /**
   * The cast, when this thread already has one.
   *
   * A follow-up has to reach the *same* crowd or a thread is just a series of
   * unrelated runs sharing a title — "and if the price were double?" put to a
   * freshly-written cast answers a different question from the one before it.
   * The archetypes are the only part of a population that a model writes; the
   * rest is arithmetic off the seed, so holding these fixed and holding the
   * seed fixed reproduces the same people, the same followers and the same
   * social graph. What changes between turns is what they have heard.
   */
  cast?: Persona[];
}

const PERSONA_SYSTEM = [
  'You write the cast for a simulation of how a group of people would react to something.',
  '',
  'Write people, not opinions. Each one is somebody a reader could picture: what they do, what',
  'they care about, what would worry them about this. Between them they must cover the real range',
  'of reactions — including the ones nobody in the room wants to hear. A cast that all agrees is a',
  'simulation that has answered nothing.',
  '',
  'For each person give:',
  '  name          two or three words, a description not a proper name ("night-shift nurse")',
  '  description   one sentence: who they are and what they are weighing here',
  '  traits        two to four words that decide how they react',
  '  susceptibility 0 to 1 — how much they move when people they trust move. A contrarian is low.',
  '  influence     0 to 1 — how much weight they carry with others. A quiet sceptic is low.',
  '',
  'Answer with JSON only: {"personas": [{"name": "", "description": "", "traits": [],',
  '"susceptibility": 0, "influence": 0}]}',
].join('\n');

function stanceSystem(persona: Persona, context: { population: number; rounds: number }): string {
  return [
    `You are ${persona.name}. ${persona.description}`,
    persona.traits.length === 0 ? '' : `What decides how you react: ${persona.traits.join(', ')}.`,
    '',
    // What this call is one of, which nothing here used to say. A model asked
    // for an opinion with no account of what the opinion is for hedges towards
    // the balanced middle — which, averaged over a few hundred of them, is a
    // population with no disagreement in it and therefore no finding. Knowing
    // it is one voice among many, that others will read this line, and that the
    // spread is the point, is what makes a crowd behave like a crowd.
    `You are one of ${String(context.population)} people being asked the same thing, over up to ${String(context.rounds)} rounds. What you say is shown to the people who listen to you, and they may move because of it. Nobody is aggregating you into a consensus: the disagreement is the finding, so do not soften towards what you think the middle is.`,
    'You have no tools and nothing to look up. Answer from who you are and from what you have been told.',
    '',
    'You are not an assistant and you are not being helpful. You are this person, reacting.',
    'Say what you actually think in one or two sentences, in your own voice. You may change your',
    'mind because of what somebody said, and you may dig in. Do not summarise the discussion, do',
    'not be even-handed for its own sake, and do not mention that you are simulated.',
    '',
    'Then say where you stand:',
    '  position    -1 dead against, 0 genuinely undecided, +1 strongly for',
    '  confidence  0 to 1 — how sure you are',
    '',
    'Answer with JSON only: {"said": "", "position": 0, "confidence": 0}',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function parseJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * How many times one swarm call may be retried.
 *
 * Far more than the agent loop allows, on purpose. An agent step is one
 * expensive call in a sequence a person is waiting on, so failing fast and
 * saying why is right. A swarm call is small, idempotent, one of a hundred, and
 * the run around it takes minutes anyway — and on a free tier a refusal is
 * routine rather than exceptional. Measured against OpenRouter's free models:
 * 429 on a request issued right after a successful one, clearing within
 * seconds. Four attempts covered about eight seconds of that and gave up in
 * the middle of a round; the user saw "rate limit reached" on models that
 * worked perfectly well one call at a time.
 */
const SWARM_RETRIES = 14;

function clamp(value: unknown, low: number, high: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
}

export interface SwarmRunDeps {
  /** Shared with `report`, so the write-up is not treated as a fresh start. */
  throttle?: SwarmThrottle;
  onPopulation?: (graph: SwarmGraph) => void;
  onRound?: (report: RoundReport) => void;
  /** Per-agent progress, so the window can show the work rather than a spinner. */
  onThinking?: (event: {
    personaId: string;
    round: number;
    state: 'asking' | 'answered' | 'failed';
    position?: number;
    confidence?: number;
    said?: string;
  }) => void;
  cancellation?: { readonly cancelled: boolean };
}

/**
 * A model call that waits its turn and retries what is worth retrying.
 *
 * Lifted out of `runSwarm` because `report` was calling `adapter.chat`
 * directly, with no throttle and no retry at all. It is the last call a swarm
 * makes, so on a rate-limited provider the entire population would think for
 * thirteen minutes, finish, and then die writing up the answer — throwing away
 * every round. The symptom was "rate limit reached" arriving long after the
 * work was done, which is exactly what it looked like.
 *
 * One throttle is shared across a whole ask for the same reason: the report is
 * not a fresh start, it is the fiftieth request in a minute.
 */
export function swarmCaller(
  spec: Pick<SwarmRunSpec, 'connectionId' | 'model' | 'seed'>,
  throttle: SwarmThrottle,
): (
  system: string,
  user: string,
  expectedOutput: number,
  purpose: 'plan' | 'act',
  nodeId?: string,
) => Promise<string> {
  const connection = connectionFor(spec.connectionId);
  const adapter = adapterFor(connection.kind);
  const options: AdapterCallOptions = {
    authRef: connection.authRef,
    ...(connection.baseUrl === null ? {} : { baseUrl: connection.baseUrl }),
  };

  // Permissive, like the planner's: a swarm is a single thing the user asked
  // for rather than an automation with per-role budgets. The population and
  // round caps are what bound the spend, and they are on the request.
  const governor = new Governor('permissive');

  return async (system, user, expectedOutput, purpose, nodeId = 'swarm') => {
    const authorization = governor.authorizeModelCall({
      runId: spec.seed,
      nodeId,
      roleId: 'swarm',
      iteration: 0,
      depth: 0,
      purpose,
      connectionId: spec.connectionId,
      model: spec.model,
      estimatedInputTokens: Math.ceil((system.length + user.length) / 4),
      estimatedOutputTokens: expectedOutput,
      requiredCapabilities: [],
    });
    if (authorization.decision === 'deny') {
      throw new ProviderError('SWARM_DENIED', authorization.message);
    }

    // Every worker queues behind the same gate before it sends.
    await throttle.wait();

    for (let attempt = 0; ; attempt += 1) {
      try {
        return textOf(
          await adapter.chat(
            {
              model: authorization.request.model,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
            },
            options,
          ),
        );
      } catch (err) {
        if (!isRetryable(err) || attempt >= SWARM_RETRIES) throw err;

        if (err instanceof ProviderRateLimitError) {
          const retryAfterMs = Number(err.details['retryAfterMs']);
          throttle.penalise(Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
        }

        // Capped low deliberately: these refusals clear in seconds, and the
        // Governor's default backoff climbs to thirty, which would spend a
        // swarm's whole budget waiting out a limit that had already lifted.
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(6_000, governor.backoffFor(attempt))),
        );
        await throttle.wait();
      }
    }
  };
}

export async function runSwarm(spec: SwarmRunSpec, deps: SwarmRunDeps = {}): Promise<SwarmResult> {
  const throttle =
    deps.throttle ?? new SwarmThrottle({ permits: spec.concurrency ?? DEFAULT_CONCURRENCY });
  const call = swarmCaller(spec, throttle);

  return simulate(
    {
      question: spec.question,
      background: spec.background,
      population: spec.population,
      maxRounds: spec.maxRounds,
      everyoneUpTo: spec.everyoneUpTo,
      settleAt: 0.03,
    },
    {
      seed: spec.seed,
      // Read per round rather than fixed at the start: a swarm that met a limit
      // in round one should not open the same number of connections in round
      // two, and the throttle is what knows that.
      get concurrency() {
        return throttle.concurrency;
      },
      ...(deps.onPopulation ? { onPopulation: deps.onPopulation } : {}),
      ...(deps.onRound ? { onRound: deps.onRound } : {}),
      ...(deps.onThinking ? { onThinking: deps.onThinking } : {}),
      ...(deps.cancellation ? { cancellation: deps.cancellation } : {}),

      buildPersonas: async ({ question, background, count }) => {
        // A thread that already has a cast reuses it rather than paying a model
        // to write a new one.
        //
        // `count` can exceed what is stored, because the dials are editable
        // between turns and a bigger population asks for more archetypes. The
        // stored cast still wins: keeping the same people and growing more
        // followers around them is what somebody means by asking the same crowd
        // a bigger version of the question. Hiring strangers to make up the
        // difference is not.
        if (spec.cast !== undefined && spec.cast.length > 0) {
          return spec.cast.slice(0, count);
        }

        const asked = [
          `Write ${String(count)} people for this:`,
          question,
          background === '' ? '' : `\nWhat they already know:\n${background}`,
        ]
          .filter((line) => line !== '')
          .join('\n');

        const parsed = parseJson(await call(PERSONA_SYSTEM, asked, 220 * count, 'plan'));
        const written = Array.isArray(parsed['personas']) ? parsed['personas'] : [];

        return written.slice(0, count).map((entry, index): Persona => {
          const record = (entry ?? {}) as Record<string, unknown>;
          const traits = Array.isArray(record['traits'])
            ? record['traits'].filter((trait): trait is string => typeof trait === 'string')
            : [];
          return {
            id: `a${String(index)}`,
            name:
              typeof record['name'] === 'string' ? record['name'] : `Person ${String(index + 1)}`,
            description: typeof record['description'] === 'string' ? record['description'] : '',
            traits,
            susceptibility: clamp(record['susceptibility'], 0, 1, 0.5),
            influence: clamp(record['influence'], 0, 1, 0.5),
            kind: 'archetype',
            follows: '',
          };
        });
      },

      ask: async ({ persona, question, background, heard, round }) => {
        const asked = [
          question,
          background === '' ? '' : `\nWhat you already know:\n${background}`,
          heard.length === 0
            ? round === 1
              ? '\nThis is the first you have heard of it.'
              : '\nNobody you listen to has said anything new.'
            : `\nWhat people you listen to have been saying:\n${heard
                .map((one) => `${one.name}: ${one.said}`)
                .join('\n')}`,
        ]
          .filter((line) => line !== '')
          .join('\n');

        const parsed = parseJson(
          await call(
            stanceSystem(persona, { population: spec.population, rounds: spec.maxRounds }),
            asked,
            200,
            'act',
          ),
        );
        return {
          position: clamp(parsed['position'], -1, 1, 0),
          confidence: clamp(parsed['confidence'], 0, 1, 0.4),
          said: typeof parsed['said'] === 'string' ? parsed['said'] : '',
        };
      },
    },
  );
}

const REPORT_SYSTEM = [
  'You report what happened in a simulation of how a group of people reacted to something.',
  '',
  'You are reporting, not deciding. Say where the population ended up and *why* — which',
  'arguments moved people, who held out, what changed between the first round and the last. Quote',
  'the lines that did the moving. If it split rather than converging, say so: a split is a finding,',
  'not a failure to produce one.',
  '',
  'Give the numbers as they are, and say plainly which of the two modes produced them, in one',
  'clause, without apologising for it:',
  '  everyone   — every one of these agents was asked directly',
  '  archetypes — this many thought it through; the rest of the population followed them through',
  '               who listens to whom, so the percentages model a crowd rather than count one',
  '',
  'No preamble, no restating the question. Four short paragraphs at most.',
  '',
  'Then a title for this conversation on its own last line, prefixed exactly "TITLE: " — three or',
  'four words naming the subject, not the outcome, so it still reads right after the next question.',
].join('\n');

export interface SwarmReport {
  /** What happened, in words. This is the thing a person reads. */
  answer: string;
  /** Three or four words naming the thread. Empty when the model gave none. */
  title: string;
}

/**
 * Stage four: turns a simulation into something worth reading.
 *
 * One model call for the whole run, however large the population. A swarm that
 * produced only a percentage would be a poll with extra steps — what makes it
 * worth running is *why* the population went where it did, and that is in what
 * they said to each other.
 */
export async function report(
  spec: SwarmRunSpec,
  result: SwarmResult,
  throttle?: SwarmThrottle,
): Promise<SwarmReport> {
  const call = swarmCaller(
    spec,
    throttle ?? new SwarmThrottle({ permits: spec.concurrency ?? DEFAULT_CONCURRENCY }),
  );

  const transcript = result.rounds
    .map((round) =>
      [
        `Round ${String(round.round)} — for ${String(round.distribution.for)}, against ${String(
          round.distribution.against,
        )}, undecided ${String(round.distribution.undecided)}`,
        ...round.said.map((one) => `  ${one.name} (${one.position.toFixed(2)}): ${one.said}`),
      ].join('\n'),
    )
    .join('\n\n');

  const asked = [
    `The question: ${spec.question}`,
    `Population: ${String(result.population)}. Mode: ${result.mode}. Thinking agents: ${String(
      result.thinking,
    )}.`,
    `It stopped because: ${result.stopped}.`,
    '',
    transcript,
  ].join('\n');

  const text = await call(REPORT_SYSTEM, asked, 700, 'act', 'swarm-report');

  const title = /^TITLE:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  return { answer: text.replace(/^TITLE:.*$/m, '').trim(), title };
}

/** Exported for a test that wants to drive the simulation without a provider. */
export type { ProviderAdapter };
