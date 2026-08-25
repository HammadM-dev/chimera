// A shared brake for one swarm's model calls.
//
// A swarm is the most request-dense thing this app does: one call per thinking
// persona per round, plus the cast and the report. Bounding how many go out at
// once was not enough on a free tier, because the limit that matters there is
// requests per minute, not requests in flight — six at a time, answered
// quickly, is still sixty a minute.
//
// So when the provider says to slow down, everything slows down. All workers
// wait on the same gate rather than each backing off privately and arriving
// together a moment later, and the concurrency they return to is lower than the
// one they left. The Governor's own rate limiter cannot do this job here: it
// only tracks connections it has a configured bucket for, and a swarm runs on a
// permissive Governor with no policy at all, so `recordRateLimit` was a no-op.

export class SwarmThrottle {
  /** Wall-clock time before which no call may go out. */
  private notBefore = 0;
  /** Earliest the next call may start, so calls are spaced as well as capped. */
  private nextSlot = 0;
  /** Enforced gap between calls. Grows each time a limit is met. */
  private spacingMs = 0;
  private permits: number;
  private readonly floor: number;
  private readonly maxSpacingMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: {
    /** Starting simultaneous calls. */
    permits: number;
    /** Never throttle below this, or a large swarm never finishes. */
    floor?: number;
    /** Ceiling on the enforced gap, so a bad patch cannot stall a run for good. */
    maxSpacingMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.permits = Math.max(1, options.permits);
    this.floor = Math.max(1, options.floor ?? 1);
    this.maxSpacingMs = options.maxSpacingMs ?? 4_000;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  /** How many calls may currently be in flight. Shrinks as limits are hit. */
  get concurrency(): number {
    return this.permits;
  }

  /**
   * Blocks until this call may go out.
   *
   * Two separate things. `notBefore` is quiet after a refusal, shared by
   * everyone. `nextSlot` is spacing: calls take their turn at least
   * `spacingMs` apart, which is the part that actually prevents the next
   * refusal rather than reacting to it.
   *
   * Measured against OpenRouter's free tier, which is what made spacing
   * necessary: it returns 429 with no `Retry-After` and no rate-limit headers,
   * and it does so at a concurrency of one — a request issued immediately
   * after a successful one is refused. Concurrency alone cannot fix that.
   */
  async wait(): Promise<void> {
    const slot = Math.max(this.now(), this.nextSlot);
    this.nextSlot = slot + this.spacingMs;

    for (;;) {
      const until = Math.max(this.notBefore, slot);
      const remaining = until - this.now();
      if (remaining <= 0) return;
      await this.sleep(remaining);
    }
  }

  /**
   * The provider rate-limited us.
   *
   * Honours `Retry-After` when there is one — the provider knows its own limits
   * better than any default here — and otherwise waits a beat. Concurrency
   * halves each time, down to the floor: a limit hit twice is a signal that the
   * current rate is wrong, not that this particular call was unlucky.
   */
  penalise(retryAfterMs?: number): void {
    const wait = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : 1_500;
    this.notBefore = Math.max(this.notBefore, this.now() + wait);
    this.permits = Math.max(this.floor, Math.floor(this.permits / 2));

    // And leave a gap from here on. Halving concurrency stops a burst; spacing
    // is what stops the steady trickle that a strict per-minute limit refuses
    // just as readily.
    this.spacingMs = Math.min(this.maxSpacingMs, this.spacingMs === 0 ? 400 : this.spacingMs * 2);
  }
}
