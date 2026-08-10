// Per-model capability records, as data. CLAUDE.md hard rule 7: "Model
// differences are expressed as capability data, never as branching logic in the
// engine." This file is the data; there is deliberately no function here that
// branches on a provider or model family, and a test asserts that by reading
// this module's own source.
//
// Two kinds of fact live in these records, and they are treated differently on
// purpose:
//
//   Stable capability facts — does this model call tools, accept images,
//   stream, produce structured output. These change rarely and are safe to
//   state statically.
//
//   Volatile numeric facts — context window, max output, price per million
//   tokens. These change without notice, and a stale one is worse than an
//   absent one: a wrong context window silently truncates a prompt, and a wrong
//   price makes the Governor's budget arithmetic (M3) wrong in a way nobody
//   notices until the bill arrives.
//
// So a numeric fact this repository cannot verify is `null`, not a guess.
// Consumers must handle that — which forces them to ask the provider rather
// than assume. M1-8's health checks fill the nulls in from each provider's own
// models endpoint where one exists.

/** Tri-state because "we have not verified this" is a real answer, distinct from "no". */
export type Support = 'supported' | 'unsupported' | 'unknown';

export type Pricing =
  | {
      kind: 'metered';
      inputPerMillion: number;
      outputPerMillion: number;
      currency: 'USD';
      /** ISO date this price was last checked against the provider's own published rates. */
      verifiedAt: string;
    }
  /** Runs on the user's own hardware. Genuinely free per token — not "unknown". */
  | { kind: 'local' }
  /** No verified price. The Governor must refuse to enforce a cost cap rather than guess. */
  | { kind: 'unknown' };

export interface ModelCapabilities {
  modelId: string;
  displayName: string;
  /** Null when not statically known — query the provider (M1-8). Never a guess. */
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  toolCalling: Support;
  vision: Support;
  streaming: Support;
  structuredOutput: Support;
  pricing: Pricing;
}

// Verified 2026-06-24 against Anthropic's published model and pricing tables.
// Context windows are 1M except Haiku 4.5 (200K); max output 128K except Haiku
// 4.5 (64K).
//
// Claude Sonnet 5 carries introductory pricing of $2.00/$10.00 per million
// through 2026-08-31, which is currently in effect. The standard $3.00/$15.00
// is recorded here instead, deliberately: an over-estimated price makes a spend
// cap trip *earlier* than it needs to, which is the safe direction to be wrong
// in for a budget guard. Time-varying pricing is not modelled — when a
// promotional rate matters enough to track, it belongs in the Governor's cost
// preview (M3-3), not in a static table that would then have to know today's
// date to answer a question about capability.
const ANTHROPIC_MODELS: readonly ModelCapabilities[] = [
  {
    modelId: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    toolCalling: 'supported',
    vision: 'supported',
    streaming: 'supported',
    structuredOutput: 'supported',
    pricing: {
      kind: 'metered',
      inputPerMillion: 5,
      outputPerMillion: 25,
      currency: 'USD',
      verifiedAt: '2026-06-24',
    },
  },
  {
    modelId: 'claude-fable-5',
    displayName: 'Claude Fable 5',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    toolCalling: 'supported',
    vision: 'supported',
    streaming: 'supported',
    structuredOutput: 'supported',
    pricing: {
      kind: 'metered',
      inputPerMillion: 10,
      outputPerMillion: 50,
      currency: 'USD',
      verifiedAt: '2026-06-24',
    },
  },
  {
    modelId: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    toolCalling: 'supported',
    vision: 'supported',
    streaming: 'supported',
    structuredOutput: 'supported',
    pricing: {
      kind: 'metered',
      inputPerMillion: 5,
      outputPerMillion: 25,
      currency: 'USD',
      verifiedAt: '2026-06-24',
    },
  },
  {
    modelId: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    toolCalling: 'supported',
    vision: 'supported',
    streaming: 'supported',
    structuredOutput: 'supported',
    pricing: {
      kind: 'metered',
      inputPerMillion: 3,
      outputPerMillion: 15,
      currency: 'USD',
      verifiedAt: '2026-06-24',
    },
  },
  {
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    toolCalling: 'supported',
    vision: 'supported',
    streaming: 'supported',
    structuredOutput: 'supported',
    pricing: {
      kind: 'metered',
      inputPerMillion: 3,
      outputPerMillion: 15,
      currency: 'USD',
      verifiedAt: '2026-06-24',
    },
  },
  {
    modelId: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    toolCalling: 'supported',
    vision: 'supported',
    streaming: 'supported',
    structuredOutput: 'supported',
    pricing: {
      kind: 'metered',
      inputPerMillion: 1,
      outputPerMillion: 5,
      currency: 'USD',
      verifiedAt: '2026-06-24',
    },
  },
];

