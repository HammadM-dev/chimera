import type Database from 'better-sqlite3';
import { connectionsRepository } from '@chimera/store';
import type { ProviderAdapter } from './adapter.ts';
import type { AdapterCallOptions } from './adapter.ts';
import type { HealthState } from './registry.ts';

// F1.6: per-connection health tracking with a circuit breaker. The breaker
// itself is a pure state machine with no timers and no I/O, so its behaviour is
// asserted directly rather than inferred from a probe schedule — a breaker
// tested only through a live poller is a breaker whose edge cases are untested.

export interface BreakerConfig {
  /** Consecutive failures before the connection is taken out of service. */
  failureThreshold: number;
  /** Consecutive successes before it is put back. */
  successThreshold: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { failureThreshold: 3, successThreshold: 2 };

/**
 * Consecutive-outcome circuit breaker.
 *
 * `degraded` is a real state, not decoration: one failed probe on an otherwise
 * healthy connection is usually a blip, and showing it as `unavailable`
 * immediately would train the user to ignore the indicator. It shows something
 * is wrong without claiming the connection is out of service.
 */
export class CircuitBreaker {
  private readonly config: BreakerConfig;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private current: HealthState = 'unknown';

  constructor(config: BreakerConfig = DEFAULT_BREAKER) {
    this.config = config;
  }

  get state(): HealthState {
    return this.current;
  }

  /** Feeds one probe outcome in and returns the resulting state. */
  record(ok: boolean): HealthState {
    if (ok) {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses += 1;
      // A connection already in service stays in service — the success
      // threshold gates *recovery*, not steady-state operation.
      if (
        this.current !== 'unavailable' ||
        this.consecutiveSuccesses >= this.config.successThreshold
      ) {
        this.current = 'healthy';
      }
      return this.current;
    }

    this.consecutiveSuccesses = 0;
    this.consecutiveFailures += 1;
    this.current =
      this.consecutiveFailures >= this.config.failureThreshold ? 'unavailable' : 'degraded';
    return this.current;
  }

  /** Restores a persisted state without replaying its probe history. */
  restore(state: HealthState): void {
    this.current = state;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
  }
}

/**
 * An adapter that manages its own health and should be believed rather than
 * second-guessed.
 *
 * F1.6: "OmniRoute already does this well — when it's the active connection,
 * defer to it rather than double-managing." Expressed as an optional capability
 * on the adapter rather than a `kind === 'omniroute'` check anywhere, so the
 * monitor never learns a provider's name — the same rule that keeps provider
 * differences inside adapters.
 */
export interface SelfReportingAdapter {
  reportedHealth(options: AdapterCallOptions): Promise<HealthState>;
}

export function reportsOwnHealth(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & SelfReportingAdapter {
  return typeof (adapter as Partial<SelfReportingAdapter>).reportedHealth === 'function';
}

export interface ProbeResult {
  connectionId: string;
  state: HealthState;
  /** True when the state came from the provider rather than from the breaker. */
  selfReported: boolean;
}

/**
 * Runs one health probe for one connection and persists the result.
 *
 * A self-reporting adapter's answer is written through unchanged and its
 * breaker is realigned to match, so a later switch to CHIMERA-side probing
 * does not start from a stale count.
 */
export async function probeOnce(
  db: Database.Database,
  connectionId: string,
  adapter: ProviderAdapter,
  breaker: CircuitBreaker,
  options: AdapterCallOptions,
): Promise<ProbeResult> {
  let state: HealthState;
  let selfReported = false;

  if (reportsOwnHealth(adapter)) {
    try {
      state = await adapter.reportedHealth(options);
      selfReported = true;
      breaker.restore(state);
    } catch {
      // If the provider cannot even tell us how it is, that is itself a failed
      // probe — fall through to the breaker rather than reporting 'unknown'
      // and leaving a dead connection looking merely uninspected.
      state = breaker.record(false);
    }
  } else {
    const result = await adapter.testConnection(options);
    state = breaker.record(result.ok);
  }

  connectionsRepository.updateHealth(db, connectionId, state);
  return { connectionId, state, selfReported };
}

export interface MonitoredConnection {
  connectionId: string;
  adapter: ProviderAdapter;
  options: AdapterCallOptions;
}

/**
 * Tracks a breaker per connection and probes them on demand.
 *
 * Deliberately has no timer of its own: the caller decides when to run a
 * sweep. A monitor that owned a `setInterval` would be untestable without
 * fake clocks and would keep an Electron main process awake between runs.
 */
export class HealthMonitor {
  private readonly db: Database.Database;
  private readonly config: BreakerConfig;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(db: Database.Database, config: BreakerConfig = DEFAULT_BREAKER) {
    this.db = db;
    this.config = config;
  }

  private breakerFor(connectionId: string): CircuitBreaker {
    let breaker = this.breakers.get(connectionId);
    if (!breaker) {
      breaker = new CircuitBreaker(this.config);
      this.breakers.set(connectionId, breaker);
    }
    return breaker;
  }

  stateOf(connectionId: string): HealthState {
    return this.breakers.get(connectionId)?.state ?? 'unknown';
  }

  probe(connection: MonitoredConnection): Promise<ProbeResult> {
    return probeOnce(
      this.db,
      connection.connectionId,
      connection.adapter,
      this.breakerFor(connection.connectionId),
      connection.options,
    );
  }

  /**
   * Probes every connection, concurrently.
   *
   * `allSettled`, not `all`: one unreachable provider must not prevent the
   * others from being probed, which is exactly the situation health monitoring
   * exists for.
   */
  async sweep(connections: readonly MonitoredConnection[]): Promise<ProbeResult[]> {
    const settled = await Promise.allSettled(connections.map((c) => this.probe(c)));
    return settled
      .filter((r): r is PromiseFulfilledResult<ProbeResult> => r.status === 'fulfilled')
      .map((r) => r.value);
  }
}
