import { createWorkspaceFacts, type WorkspaceFactsStore } from '@chimera/core';
import { getStore } from '../store/lifecycle.ts';

// The main-process surface for M2-10's workspace facts. Kept out of
// ipc/registry.ts for the same reason the provider service is: registry.ts is
// imported by the sandboxed preload, and this file reaches SQLite.

let facts: WorkspaceFactsStore | undefined;

function store(): WorkspaceFactsStore {
  facts ??= createWorkspaceFacts(getStore());
  return facts;
}

export function closeMemory(): void {
  facts = undefined;
}

export function listFacts(): { facts: ReturnType<WorkspaceFactsStore['list']> } {
  return { facts: store().list() };
}

/**
 * Writes a fact on the user's behalf.
 *
 * The source is hardcoded to `user` because this path is only ever reached
 * from the UI. An agent writing a fact goes through the run's own store and
 * records its run id, and the two must stay distinguishable — a fact an agent
 * asserted and a fact a person stated are not equally trustworthy.
 */
export function setFact(key: string, value: string) {
  return { fact: store().set(key, value, { source: 'user' }) };
}

export function deleteFact(key: string): { removed: boolean } {
  return { removed: store().remove(key) };
}
