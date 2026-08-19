import { createWorkspaceFacts, type WorkspaceFactsStore } from '@chimera/core';
import { memoriesRepository, type MemoryKind } from '@chimera/store';
import { detectTencentDb } from './tencentdb.ts';
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

/**
 * A fact the planner learned, attributed to the planner.
 *
 * Not `user`: nobody typed it. Keyed by automation name so designing the same
 * automation twice updates one fact rather than growing the store, and so the
 * next plan can see what this workspace already automates instead of proposing
 * it again.
 */
export function rememberDesign(key: string, value: string) {
  return { fact: store().set(key, value, { source: 'planner' }) };
}

export function deleteFact(key: string): { removed: boolean } {
  return { removed: store().remove(key) };
}

// ---- the memory store the agents write to --------------------------------

/**
 * Everything remembered, with the counts the view groups by and which backend
 * is actually serving it.
 *
 * The backend is reported rather than assumed, because "where did this come
 * from" is the first question a memory list raises and the answer changes
 * depending on whether TencentDB Agent Memory happens to be running.
 */
export async function listMemories(query?: string) {
  const db = getStore();
  const memories =
    query === undefined || query.trim() === ''
      ? memoriesRepository.list(db)
      : memoriesRepository.search(db, query.trim(), 200);

  const tencent = await detectTencentDb();

  return {
    memories,
    counts: memoriesRepository.countByKind(db),
    backend: tencent.available
      ? { name: 'TencentDB Agent Memory', available: true, detail: tencent.baseUrl }
      : {
          name: 'Local workspace store',
          available: true,
          detail:
            tencent.detail === 'not running'
              ? 'TencentDB Agent Memory is not running on this machine'
              : `TencentDB Agent Memory: ${tencent.detail}`,
        },
  };
}

/** A memory the user typed. Source is `user`, and it stays that way. */
export function writeMemory(input: {
  kind: string;
  subject: string;
  body: string;
  tags?: string[];
}) {
  return {
    memory: memoriesRepository.remember(getStore(), {
      kind: input.kind as MemoryKind,
      subject: input.subject,
      body: input.body,
      source: 'user',
      // A person stating something is not a guess.
      confidence: 1,
      tags: input.tags ?? [],
    }),
  };
}

export function forgetMemory(id: string): { removed: boolean } {
  return { removed: memoriesRepository.forget(getStore(), id) };
}
