// The session's running cost, shared between the chat panel that earns it and
// the status bar that displays it.
//
// A module-level store rather than React context: the components sit in
// different regions of the shell with no common ancestor below the root, and
// threading a provider through the whole tree for one number would be more
// structure than the fact deserves.
//
// Two sources feed it. The chat panel reports one exchange at a time; a run
// reports its running total, repeatedly, as it spends. They are kept apart and
// added, rather than both calling `recordExchange`, because adding a running
// total to itself on every update would multiply the bill on screen.

export interface SessionTotals {
  /** Cost in USD of every exchange this session that had a verified price. */
  costUsd: number;
  /** Exchanges completed against a model with no verified price. */
  unpricedExchanges: number;
  exchanges: number;
}

let chat: SessionTotals = { costUsd: 0, unpricedExchanges: 0, exchanges: 0 };
/** The latest total for each run this session, by run id. */
const runs = new Map<string, { costUsd: number; unpriced: boolean }>();
let totals: SessionTotals = { costUsd: 0, unpricedExchanges: 0, exchanges: 0 };
const listeners = new Set<(totals: SessionTotals) => void>();

function recompute(): void {
  let costUsd = chat.costUsd;
  let unpriced = chat.unpricedExchanges;
  for (const run of runs.values()) {
    costUsd += run.costUsd;
    if (run.unpriced) unpriced += 1;
  }
  totals = { costUsd, unpricedExchanges: unpriced, exchanges: chat.exchanges + runs.size };
  for (const listener of listeners) listener(totals);
}

export function sessionTotals(): SessionTotals {
  return totals;
}

/**
 * Records one completed exchange.
 *
 * `null` cost means the model has no verified price (M1-3). Counted separately
 * rather than added as zero: a session total that silently absorbed unpriced
 * calls would read as complete when it is not.
 */
export function recordExchange(costUsd: number | null): void {
  chat = {
    costUsd: chat.costUsd + (costUsd ?? 0),
    unpricedExchanges: chat.unpricedExchanges + (costUsd === null ? 1 : 0),
    exchanges: chat.exchanges + 1,
  };
  recompute();
}

/**
 * Records a run's spend so far.
 *
 * Replaces rather than adds: the engine's meter reports the run's *total* after
 * every call, so the last word for a run is the whole truth about it.
 */
export function recordRunSpend(runId: string, spend: { costUsd: number; unpriced: boolean }): void {
  runs.set(runId, spend);
  recompute();
}

export function subscribeToSession(listener: (totals: SessionTotals) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: the E2E suite launches a fresh app per test, so this is only for unit tests. */
export function resetSession(): void {
  chat = { costUsd: 0, unpricedExchanges: 0, exchanges: 0 };
  runs.clear();
  totals = { costUsd: 0, unpricedExchanges: 0, exchanges: 0 };
}
