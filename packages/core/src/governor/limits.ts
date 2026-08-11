// F4.2's structural limits: how deep, how many steps, how long.
//
// Separate from budget.ts because these are not about money. A run can be well
// inside its spend cap and still be recursing forever, and the two failures
// need different answers — "you have spent enough" and "this is not going to
// finish" are different things to tell a user.

export interface LimitPolicy {
  /** Subworkflow and agent-in-agent nesting. Null means no cap at this level. */
  maxDepth: number | null;
  /** Total authorised calls in this run, across every node. */
  maxSteps: number | null;
  /** Wall-clock from the run's start. */
  maxWallClockMs: number | null;
}

export const NO_LIMITS: LimitPolicy = { maxDepth: null, maxSteps: null, maxWallClockMs: null };

export type LimitKind = 'depth' | 'steps' | 'wallClock';

export interface LimitBreach {
  kind: LimitKind;
  limit: number;
  actual: number;
}

/**
 * Counts steps and elapsed time for one run.
 *
 * The clock is injected. A wall-clock limit tested against the real clock is a
 * test that either sleeps for its duration or is flaky, and neither is a test
 * anybody keeps.
 */
export class LimitTracker {
  private readonly policy: LimitPolicy;
  private readonly now: () => number;
  private readonly startedAt: number;
  private steps = 0;

  constructor(policy: LimitPolicy = NO_LIMITS, now: () => number = () => Date.now()) {
    this.policy = policy;
    this.now = now;
    this.startedAt = now();
  }

  get stepCount(): number {
    return this.steps;
  }

  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /**
   * The first limit this call would breach, or null.
   *
   * Depth is checked against the call's own declared depth; steps against the
   * count *including* this one, because a limit of ten steps means ten calls
   * happen, not eleven.
   */
  wouldBreach(depth: number): LimitBreach | null {
    if (this.policy.maxDepth !== null && depth > this.policy.maxDepth) {
      return { kind: 'depth', limit: this.policy.maxDepth, actual: depth };
    }
    if (this.policy.maxSteps !== null && this.steps + 1 > this.policy.maxSteps) {
      return { kind: 'steps', limit: this.policy.maxSteps, actual: this.steps + 1 };
    }
    if (this.policy.maxWallClockMs !== null) {
      const elapsed = this.elapsedMs();
      if (elapsed > this.policy.maxWallClockMs) {
        return { kind: 'wallClock', limit: this.policy.maxWallClockMs, actual: elapsed };
      }
    }
    return null;
  }

  /** Records one authorised call. Only after `wouldBreach` returned null. */
  countStep(): void {
    this.steps += 1;
  }
}
