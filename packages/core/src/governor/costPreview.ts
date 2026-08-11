import { capabilityMatrix, type ModelCapabilities } from '@chimera/providers';
import { costOf } from './budget.ts';

// F4.4's cost preview: what this run will cost, before it starts.
//
// The master plan's own illustration is "1000 items, 14.2M tokens est, $34.10
// est, 22 min est". The figure only earns that place on screen if it comes from
// the models actually bound to the nodes — a preview computed from a constant
// would be a number that looks authoritative and predicts nothing.

export interface PreviewNode {
  id: string;
  /** The model this node is bound to. Its price comes from the capability matrix. */
  model: string;
  /** The node's declared iteration cap. Every node has one — CLAUDE.md forbids unbounded loops. */
  maxIterations: number;
  expectedInputTokensPerIteration: number;
  expectedOutputTokensPerIteration: number;
  /**
   * The node's declared budget, if it has one.
   *
   * Used as a ceiling: a node cannot spend more than it is allowed to, so an
   * estimate above its own cap is an estimate of something that cannot happen.
   */
  budget?: { maxTokens: number | null; maxCostUsd: number | null };
  /** Wall-clock per iteration. Defaults below; a measured figure is better. */
  expectedMsPerIteration?: number;
}

export interface PreviewWorkflow {
  nodes: readonly PreviewNode[];
}

export interface PreviewOptions {
  /** Items to process — the fan-out count. One for a single-agent run. */
  itemCount?: number;
  /** How many items run at once. Fan-out itself is M5; the arithmetic is here. */
  concurrency?: number;
  /** Injected for tests and for the mock provider's synthetic models. */
  capabilitiesFor?: (model: string) => ModelCapabilities;
}

export interface NodePreview {
  nodeId: string;
  model: string;
  tokens: number;
  /** Null when the bound model has no verified price. */
  costUsd: number | null;
  estimatedMs: number;
  /** True when the node's own declared budget, not the iteration count, set the figure. */
  cappedByBudget: boolean;
}

export interface CostPreview {
  itemCount: number;
  totalTokens: number;
  /**
   * Total in USD, or null when any bound model is unpriced.
   *
   * Null rather than a partial total presented as the whole: a figure that
   * silently omitted three of a workflow's nodes would be worse than no figure,
   * because the user would budget against it. `pricedCostUsd` carries the part
   * that *is* known, and `unpricedModels` says what is missing.
   */
  totalCostUsd: number | null;
  pricedCostUsd: number;
  unpricedModels: string[];
  estimatedMs: number;
  perNode: NodePreview[];
}

/** Used when a node does not declare one. A round number, and openly a guess. */
export const DEFAULT_MS_PER_ITERATION = 4_000;

export function estimate(workflow: PreviewWorkflow, options: PreviewOptions = {}): CostPreview {
  const itemCount = Math.max(1, options.itemCount ?? 1);
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const capabilitiesFor = options.capabilitiesFor ?? ((model) => capabilityMatrix.get(model));

  const perNode: NodePreview[] = workflow.nodes.map((node) => {
    const capabilities = capabilitiesFor(node.model);

    const inputTokens = node.expectedInputTokensPerIteration * node.maxIterations;
    const outputTokens = node.expectedOutputTokensPerIteration * node.maxIterations;
    let tokens = inputTokens + outputTokens;
    let cappedByBudget = false;

    const budgetTokens = node.budget?.maxTokens ?? null;
    if (budgetTokens !== null && tokens > budgetTokens) {
      tokens = budgetTokens;
      cappedByBudget = true;
    }

    // The split is preserved when scaling to the cap, because input and output
    // are priced differently and a 50/50 assumption would misprice every node
    // whose real ratio is not 50/50.
    const ratio = inputTokens + outputTokens === 0 ? 0 : inputTokens / (inputTokens + outputTokens);
    const cost = costOf(capabilities, tokens * ratio, tokens * (1 - ratio));

    return {
      nodeId: node.id,
      model: node.model,
      tokens,
      costUsd: cost,
      estimatedMs: (node.expectedMsPerIteration ?? DEFAULT_MS_PER_ITERATION) * node.maxIterations,
      cappedByBudget,
    };
  });

  const scaled = perNode.map((node) => ({
    ...node,
    tokens: node.tokens * itemCount,
    costUsd: node.costUsd === null ? null : node.costUsd * itemCount,
    estimatedMs: (node.estimatedMs * itemCount) / concurrency,
  }));

  const unpricedModels = [
    ...new Set(scaled.filter((node) => node.costUsd === null).map((node) => node.model)),
  ];
  const pricedCostUsd = scaled.reduce((total, node) => total + (node.costUsd ?? 0), 0);

  return {
    itemCount,
    totalTokens: scaled.reduce((total, node) => total + node.tokens, 0),
    totalCostUsd: unpricedModels.length > 0 ? null : pricedCostUsd,
    pricedCostUsd,
    unpricedModels,
    // Nodes run in sequence within one item; items run `concurrency` at a time.
    estimatedMs: scaled.reduce((total, node) => total + node.estimatedMs, 0),
    perNode: scaled,
  };
}

/** The preview as the master plan illustrates it, for the status bar. */
export function describePreview(preview: CostPreview): string {
  const tokens =
    preview.totalTokens >= 1_000_000
      ? `${(preview.totalTokens / 1_000_000).toFixed(1)}M tokens est`
      : `${String(Math.round(preview.totalTokens / 1_000))}K tokens est`;

  const cost =
    preview.totalCostUsd === null
      ? `cost unknown for ${String(preview.unpricedModels.length)} model(s)`
      : `$${preview.totalCostUsd.toFixed(2)} est`;

  const minutes = Math.max(1, Math.round(preview.estimatedMs / 60_000));
  return `${String(preview.itemCount)} items, ${tokens}, ${cost}, ${String(minutes)} min est`;
}
