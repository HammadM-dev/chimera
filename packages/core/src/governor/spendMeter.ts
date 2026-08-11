import type Database from 'better-sqlite3';
import { nodeStatesRepository, runsRepository } from '@chimera/store';
import type { Usage } from '@chimera/providers';
import { costOf } from './budget.ts';
import type { Governor } from './Governor.ts';

// F4.5's live spend meter. What a run has actually cost, as it costs it.
//
// The Governor charges an *estimate* before each call, because a cap enforced
// after the fact is not a cap (M3-1). This is the other half: once the provider
// reports what the call really used, the difference is reconciled so the
// running total is the real one rather than the forecast.

export interface SpendSnapshot {
  runId: string;
  tokens: number;
  costUsd: number;
  byNode: Record<string, { tokens: number; costUsd: number }>;
  /** True when any call in this run used a model with no verified price. */
  hasUnpricedCalls: boolean;
}

export interface SpendMeterOptions {
  db: Database.Database;
  runId: string;
  governor: Governor;
  /** Called after every cost-incurring call, with the new totals. */
  onUpdate?: (snapshot: SpendSnapshot) => void;
}

export interface SpendMeter {
  /** Records one completed model call's real usage. */
  record: (input: {
    nodeId: string;
    roleId: string;
    model: string;
    usage: Usage;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
  }) => SpendSnapshot;
  snapshot: () => SpendSnapshot;
}

export function createSpendMeter(options: SpendMeterOptions): SpendMeter {
  const { db, runId, governor } = options;
  let hasUnpricedCalls = false;

  const read = (): SpendSnapshot => {
    const run = runsRepository.spendOf(db, runId);
    const byNode: Record<string, { tokens: number; costUsd: number }> = {};
    for (const state of nodeStatesRepository.listForRun(db, runId)) {
      byNode[state.nodeId] = { tokens: state.tokensUsed, costUsd: state.costUsed };
    }
    return { runId, tokens: run.tokens, costUsd: run.costUsd, byNode, hasUnpricedCalls };
  };

  return {
    record({ nodeId, roleId, model, usage, estimatedInputTokens, estimatedOutputTokens }) {
      const actualTokens = usage.inputTokens + usage.outputTokens;
      const capabilities = governor.capabilitiesOf(model);
      const actualCost = costOf(capabilities, usage.inputTokens, usage.outputTokens);
      if (actualCost === null) hasUnpricedCalls = true;

      // The ledger already holds the estimate. Only the difference is applied,
      // so the Governor's next decision is made against what the run has really
      // spent rather than against what it was forecast to spend.
      governor.reconcile(
        { nodeId, roleId },
        { model, estimatedInputTokens, estimatedOutputTokens, usage },
      );

      // Persisted additively: the checkpoint journal and this meter write
      // different columns of the same row, and an absolute write from either
      // would clobber the other.
      nodeStatesRepository.addSpend(db, runId, nodeId, actualTokens, actualCost ?? 0);
      runsRepository.addSpend(db, runId, actualTokens, actualCost ?? 0);

      const snapshot = read();
      options.onUpdate?.(snapshot);
      return snapshot;
    },

    snapshot: read,
  };
}
