import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { cacheRepository } from '@chimera/store';
import type { Message, NormalisedResponse } from '@chimera/providers';

// F9.4's cache: not asking the same question twice.
//
// Two kinds, and the difference between them is the whole design. An *exact*
// hit answers a byte-identical prompt to the same model — a claim about
// determinism that costs nothing to make. A *semantic* hit answers a prompt
// that is merely close, which is a claim about meaning, and a wrong one returns
// a confident answer to a question nobody asked. So exact is available by
// default and semantic is something a workspace turns on, with the threshold
// where a person can see it.

export interface CachePolicy {
  /** Exact-prompt reuse. Cheap and safe. */
  exact: boolean;
  /** Near-prompt reuse. Off unless asked for. */
  semantic: boolean;
  /** How close is close enough, as cosine similarity. 1 is identical. */
  threshold: number;
}

export const CACHE_OFF: CachePolicy = { exact: false, semantic: false, threshold: 0.97 };

/**
 * The key an exact hit is found by.
 *
 * Everything that changes the answer goes in: the model, the system prompt and
 * every message. Nothing that does not — no run id, no timestamp — or the key
 * would be unique per run and the cache would never hit at all.
 */
export function promptKey(model: string, system: string, messages: readonly Message[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        model,
        system,
        messages.map((message) => [message.role, message.content, message.toolCallId ?? '']),
      ]),
    )
    .digest('hex');
}

/** Cosine similarity. 1 is the same direction, 0 is unrelated. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    aMagnitude += left * left;
    bMagnitude += right * right;
  }

  const denominator = Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}

export interface CachedAnswer {
  response: NormalisedResponse;
  /** What the original call cost, so a hit can report what it saved. */
  savedCostUsd: number;
  kind: 'exact' | 'semantic';
  similarity: number;
}

interface StoredAnswer {
  response: NormalisedResponse;
  costUsd: number;
}

/**
 * Looks for an answer already given.
 *
 * Only ever returns a response with no tool calls. A cached tool call would
 * replay a side effect that already happened — the whole point of M2-9's
 * idempotency keys is that a call happens once, and a cache that handed the
 * same call back would undo that guarantee from the other direction.
 */
export function lookup(
  db: Database.Database,
  policy: CachePolicy,
  input: { key: string; embedding?: readonly number[] | null },
): CachedAnswer | null {
  if (policy.exact) {
    const exact = cacheRepository.getExact(db, input.key);
    if (exact) {
      const stored = JSON.parse(exact.responseJson) as StoredAnswer;
      if (stored.response.toolCalls.length === 0) {
        cacheRepository.recordHit(db, exact.keyHash);
        return {
          response: stored.response,
          savedCostUsd: stored.costUsd,
          kind: 'exact',
          similarity: 1,
        };
      }
    }
  }

  if (!policy.semantic || !input.embedding || input.embedding.length === 0) return null;

  let best: { entry: (typeof candidates)[number]; score: number } | null = null;
  const candidates = cacheRepository.withEmbeddings(db);
  for (const entry of candidates) {
    if (!entry.embedding) continue;
    const score = cosine(input.embedding, entry.embedding);
    if (score >= policy.threshold && (best === null || score > best.score)) {
      best = { entry, score };
    }
  }

  if (!best) return null;

  const stored = JSON.parse(best.entry.responseJson) as StoredAnswer;
  if (stored.response.toolCalls.length > 0) return null;

  cacheRepository.recordHit(db, best.entry.keyHash);
  return {
    response: stored.response,
    savedCostUsd: stored.costUsd,
    kind: 'semantic',
    similarity: best.score,
  };
}

/** Remembers one answer. Refuses anything with a tool call, for the reason above. */
export function remember(
  db: Database.Database,
  policy: CachePolicy,
  input: {
    key: string;
    response: NormalisedResponse;
    costUsd: number;
    embedding?: readonly number[] | null;
    workflowId?: string | null;
  },
): void {
  if (!policy.exact && !policy.semantic) return;
  if (input.response.toolCalls.length > 0) return;

  const stored: StoredAnswer = { response: input.response, costUsd: input.costUsd };
  cacheRepository.put(db, {
    keyHash: input.key,
    kind: policy.semantic && input.embedding ? 'semantic' : 'exact',
    responseJson: JSON.stringify(stored),
    embedding: input.embedding ? [...input.embedding] : null,
    workflowId: input.workflowId ?? null,
  });
}
