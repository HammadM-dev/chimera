import { nodeStatesRepository, workflowsRepository } from '@chimera/store';
import { getStore } from '../store/lifecycle.ts';

// M9-4. What this workspace has spent, and on what.
//
// The master plan's economic argument is that a mixed fleet is cheaper than one
// good model everywhere. That argument is only worth making if a user can see
// it, and "see it" means four questions: which automation, which agent, which
// model, and which day.

export interface CostSlice {
  key: string;
  label: string;
  costUsd: number;
  tokens: number;
  runs: number;
}

export interface CostSummary {
  sinceIso: string;
  totalCostUsd: number;
  totalTokens: number;
  runCount: number;
  byAutomation: CostSlice[];
  byAgent: CostSlice[];
  byModel: CostSlice[];
  byDay: CostSlice[];
}

function accumulate(
  into: Map<string, CostSlice>,
  key: string,
  label: string,
  costUsd: number,
  tokens: number,
  runId: string,
  seen: Map<string, Set<string>>,
): void {
  const slice = into.get(key) ?? { key, label, costUsd: 0, tokens: 0, runs: 0 };
  slice.costUsd += costUsd;
  slice.tokens += tokens;

  // Runs counted once per slice, not once per node: an automation with twelve
  // steps is one run, and a column that said twelve would make every figure
  // beside it look wrong.
  const runsForKey = seen.get(key) ?? new Set<string>();
  if (!runsForKey.has(runId)) {
    runsForKey.add(runId);
    slice.runs += 1;
    seen.set(key, runsForKey);
  }

  into.set(key, slice);
}

const ranked = (slices: Map<string, CostSlice>): CostSlice[] =>
  [...slices.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);

/**
 * Spend over a window, sliced four ways.
 *
 * Read from `node_states` joined to `runs` in one query. The alternative —
 * walking every run's trace — is accurate in exactly the same way and takes
 * seconds on a workspace with a year of history.
 */
export function costSummary(days = 30): CostSummary {
  const db = getStore();
  const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60_000);
  const sinceIso = since.toISOString();

  const rows = nodeStatesRepository.spendSince(db, sinceIso);
  const workflowNames = new Map(
    workflowsRepository.list(db).map((workflow) => [workflow.id, workflow.name]),
  );

  const byAutomation = new Map<string, CostSlice>();
  const byAgent = new Map<string, CostSlice>();
  const byModel = new Map<string, CostSlice>();
  const byDay = new Map<string, CostSlice>();
  const seen = { automation: new Map(), agent: new Map(), model: new Map(), day: new Map() };

  let totalCostUsd = 0;
  let totalTokens = 0;
  const runIds = new Set<string>();

  for (const row of rows) {
    totalCostUsd += row.costUsed;
    totalTokens += row.tokensUsed;
    runIds.add(row.runId);

    // An ad-hoc run from an unsaved canvas has no workflow row, so it is named
    // from the brief it ran — which is what the user typed and recognises.
    let name = workflowNames.get(row.workflowId) ?? '';
    if (name === '' || name === 'Ad-hoc agent runs') {
      try {
        name = (JSON.parse(row.inputJson) as { name?: string }).name ?? 'Untitled';
      } catch {
        name = 'Untitled';
      }
    }

    accumulate(byAutomation, name, name, row.costUsed, row.tokensUsed, row.runId, seen.automation);
    accumulate(
      byAgent,
      row.roleId ?? 'unattributed',
      row.roleId ?? 'Before this was recorded',
      row.costUsed,
      row.tokensUsed,
      row.runId,
      seen.agent,
    );
    accumulate(
      byModel,
      row.model ?? 'unattributed',
      row.model ?? 'Before this was recorded',
      row.costUsed,
      row.tokensUsed,
      row.runId,
      seen.model,
    );

    const day = row.startedAt.slice(0, 10);
    accumulate(byDay, day, day, row.costUsed, row.tokensUsed, row.runId, seen.day);
  }

  return {
    sinceIso,
    totalCostUsd,
    totalTokens,
    runCount: runIds.size,
    byAutomation: ranked(byAutomation),
    byAgent: ranked(byAgent),
    byModel: ranked(byModel),
    // Chronological rather than ranked: a day column sorted by spend is a
    // chart nobody can read.
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}
