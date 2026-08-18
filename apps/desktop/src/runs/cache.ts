import type Database from 'better-sqlite3';
import {
  CACHE_OFF,
  lookup,
  promptKey,
  remember,
  type CachePolicy,
  type PromptCacheHook,
} from '@chimera/core';
import { runsRepository, settingsRepository } from '@chimera/store';
import { adapterFor, type ProviderAdapter } from '@chimera/providers';
import { connectionFor } from '../providers/service.ts';

// M9-3's cache, assembled for one run.
//
// The engine takes a hook rather than a policy: whether an answer may be reused
// is a workspace decision, and turning a prompt into a vector needs a provider.
// Neither belongs inside the executor.

/**
 * Embeds a prompt, if this workspace has said which model to embed with.
 *
 * Returns null rather than throwing on any failure. A cache that took a run
 * down because an embedding endpoint was slow would be a cache that costs more
 * than it saves — the honest fallback is to make the call the run was going to
 * make anyway.
 */
async function embed(
  policy: settingsRepository.CachePolicySettings,
  text: string,
): Promise<number[] | null> {
  if (!policy.semantic) return null;
  if (policy.embeddingModel === '' || policy.embeddingConnectionId === '') return null;

  try {
    const connection = connectionFor(policy.embeddingConnectionId);
    const adapter = adapterFor(connection.kind) as ProviderAdapter & {
      embed?: (
        input: { model: string; input: string[] },
        options: { authRef: string; baseUrl?: string },
      ) => Promise<number[][]>;
    };
    if (!adapter.embed) return null;

    const vectors = await adapter.embed(
      { model: policy.embeddingModel, input: [text.slice(0, 8_000)] },
      {
        authRef: connection.authRef,
        ...(connection.baseUrl === null ? {} : { baseUrl: connection.baseUrl }),
      },
    );
    return vectors[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The cache hook for a run, or nothing when the workspace has not asked for one.
 *
 * Nothing rather than a no-op object: the engine checks for the hook's presence,
 * and an always-missing cache would still pay for the key derivation on every
 * call of every run.
 */
export function cacheHookFor(db: Database.Database, runId: string): PromptCacheHook | undefined {
  const settings = settingsRepository.read(db).cache;
  const policy: CachePolicy = {
    exact: settings.exact,
    semantic: settings.semantic,
    threshold: settings.threshold,
  };
  if (policy === CACHE_OFF || (!policy.exact && !policy.semantic)) return undefined;

  return {
    lookup: async ({ model, system, messages }) => {
      const key = promptKey(model, system, messages);
      const embedding = await embed(settings, `${system}\n${JSON.stringify(messages)}`);
      const hit = lookup(db, policy, { key, ...(embedding ? { embedding } : {}) });
      if (!hit) return null;

      // Recorded here rather than in the engine: this is the only place that
      // knows what the skipped call would have cost.
      runsRepository.addCacheSaving(db, runId, hit.savedCostUsd);
      return { response: hit.response, savedCostUsd: hit.savedCostUsd, kind: hit.kind };
    },

    remember: async ({ model, system, messages, response, costUsd }) => {
      const key = promptKey(model, system, messages);
      const embedding = await embed(settings, `${system}\n${JSON.stringify(messages)}`);
      remember(db, policy, {
        key,
        response,
        costUsd,
        ...(embedding ? { embedding } : {}),
      });
    },
  };
}
