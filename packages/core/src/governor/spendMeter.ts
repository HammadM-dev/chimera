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
  /**
   * What the same tokens would have cost on the frontier tier.
   *
   * The multi-provider argument, made in numbers rather than asserted: a run
   * that used a cheap model for a thousand fan-out workers and a frontier model
   * for the verification is dramatically cheaper than one that used the good
   * model throughout, and nobody believes that until they see both figures.
   *
   * Null when no frontier model is configured, or when its price is unknown —
   * an invented comparison is worse than no comparison.
   */
  frontierCostUsd: number | null;
}

export interface SpendMeterOptions {
  db: Database.Database;
  runId: string;
  governor: Governor;
  /** The model the workspace calls `frontier`, for the comparison figure. */
  frontierModel?: string;
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
    return {
      runId,
      tokens: run.tokens,
      costUsd: run.costUsd,
      byNode,
      hasUnpricedCalls,
      frontierCostUsd: run.frontierCostUsd,
    };
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
      // The comparison, accumulated per call rather than at the end: only here
      // is the input/output split known, and the two rates differ. Persisted
      // rather than held in memory, because a fan-out's items are nested runs
      // sharing this run's id, each with a meter of its own.
      if (options.frontierModel !== undefined && options.frontierModel !== '') {
        const frontier = costOf(
          governor.capabilitiesOf(options.frontierModel),
          usage.inputTokens,
          usage.outputTokens,
        );
        if (frontier !== null) runsRepository.addFrontierCost(db, runId, frontier);
      }

      nodeStatesRepository.addSpend(db, runId, nodeId, actualTokens, actualCost ?? 0, {
        roleId,
        model,
      });
      runsRepository.addSpend(db, runId, actualTokens, actualCost ?? 0);

      const snapshot = read();
      options.onUpdate?.(snapshot);
      return snapshot;
    },

    snapshot: read,
  };
}
