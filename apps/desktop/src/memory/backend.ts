import { memoriesRepository, type MemoryKind } from '@chimera/store';
import type { MemoryBackend } from '@chimera/tools';
import { getStore } from '../store/lifecycle.ts';

// Where an agent's memory actually goes.
//
// Local SQLite is the default and the only one that needs nothing installed.
// TencentDB Agent Memory (tencentdb.ts) is used instead when it is running,
// because it is a richer store — but a memory system that stops working when a
// service is down is worse than a simple one that does not, so local is the
// floor rather than a fallback nobody tested.

export function localBackend(runId: string | null, source: string): MemoryBackend {
  return {
    remember: (input) => {
      const stored = memoriesRepository.remember(getStore(), {
        kind: input.kind as MemoryKind,
        subject: input.subject,
        body: input.body,
        source,
        runId,
        confidence: input.confidence,
        tags: input.tags,
      });
      return { id: stored.id };
    },
    recall: (query, limit) =>
      memoriesRepository
        .search(getStore(), query, limit)
        .map((row) => ({ subject: row.subject, body: row.body, kind: row.kind })),
  };
}
