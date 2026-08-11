import type Database from 'better-sqlite3';
import { runsRepository } from '@chimera/store';
import type { LoopResult } from './agentLoop.ts';

// Why a run ended, written where a person can read it afterwards.
//
// A run that halted because it ran out of money, one that halted because it was
// going in circles, and one that finished are three different outcomes. Storing
// them all as "failed" with no reason is how a user ends up guessing — so the
// status and the summary say which, and the denial code travels with it.

export type RunStatus = 'succeeded' | 'halted' | 'cancelled' | 'incomplete' | 'failed';

const HALT_REASONS: Record<string, string> = {
  GOVERNOR_BUDGET_EXCEEDED: 'Stopped: the run reached its spend cap.',
  GOVERNOR_STALLED: 'Stopped: the agent was repeating itself and making no progress.',
  GOVERNOR_DEPTH_EXCEEDED: 'Stopped: the workflow nested deeper than its declared limit.',
  GOVERNOR_STEP_LIMIT_EXCEEDED: 'Stopped: the run reached its step or time limit.',
  GOVERNOR_CAPABILITY_MISMATCH: 'Stopped: the bound model cannot do what this node needs.',
  GOVERNOR_TOOL_NOT_ALLOWED: 'Stopped: the agent tried to use a tool its role was not granted.',
  GOVERNOR_EGRESS_NOT_ALLOWED: 'Stopped: the agent tried to reach a host outside the allowlist.',
  GOVERNOR_APPROVAL_REQUIRED:
    'Stopped: this action needs a human approval that has not been given.',
};

export interface RunOutcome {
  status: RunStatus;
  summary: string | null;
  /** The Governor's code, when a limit was the cause. */
  code: string | null;
}

export function outcomeOf(result: LoopResult): RunOutcome {
  switch (result.status) {
    case 'succeeded':
      return { status: 'succeeded', summary: null, code: null };

    case 'cancelled':
      return { status: 'cancelled', summary: 'Cancelled before completion.', code: null };

    case 'exhausted':
      // Not a failure: the work done so far may still be worth something, and
      // the honest label is "not finished" rather than "broken".
      return {
        status: 'incomplete',
        summary: `Stopped: reached the iteration limit after ${String(result.iterations)} iterations without verifying the goal.`,
        code: null,
      };

    case 'denied': {
      const code = result.denial?.code ?? 'GOVERNOR_UNKNOWN';
      const reason = HALT_REASONS[code] ?? 'Stopped by the Governor.';
      return {
        status: 'halted',
        // The Governor's own message carries the numbers — which cap, how much
        // was spent — and is more use than the category alone.
        summary: `${reason} ${result.denial?.message ?? ''}`.trim(),
        code,
      };
    }
  }
}

/** Records the outcome on the run row. */
export function finalizeRun(db: Database.Database, runId: string, result: LoopResult): RunOutcome {
  const outcome = outcomeOf(result);
  runsRepository.finish(db, runId, outcome.status, outcome.summary);
  return outcome;
}