// OpenAI and Google models are seeded so a lookup resolves to a real record
// rather than the fallback, but their numbers are null and their pricing is
// `unknown`. That is not an oversight — it is the point. This repository has no
// verified figures for them, and a plausible-looking wrong context window is
// more dangerous than an absent one, because it fails silently. The capability
// flags below are stated because they are stable, long-established properties
// of these model families, not volatile numbers.
//
// M1-8's health checks populate the nulls from each provider's own models
// endpoint. Until then, M3's cost enforcement must refuse to price a run on
// these models rather than guess — see the decision in docs/ROADMAP.md M1-3.
const UNPRICED_CLOUD_MODELS: readonly ModelCapabilities[] = [
  ...['gpt-5', 'gpt-5-mini', 'gpt-4.1'].map((modelId): ModelCapabilities => ({
    modelId,
    displayName: modelId,
    contextWindowTokens: null,
    maxOutputTokens: null,
    toolCalling: 'supported',
    vision: 'supported',
    streaming: 'supported',
    structuredOutput: 'supported',
    pricing: { kind: 'unknown' },
  })),
  ...['gemini-2.5-pro', 'gemini-2.5-flash'].map((modelId): ModelCapabilities => ({
    modelId,
    displayName: modelId,
    contextWindowTokens: null,
    maxOutputTokens: null,
    toolCalling: 'supported',
    vision: 'supported',
    streaming: 'supported',
    structuredOutput: 'supported',
    pricing: { kind: 'unknown' },
  })),
];

/**
 * Returned for any model not in the matrix — Ollama, LM Studio, an
 * OmniRoute-served model, or a cloud model released after this build.
 *
 * Everything is `unknown` or `null` rather than a permissive default. A
 * fallback that claimed `toolCalling: 'supported'` would make the runtime send
 * tools to a model that cannot accept them and fail at the provider; one that
 * claimed `'unsupported'` would silently disable tools on a model that handles
 * them fine. "We do not know, go and find out" is the only answer that leads
 * callers to the right behaviour.
 *
 * Pricing is `unknown`, not `local`: a locally-served model is free, but this
 * record is also returned for unrecognised *cloud* models, and assuming free is
 * the one wrong answer with a financial consequence.
 */
export const FALLBACK_CAPABILITIES: ModelCapabilities = {
  modelId: 'unknown',
  displayName: 'Unknown model',
  contextWindowTokens: null,
  maxOutputTokens: null,
  toolCalling: 'unknown',
  vision: 'unknown',
  streaming: 'unknown',
  structuredOutput: 'unknown',
  pricing: { kind: 'unknown' },
};

/** The matrix itself: a plain frozen record, no behaviour. */
export const MODEL_CAPABILITIES: Readonly<Record<string, ModelCapabilities>> = Object.freeze(
  Object.fromEntries(
    [...ANTHROPIC_MODELS, ...UNPRICED_CLOUD_MODELS].map((record) => [record.modelId, record]),
  ),
);

/**
 * Looks a model up, falling back rather than returning undefined or throwing.
 *
 * The one piece of normalisation is generic and provider-agnostic: routers
 * address models as `vendor/model` (OpenRouter's `anthropic/claude-opus-5`),
 * so a miss retries on the final path segment. That is a syntax rule about
 * identifiers, not a branch on who the vendor is — this function has no
 * knowledge of any provider's name and must not acquire one.
 */
export function get(modelId: string): ModelCapabilities {
  const exact = MODEL_CAPABILITIES[modelId];
  if (exact) return exact;

  const lastSegment = modelId.slice(modelId.lastIndexOf('/') + 1);
  return MODEL_CAPABILITIES[lastSegment] ?? FALLBACK_CAPABILITIES;
}

/** True when `modelId` has a record of its own rather than falling back. */
export function isKnown(modelId: string): boolean {
  return get(modelId) !== FALLBACK_CAPABILITIES;
}

/**
 * Whether a run on this model can be costed at all.
 *
 * The Governor (M3) calls this before enforcing a spend cap. A model whose
 * price is unknown cannot be budgeted, and the correct response is to say so
 * and let the user decide — not to silently enforce a cap using a number
 * nobody verified.
 */
export function canEstimateCost(modelId: string): boolean {
  const pricing = get(modelId).pricing;
  return pricing.kind === 'metered' || pricing.kind === 'local';
}

export function supports(
  modelId: string,
  capability: 'toolCalling' | 'vision' | 'streaming' | 'structuredOutput',
): Support {
  return get(modelId)[capability];
}

/** Every seeded model id. Excludes the fallback, which is not a model. */
export function listModelIds(): readonly string[] {
  return Object.keys(MODEL_CAPABILITIES);
}
