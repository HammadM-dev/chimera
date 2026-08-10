// The session's running cost, shared between the chat panel that earns it and
// the status bar that displays it.
//
// A module-level store rather than React context: the two components sit in
// different regions of the shell with no common ancestor below the root, and
// threading a provider through the whole tree for one number would be more
// structure than the fact deserves. M4 replaces this with the real run store.

export interface SessionTotals {
  /** Cost in USD of every exchange this session that had a verified price. */
  costUsd: number;
  /** Exchanges completed against a model with no verified price. */
  unpricedExchanges: number;
  exchanges: number;
}

let totals: SessionTotals = { costUsd: 0, unpricedExchanges: 0, exchanges: 0 };
const listeners = new Set<(totals: SessionTotals) => void>();

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
  totals = {
    costUsd: totals.costUsd + (costUsd ?? 0),
    unpricedExchanges: totals.unpricedExchanges + (costUsd === null ? 1 : 0),
    exchanges: totals.exchanges + 1,
  };
  for (const listener of listeners) listener(totals);
}

export function subscribeToSession(listener: (totals: SessionTotals) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: the E2E suite launches a fresh app per test, so this is only for unit tests. */
export function resetSession(): void {
  totals = { costUsd: 0, unpricedExchanges: 0, exchanges: 0 };
}
