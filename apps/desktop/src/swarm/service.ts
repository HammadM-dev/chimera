import {
  Governor,
  simulate,
  type Persona,
  type RoundReport,
  type SwarmResult,
} from '@chimera/core';
import {
  adapterFor,
  textOf,
  type ProviderAdapter,
  type AdapterCallOptions,
} from '@chimera/providers';
import { ProviderError } from '@chimera/errors';
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

function stanceSystem(persona: Persona): string {
  return [
    `You are ${persona.name}. ${persona.description}`,
    persona.traits.length === 0 ? '' : `What decides how you react: ${persona.traits.join(', ')}.`,
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

function clamp(value: unknown, low: number, high: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
}

export interface SwarmRunDeps {
  onRound?: (report: RoundReport) => void;
  cancellation?: { readonly cancelled: boolean };
}

export async function runSwarm(spec: SwarmRunSpec, deps: SwarmRunDeps = {}): Promise<SwarmResult> {
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

  const call = async (
    system: string,
    user: string,
    expectedOutput: number,
    purpose: 'plan' | 'act',
  ): Promise<string> => {
    const authorization = governor.authorizeModelCall({
      runId: spec.seed,
      nodeId: 'swarm',
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
  };

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
      ...(deps.onRound ? { onRound: deps.onRound } : {}),
      ...(deps.cancellation ? { cancellation: deps.cancellation } : {}),

      buildPersonas: async ({ question, background, count }) => {
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

        const parsed = parseJson(await call(stanceSystem(persona), asked, 200, 'act'));
        return {
          position: clamp(parsed['position'], -1, 1, 0),
          confidence: clamp(parsed['confidence'], 0, 1, 0.4),
          said: typeof parsed['said'] === 'string' ? parsed['said'] : '',
        };
      },
    },
  );
}

/** Exported for a test that wants to drive the simulation without a provider. */
export type { ProviderAdapter };
