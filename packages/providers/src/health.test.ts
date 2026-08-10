import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, connectionsRepository, type AuthRef } from '@chimera/store';
import { CircuitBreaker, HealthMonitor, DEFAULT_BREAKER } from './health.ts';
import { OmniRouteAdapter } from './adapters/omniroute.ts';
import type { AdapterDependencies } from './adapters/http.ts';
import type { ProviderAdapter } from './adapter.ts';
import type { ConnectionTestResult, ModelDescriptor } from './normalised.ts';

const migrationsDir = path.join(import.meta.dirname, '..', '..', 'store', 'src', 'migrations');
const HANDLE = 'vault:connection:11111111-2222-3333-4444-555555555555' as AuthRef;
const OPTIONS = { authRef: HANDLE };

function withDb(fn: (db: Database.Database) => void | Promise<void>): Promise<void> | void {
  const dir = mkdtempSync(path.join(tmpdir(), 'chimera-health-test-'));
  const db = openDatabase({ dbPath: path.join(dir, 'chimera.sqlite'), migrationsDir });
  const cleanup = (): void => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn(db);
    if (result instanceof Promise) return result.finally(cleanup);
    cleanup();
    return undefined;
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Minimal adapter whose probe outcome the test controls. */
class ScriptedAdapter implements ProviderAdapter {
  readonly kind = 'openai' as const;
  ok = true;
  probes = 0;

  chat(): never {
    throw new Error('not used');
  }
  streamChat(): never {
    throw new Error('not used');
  }
  listModels(): Promise<ModelDescriptor[]> {
    return Promise.resolve([]);
  }
  testConnection(): Promise<ConnectionTestResult> {
    this.probes += 1;
    return Promise.resolve({ ok: this.ok, latencyMs: 1 });
  }
}

// ------------------------------------------------------------ breaker, pure

test('three consecutive failures take a connection out of service', () => {
  const breaker = new CircuitBreaker(DEFAULT_BREAKER);
  assert.equal(breaker.record(false), 'degraded');
  assert.equal(breaker.record(false), 'degraded');
  // The third crosses the threshold — the first two are blips, and reporting
  // them as unavailable would train the user to ignore the indicator.
  assert.equal(breaker.record(false), 'unavailable');
});

test('recovery needs two consecutive successes, and one is not enough', () => {
  const breaker = new CircuitBreaker(DEFAULT_BREAKER);
  for (let i = 0; i < 3; i += 1) breaker.record(false);
  assert.equal(breaker.state, 'unavailable');

  assert.equal(breaker.record(true), 'unavailable', 'one success must not reinstate it');
  assert.equal(breaker.record(true), 'healthy');
});

test('a single success mid-degradation clears the failure count', () => {
  const breaker = new CircuitBreaker(DEFAULT_BREAKER);
  breaker.record(false);
  breaker.record(false);
  // A healthy connection is not held hostage by the recovery threshold — that
  // gates coming back from unavailable, not staying in service.
  assert.equal(breaker.record(true), 'healthy');
  assert.equal(breaker.record(false), 'degraded', 'the counter restarted');
});

test('thresholds are configurable', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, successThreshold: 1 });
  assert.equal(breaker.record(false), 'unavailable');
  assert.equal(breaker.record(true), 'healthy');
});

// ------------------------------------------------------ monitor + repository

test('a failing connection reaches unavailable in the connections table', async () => {
  await withDb(async (db) => {
    const created = connectionsRepository.create(db, {
      label: 'Flaky',
      kind: 'openai',
      authRef: HANDLE,
    });
    const adapter = new ScriptedAdapter();
    adapter.ok = false;
    const monitor = new HealthMonitor(db);
    const connection = { connectionId: created.id, adapter, options: OPTIONS };

    await monitor.probe(connection);
    assert.equal(connectionsRepository.get(db, created.id)?.healthState, 'degraded');
    await monitor.probe(connection);
    await monitor.probe(connection);

    // The criterion is about what the repository holds, not what the monitor
    // remembers — the UI reads the table.
    assert.equal(connectionsRepository.get(db, created.id)?.healthState, 'unavailable');
  });
});

test('a recovered connection returns to healthy in the table after two successes', async () => {
  await withDb(async (db) => {
    const created = connectionsRepository.create(db, {
      label: 'Recovering',
      kind: 'openai',
      authRef: HANDLE,
    });
    const adapter = new ScriptedAdapter();
    const monitor = new HealthMonitor(db);
    const connection = { connectionId: created.id, adapter, options: OPTIONS };

    adapter.ok = false;
    for (let i = 0; i < 3; i += 1) await monitor.probe(connection);
    assert.equal(connectionsRepository.get(db, created.id)?.healthState, 'unavailable');

    adapter.ok = true;
    await monitor.probe(connection);
    assert.equal(connectionsRepository.get(db, created.id)?.healthState, 'unavailable');
    await monitor.probe(connection);
    assert.equal(connectionsRepository.get(db, created.id)?.healthState, 'healthy');
  });
});

