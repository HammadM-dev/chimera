import type { ModelCapabilities, Pricing } from '@chimera/providers';

// F4.1's budget accounting: what a run, a node, and a role are each permitted
// to spend, and what they have spent so far.
//
// The Governor only ever *reads* limits — they are declared by the workflow and
// by the role, never inferred here. A budget this file invented would be a
// number the user never agreed to, enforced as if they had.

export interface BudgetLimit {
  /** Null means "no cap at this scope", which is different from a cap of zero. */
  maxTokens: number | null;
  maxCostUsd: number | null;
}

export interface BudgetPolicy {
  /** The whole run. */
  run?: BudgetLimit;
  /** Per node id. A node absent from this map has no node-level cap. */
  perNode?: Readonly<Record<string, BudgetLimit>>;
  /** Per role id, from the role registry's `RoleBudget`. */
  perRole?: Readonly<Record<string, BudgetLimit>>;
}

export interface Consumption {
  tokens: number;
  costUsd: number;
}

export interface BudgetScope {
  scope: 'run' | 'node' | 'role';
  /** The node or role this applies to; the run scope has no id. */
  id: string | null;
  limit: BudgetLimit;
  spent: Consumption;
}

export interface BudgetBreach {
  scope: BudgetScope['scope'];
  id: string | null;
  /** Which of the two caps was hit. */
  measure: 'tokens' | 'cost';
  limit: number;
  spent: number;
  wouldReach: number;
}

const ZERO: Consumption = { tokens: 0, costUsd: 0 };

/**
 * Cost of a call, from the capability matrix.
 *
 * Returns null when the model has no verified price. That is deliberately not
 * zero: a budget that treated an unpriced model as free would let an unmetered
 * run past a cost cap, which is the one arithmetic mistake here with a bill
 * attached. Callers treat null as "cannot enforce a cost cap for this call" and
 * fall back to the token cap, which is always knowable.
 */
export function costOf(
  capabilities: ModelCapabilities,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing: Pricing = capabilities.pricing;
  if (pricing.kind === 'local') return 0;
  if (pricing.kind !== 'metered') return null;
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

/**
 * Tracks spend against the declared caps.
 *
 * Charges are committed *before* the call is dispatched, against the estimate.
 * Two reasons. The obvious one is that a cap enforced after the fact is not a
 * cap. The subtler one is that a run making concurrent calls (M5's swarm) would
 * otherwise authorise several calls that are individually inside the budget and
 * collectively outside it. M3-4 reconciles the estimate against the provider's
 * reported usage once the call returns.
 */
export class BudgetLedger {
  private readonly policy: BudgetPolicy;
  private readonly spent = new Map<string, Consumption>();

  constructor(policy: BudgetPolicy = {}) {
    this.policy = policy;
  }

  private key(scope: BudgetScope['scope'], id: string | null): string {
    return `${scope}:${id ?? ''}`;
  }

  private limitFor(scope: BudgetScope['scope'], id: string | null): BudgetLimit | undefined {
    if (scope === 'run') return this.policy.run;
    if (id === null) return undefined;
    return scope === 'node' ? this.policy.perNode?.[id] : this.policy.perRole?.[id];
  }

  spendAt(scope: BudgetScope['scope'], id: string | null): Consumption {
    return this.spent.get(this.key(scope, id)) ?? ZERO;
  }

  /**
   * The first cap this consumption would breach, or null.
   *
   * Scopes are checked run, then node, then role — narrowest last, so the
   * reported breach is the most specific one that is actually the problem when
   * several are tight at once. A caller reading "the node cap" learns more than
   * one reading "some cap".
   */
  wouldBreach(
    context: { nodeId: string; roleId: string },
    consumption: { tokens: number; costUsd: number | null },
  ): BudgetBreach | null {
    const scopes: [BudgetScope['scope'], string | null][] = [
      ['run', null],
      ['node', context.nodeId],
      ['role', context.roleId],
    ];

    for (const [scope, id] of scopes) {
      const limit = this.limitFor(scope, id);
      if (!limit) continue;
      const spent = this.spendAt(scope, id);

      if (limit.maxTokens !== null) {
        const wouldReach = spent.tokens + consumption.tokens;
        if (wouldReach > limit.maxTokens) {
          return {
            scope,
            id,
            measure: 'tokens',
            limit: limit.maxTokens,
            spent: spent.tokens,
            wouldReach,
          };
        }
      }

      // An unpriced model cannot be checked against a cost cap. Skipped rather
      // than treated as free — see `costOf`. The token cap still applies, and a
      // workspace that cares about money should set one.
      if (limit.maxCostUsd !== null && consumption.costUsd !== null) {
        const wouldReach = spent.costUsd + consumption.costUsd;
        if (wouldReach > limit.maxCostUsd) {
          return {
            scope,
            id,
            measure: 'cost',
            limit: limit.maxCostUsd,
            spent: spent.costUsd,
            wouldReach,
          };
        }
      }
    }

    return null;
  }

  /** Commits consumption to every scope. Called only after `wouldBreach` returned null. */
  charge(
    context: { nodeId: string; roleId: string },
    consumption: { tokens: number; costUsd: number | null },
  ): void {
    const scopes: [BudgetScope['scope'], string | null][] = [
      ['run', null],
      ['node', context.nodeId],
      ['role', context.roleId],
    ];
    for (const [scope, id] of scopes) {
      const key = this.key(scope, id);
      const current = this.spent.get(key) ?? ZERO;
      this.spent.set(key, {
        tokens: current.tokens + consumption.tokens,
        costUsd: current.costUsd + (consumption.costUsd ?? 0),
      });
    }
  }

  /** Everything spent so far, for the meter (M3-4) and the trace. */
  snapshot(): {
    run: Consumption;
    byNode: Record<string, Consumption>;
    byRole: Record<string, Consumption>;
  } {
    const byNode: Record<string, Consumption> = {};
    const byRole: Record<string, Consumption> = {};
    for (const [key, value] of this.spent) {
      const [scope, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      if (scope === 'node') byNode[id] = value;
      if (scope === 'role') byRole[id] = value;
    }
    return { run: this.spendAt('run', null), byNode, byRole };
  }
}
