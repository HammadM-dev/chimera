// F4.6's rate-limit governor: token buckets per connection, exponential
// backoff with jitter, and spillover to the next connection in the chain.
//
// The point is not to avoid ever being rate-limited — a provider's limits are
// its own and change without notice. The point is that being rate-limited costs
// a bounded, jittered wait rather than a tight retry loop that makes the
// provider's problem worse and CHIMERA's bill larger.

export interface BucketPolicy {
  /** Requests the bucket holds when full. */
  capacity: number;
  /** Requests added back per second. */
  refillPerSecond: number;
}

export interface RateLimitPolicy {
  /** Per connection id. A connection absent from this map is unlimited. */
  perConnection?: Readonly<Record<string, BucketPolicy>>;
  /**
   * Ordered fallbacks per connection id.
   *
   * When the primary has no headroom, the Governor rewrites the request to the
   * first connection in this chain that does. Declared by the workflow, never
   * inferred: spilling a run onto a connection the user did not nominate could
   * send their data to a provider they deliberately excluded.
   */
  spillover?: Readonly<Record<string, readonly string[]>>;
  /** Retries after a provider's own 429 before the error is surfaced. */
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export const DEFAULT_RATE_POLICY: Required<
  Pick<RateLimitPolicy, 'maxRetries' | 'baseBackoffMs' | 'maxBackoffMs'>
> = {
  maxRetries: 4,
  baseBackoffMs: 500,
  maxBackoffMs: 30_000,
};

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter — a uniform draw from `[0, exponential)` rather than
 * `exponential ± a bit` — because the failure mode this exists to prevent is
 * synchronised retries. Several workers rate-limited by the same provider at
 * the same moment will otherwise all wait the same interval and hit it together
 * again, which is the thundering herd the backoff was supposed to break up.
 *
 * `random` is injected so the growth and the spread are both testable; a test
 * against `Math.random` can only assert that the numbers differ.
 */
export function backoffDelayMs(
  attempt: number,
  policy: { baseBackoffMs: number; maxBackoffMs: number },
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** attempt);
  return Math.round(random() * ceiling);
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface RateVerdict {
  /** The connection to use — the requested one, or a spillover target. */
  connectionId: string;
  /** True when the request was moved off its primary. */
  spilledOver: boolean;
  /** Set when nothing had headroom: how long until the primary has some. */
  retryAfterMs?: number;
}

/**
 * Token buckets per connection.
 *
 * The clock is injected for the same reason the wall-clock limit's is: a rate
 * limiter tested against the real clock either sleeps through its own test or
 * is flaky.
 */
export class RateLimiter {
  private readonly policy: RateLimitPolicy;
  private readonly now: () => number;
  private readonly buckets = new Map<string, BucketState>();

  constructor(policy: RateLimitPolicy = {}, now: () => number = () => Date.now()) {
    this.policy = policy;
    this.now = now;
  }

  private bucketFor(connectionId: string): { state: BucketState; policy: BucketPolicy } | null {
    const bucketPolicy = this.policy.perConnection?.[connectionId];
    if (!bucketPolicy) return null;

    let state = this.buckets.get(connectionId);
    if (!state) {
      state = { tokens: bucketPolicy.capacity, lastRefillMs: this.now() };
      this.buckets.set(connectionId, state);
    }

    const elapsedMs = this.now() - state.lastRefillMs;
    if (elapsedMs > 0) {
      state.tokens = Math.min(
        bucketPolicy.capacity,
        state.tokens + (elapsedMs / 1000) * bucketPolicy.refillPerSecond,
      );
      state.lastRefillMs = this.now();
    }
    return { state, policy: bucketPolicy };
  }

  /** Headroom on a connection, without consuming any. */
  hasHeadroom(connectionId: string): boolean {
    const bucket = this.bucketFor(connectionId);
    return bucket === null || bucket.state.tokens >= 1;
  }

  private msUntilHeadroom(connectionId: string): number {
    const bucket = this.bucketFor(connectionId);
    if (bucket === null || bucket.state.tokens >= 1) return 0;
    const missing = 1 - bucket.state.tokens;
    return Math.ceil((missing / bucket.policy.refillPerSecond) * 1000);
  }

  /**
   * Takes one request's worth of headroom, spilling over if it has to.
   *
   * Consumes from whichever connection it settles on, so the caller cannot
   * "check then use" a connection that a concurrent caller has since drained.
   */
  consume(connectionId: string): RateVerdict {
    const primary = this.bucketFor(connectionId);
    if (primary === null || primary.state.tokens >= 1) {
      if (primary !== null) primary.state.tokens -= 1;
      return { connectionId, spilledOver: false };
    }

    for (const fallback of this.policy.spillover?.[connectionId] ?? []) {
      const candidate = this.bucketFor(fallback);
      if (candidate === null || candidate.state.tokens >= 1) {
        if (candidate !== null) candidate.state.tokens -= 1;
        return { connectionId: fallback, spilledOver: true };
      }
    }

    return {
      connectionId,
      spilledOver: false,
      retryAfterMs: this.msUntilHeadroom(connectionId),
    };
  }

  /**
   * Records that the provider itself rate-limited us.
   *
   * Empties the bucket: the provider's answer is more authoritative than our
   * model of its limits, and continuing to send because our own accounting says
   * there is headroom is how a soft limit becomes a hard block.
   */
  penalise(connectionId: string, retryAfterMs?: number): void {
    const bucket = this.bucketFor(connectionId);
    if (bucket === null) return;
    bucket.state.tokens = 0;
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      // Push the refill clock forward so the bucket stays empty for as long as
      // the provider asked, rather than refilling on our own schedule.
      bucket.state.lastRefillMs = this.now() + retryAfterMs;
    }
  }

  get retryPolicy(): { maxRetries: number; baseBackoffMs: number; maxBackoffMs: number } {
    return {
      maxRetries: this.policy.maxRetries ?? DEFAULT_RATE_POLICY.maxRetries,
      baseBackoffMs: this.policy.baseBackoffMs ?? DEFAULT_RATE_POLICY.baseBackoffMs,
      maxBackoffMs: this.policy.maxBackoffMs ?? DEFAULT_RATE_POLICY.maxBackoffMs,
    };
  }
}