test('a sweep probes every connection even when one throws', async () => {
  await withDb(async (db) => {
    const good = connectionsRepository.create(db, {
      label: 'Good',
      kind: 'openai',
      authRef: HANDLE,
    });
    const bad = connectionsRepository.create(db, {
      label: 'Explodes',
      kind: 'openai',
      authRef: HANDLE,
    });

    const exploding: ProviderAdapter = {
      kind: 'openai',
      chat: () => Promise.reject(new Error('x')),
      streamChat: () => {
        throw new Error('x');
      },
      listModels: () => Promise.resolve([]),
      testConnection: () => Promise.reject(new Error('probe blew up')),
    };

    const monitor = new HealthMonitor(db);
    const results = await monitor.sweep([
      { connectionId: bad.id, adapter: exploding, options: OPTIONS },
      { connectionId: good.id, adapter: new ScriptedAdapter(), options: OPTIONS },
    ]);

    // One unreachable provider must not stop the others being probed — which
    // is precisely the situation health monitoring exists for.
    assert.equal(results.length, 1);
    assert.equal(results[0]?.connectionId, good.id);
    assert.equal(connectionsRepository.get(db, good.id)?.healthState, 'healthy');
  });
});

// -------------------------------------------------- OmniRoute pass-through

function omniRouteDeps(handler: (url: string) => Response): AdapterDependencies {
  return {
    resolveSecret: () => undefined,
    transport: {
      fetch: ((url: string) => Promise.resolve(handler(url))) as unknown as typeof globalThis.fetch,
    },
  };
}

test('OmniRoute health is sourced from OmniRoute, not computed by the breaker', async () => {
  await withDb(async (db) => {
    const created = connectionsRepository.create(db, {
      label: 'OmniRoute',
      kind: 'omniroute',
      authRef: HANDLE,
    });

    // The gateway reports itself healthy while CHIMERA-side chat probes would
    // fail — F1.6's "defer to it rather than double-managing".
    const adapter = new OmniRouteAdapter(
      omniRouteDeps((url) =>
        url.endsWith('/health')
          ? new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
          : new Response('nope', { status: 500 }),
      ),
    );

    const monitor = new HealthMonitor(db);
    const connection = { connectionId: created.id, adapter, options: OPTIONS };

    for (let i = 0; i < 5; i += 1) {
      const result = await monitor.probe(connection);
      assert.equal(result.selfReported, true, 'should have deferred to OmniRoute');
      assert.equal(result.state, 'healthy');
    }

    // The breaker must not have fired despite five probes that would have
    // failed had CHIMERA computed health itself.
    assert.equal(connectionsRepository.get(db, created.id)?.healthState, 'healthy');
  });
});

test('OmniRoute reporting itself unhealthy is believed too', async () => {
  await withDb(async (db) => {
    const created = connectionsRepository.create(db, {
      label: 'OmniRoute',
      kind: 'omniroute',
      authRef: HANDLE,
    });
    const adapter = new OmniRouteAdapter(
      omniRouteDeps(() => new Response(JSON.stringify({ healthy: false }), { status: 200 })),
    );
    const result = await new HealthMonitor(db).probe({
      connectionId: created.id,
      adapter,
      options: OPTIONS,
    });
    assert.equal(result.selfReported, true);
    assert.equal(result.state, 'unavailable');
  });
});

test('a missing /health route falls back to catalogue reachability rather than staying unknown', async () => {
  await withDb(async (db) => {
    const created = connectionsRepository.create(db, {
      label: 'OmniRoute',
      kind: 'omniroute',
      authRef: HANDLE,
    });

    // The health path is not pinned down by the master plan, so a differently
    // named route must degrade to a working check, not to a permanently
    // uninspected connection.
    const adapter = new OmniRouteAdapter(
      omniRouteDeps((url) =>
        url.endsWith('/models')
          ? new Response(JSON.stringify({ data: [{ id: 'a/b' }] }), { status: 200 })
          : new Response('not found', { status: 404 }),
      ),
    );

    const result = await new HealthMonitor(db).probe({
      connectionId: created.id,
      adapter,
      options: OPTIONS,
    });
    assert.equal(result.state, 'healthy');
    assert.equal(result.selfReported, true);
  });
});

test('an OmniRoute instance that answers nothing at all is marked unavailable', async () => {
  await withDb(async (db) => {
    const created = connectionsRepository.create(db, {
      label: 'OmniRoute',
      kind: 'omniroute',
      authRef: HANDLE,
    });
    const adapter = new OmniRouteAdapter(
      omniRouteDeps(() => new Response('down', { status: 503 })),
    );
    const result = await new HealthMonitor(db).probe({
      connectionId: created.id,
      adapter,
      options: OPTIONS,
    });
    // Falls through /health, then finds an empty catalogue — a gateway that
    // cannot say how it is, is not healthy.
    assert.equal(result.state, 'unavailable');
  });
});
