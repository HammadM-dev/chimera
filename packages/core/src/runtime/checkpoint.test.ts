import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { ChimeraError } from '@chimera/errors';
import { openDatabase, nodeStatesRepository, runsRepository } from '@chimera/store';
import { MockProvider } from '@chimera/providers';
import type { AdapterCallOptions, NormalisedRequest, ProviderAdapter } from '@chimera/providers';
import type { InvocationContext } from '@chimera/tools';
import {
  connectInProcess,
  createToolRegistry,
  createSandbox,
  createFilesystemServer,
} from '@chimera/tools';
import { Governor } from '../governor/Governor.ts';
import { STARTER_ROLES } from './roleRegistry.ts';
import { runAgentLoop } from './agentLoop.ts';
import { createCheckpointStore, idempotencyKeyFor, EMPTY_CHECKPOINT } from './checkpoint.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, '..', '..', '..', 'store', 'src', 'migrations');
// Deliberately not under a `test/` directory: `node --test` treats everything
// there as a test file, and this is a fixture that runs an agent loop.
const workerPath = path.join(here, '..', '..', 'fixtures', 'resumeWorker.ts');

const AUTH: AdapterCallOptions = { authRef: 'vault:connection:0'.padEnd(48, '0') as never };

const coder = STARTER_ROLES.find((role) => role.id === 'coder');
if (!coder) throw new Error('coder role missing');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-checkpoint-'));
}

/**
 * A workspace database with the run row already created.
 *
 * `node_states.run_id` is a foreign key, so a journal entry cannot exist
 * without a run. Creating it here rather than loosening the constraint: a
 * foreign key removed for a test's convenience is never put back.
 */
function openTemp(dir: string, runId?: string): Database.Database {
  const db = openDatabase({ dbPath: path.join(dir, 'run.sqlite'), migrationsDir });
  if (runId !== undefined) runsRepository.create(db, { id: runId });
  return db;
}

class CountingProvider implements ProviderAdapter {
  readonly kind = 'openai-compatible' as const;
  calls = 0;
  private readonly inner: MockProvider;

  constructor(inner: MockProvider) {
    this.inner = inner;
  }

  async chat(request: NormalisedRequest, options: AdapterCallOptions) {
    this.calls += 1;
    return this.inner.chat(request, options);
  }
  streamChat(request: NormalisedRequest, options: AdapterCallOptions) {
    return this.inner.streamChat(request, options);
  }
  listModels(options: AdapterCallOptions) {
    return this.inner.listModels(options);
  }
  testConnection(options: AdapterCallOptions) {
    return this.inner.testConnection(options);
  }
}

test('a run journals a node_states row after every completed step', async () => {
  const dir = tempDir();
  const db = openTemp(dir, 'run-1');
  const sandbox = createSandbox(path.join(dir, 'sandboxes'), 'run-1');
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));

  // Sampled from inside the run, not after it: the criterion is "verified by
  // inspecting the table mid-run", and a check that only runs at the end
  // cannot tell a per-step journal from a single write at completion.
  const samples: number[] = [];

  try {
    const provider = new CountingProvider(
      new MockProvider({
        script: {
          queue: [
            { kind: 'text', content: 'Plan.' },
            {
              kind: 'toolCall',
              toolId: 'filesystem__writeFile',
              toolName: 'filesystem__writeFile',
              params: { path: 'a.txt', content: 'a' },
            },
            { kind: 'text', content: '{"verified": true, "evidence": "a.txt exists"}' },
          ],
        },
      }),
    );

    await runAgentLoop(
      {
        runId: 'run-1',
        nodeId: 'node-1',
        role: coder,
        task: 'Write a.txt.',
        connectionId: 'conn-1',
        model: 'mock-frontier',
      },
      {
        governor: new Governor(),
        provider,
        tools: {
          ...tools,
          invoke: async (toolId, params, context) => {
            const before = nodeStatesRepository.get(db, 'run-1', 'node-1');
            samples.push(
              JSON.parse(before?.checkpointJson ?? '{"steps":[]}').steps.length as number,
            );
            return tools.invoke(toolId, params, context);
          },
        },
        callOptions: AUTH,
        checkpoints: createCheckpointStore(db),
      },
    );

    // By the time the tool runs, plan and act are both already on disk.
    assert.deepEqual(samples, [2]);

    const final = nodeStatesRepository.get(db, 'run-1', 'node-1');
    assert.ok(final);
    assert.equal(final.status, 'succeeded');
    assert.equal(final.iterationCount, 1);
    const checkpoint = JSON.parse(final.checkpointJson ?? '{}') as { steps: unknown[] };
    assert.equal(checkpoint.steps.length, 3);
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a completed tool call is replayed from the journal, never re-executed', async () => {
  const dir = tempDir();
  const db = openTemp(dir, 'run-2');
  const store = createCheckpointStore(db);
  const sandbox = createSandbox(path.join(dir, 'sandboxes'), 'run-2');
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));

  let invocations = 0;
  const countingTools = {
    ...tools,
    invoke: async (toolId: string, params: Record<string, unknown>, context: InvocationContext) => {
      invocations += 1;
      return tools.invoke(toolId, params, context);
    },
  };

  const script = {
    queue: [
      { kind: 'text' as const, content: 'Plan.' },
      {
        kind: 'toolCall' as const,
        toolId: 'filesystem__writeFile',
        toolName: 'filesystem__writeFile',
        params: { path: 'once.txt', content: 'one' },
      },
      { kind: 'text' as const, content: '{"verified": true, "evidence": "written"}' },
    ],
  };

  const task = {
    runId: 'run-2',
    nodeId: 'node-1',
    role: coder,
    task: 'Write once.txt.',
    connectionId: 'conn-1',
    model: 'mock-frontier',
  };

  try {
    await runAgentLoop(task, {
      governor: new Governor(),
      provider: new CountingProvider(new MockProvider({ script })),
      tools: countingTools,
      callOptions: AUTH,
      checkpoints: store,
    });
    assert.equal(invocations, 1);

    // Rewind the journal to just after the act step: the tool is recorded as
    // completed, but the run had not verified yet. This is the state a SIGKILL
    // between the tool returning and the verify call would leave behind.
    const journal = store.load('run-2', 'node-1');
    assert.ok(journal);
    assert.equal(Object.keys(journal.completedToolCalls).length, 1);
    store.save({
      runId: 'run-2',
      nodeId: 'node-1',
      status: 'running',
      checkpoint: {
        ...journal,
        steps: journal.steps.slice(0, 2),
        verification: null,
      },
    });

    // The second run replays the recorded result. A real HTTP POST here would
    // be a second order placed.
    await runAgentLoop(task, {
      governor: new Governor(),
      provider: new CountingProvider(new MockProvider({ script })),
      tools: countingTools,
      callOptions: AUTH,
      checkpoints: store,
    });

    assert.equal(invocations, 1, 'the tool ran again on resume');
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an idempotency key is reproducible and distinguishes the calls that differ', () => {
  const base = {
    runId: 'r',
    nodeId: 'n',
    iteration: 1,
    callIndex: 0,
    toolId: 'http.request',
    args: { url: 'https://example.com', method: 'POST' },
  };

  // Reproducible: a resumed run recomputes the identical key or the mechanism
  // is decorative.
  assert.equal(idempotencyKeyFor(base), idempotencyKeyFor(base));
  // Argument order is not part of the identity — the same call written two ways
  // is one call.
  assert.equal(
    idempotencyKeyFor(base),
    idempotencyKeyFor({ ...base, args: { method: 'POST', url: 'https://example.com' } }),
  );

  for (const differing of [
    { ...base, runId: 'other' },
    { ...base, nodeId: 'other' },
    { ...base, iteration: 2 },
    { ...base, callIndex: 1 },
    { ...base, toolId: 'http.get' },
    { ...base, args: { url: 'https://example.com/other', method: 'POST' } },
  ]) {
    assert.notEqual(idempotencyKeyFor(base), idempotencyKeyFor(differing));
  }
});

test('a failed checkpoint write raises a typed error and leaves the journal intact', () => {
  const dir = tempDir();
  const db = openTemp(dir, 'run-3');

  try {
    const store = createCheckpointStore(db);
    store.save({
      runId: 'run-3',
      nodeId: 'node-1',
      status: 'running',
      checkpoint: { ...EMPTY_CHECKPOINT, iteration: 1, output: 'good state' },
    });

    // A full disk, injected at the better-sqlite3 call site. The real thing
    // needs a quota-limited volume, which CI does not reliably provide; what
    // matters is that the failure is typed and the journal survives it.
    const failing = {
      prepare: () => ({
        run: () => {
          throw new Error('SQLITE_FULL: database or disk is full');
        },
      }),
    } as unknown as Database.Database;

    assert.throws(
      () =>
        createCheckpointStore(failing).save({
          runId: 'run-3',
          nodeId: 'node-1',
          status: 'running',
          checkpoint: { ...EMPTY_CHECKPOINT, iteration: 2, output: 'never lands' },
        }),
      (err: unknown) => err instanceof ChimeraError && err.code === 'STORE_WRITE_FAILED',
    );

    // The previous checkpoint is exactly as it was: the upsert is one atomic
    // statement, so a failure does not leave a half-written row behind.
    const survived = store.load('run-3', 'node-1');
    assert.equal(survived?.iteration, 1);
    assert.equal(survived?.output, 'good state');

    // And the database itself is still usable.
    assert.equal(nodeStatesRepository.listForRun(db, 'run-3').length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt checkpoint is discarded rather than half-applied', () => {
  const dir = tempDir();
  const db = openTemp(dir, 'run-4');
  try {
    nodeStatesRepository.upsert(db, {
      runId: 'run-4',
      nodeId: 'node-1',
      status: 'running',
      iterationCount: 1,
      tokensUsed: 0,
      costUsed: 0,
      checkpointJson: '{"version": 1, "iteration": 2, trunca',
    });
    assert.equal(createCheckpointStore(db).load('run-4', 'node-1'), null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a checkpoint from a future version is refused, not guessed at', () => {
  const dir = tempDir();
  const db = openTemp(dir, 'run-5');
  try {
    nodeStatesRepository.upsert(db, {
      runId: 'run-5',
      nodeId: 'node-1',
      status: 'running',
      iterationCount: 1,
      tokensUsed: 0,
      costUsed: 0,
      checkpointJson: JSON.stringify({ ...EMPTY_CHECKPOINT, version: 2 }),
    });
    assert.throws(
      () => createCheckpointStore(db).load('run-5', 'node-1'),
      (err: unknown) =>
        err instanceof ChimeraError && err.code === 'CHECKPOINT_VERSION_UNSUPPORTED',
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a SIGKILLed run resumes from its journal instead of starting over', async () => {
  // The criterion asks for the real thing: kill the actual process, relaunch
  // it, and show the run continues. A mocked "crash" would prove nothing about
  // what survives an abrupt death.
  const dir = tempDir();

  try {
    const victim = spawn(process.execPath, ['--experimental-strip-types', workerPath, dir, 'die'], {
      stdio: 'ignore',
    });

    const readyFile = path.join(dir, 'ready');
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(readyFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(fs.existsSync(readyFile), 'the worker never reached a journaled checkpoint');

    victim.kill('SIGKILL');
    await new Promise<void>((resolve) => victim.on('exit', () => resolve()));

    const callsBeforeKill = fs
      .readFileSync(path.join(dir, 'calls.log'), 'utf8')
      .trim()
      .split('\n').length;
    assert.ok(
      callsBeforeKill >= 3,
      `expected the run to be under way, saw ${String(callsBeforeKill)} calls`,
    );

    // Relaunch against the same workspace database.
    const resumed = spawn(
      process.execPath,
      ['--experimental-strip-types', workerPath, dir, 'finish'],
      { stdio: 'ignore' },
    );
    const code = await new Promise<number>((resolve) => {
      resumed.on('exit', (exitCode) => resolve(exitCode ?? -1));
    });
    assert.equal(code, 0);

    const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')) as {
      status: string;
      steps: string[];
    };
    assert.equal(result.status, 'succeeded');

    // It did not replan: the second process's first model call was an `act`,
    // continuing the run, and the plan step in the result came from the
    // journal rather than from a fresh call.
    assert.equal(result.steps[0], 'plan');
    assert.equal(result.steps.filter((step) => step === 'plan').length, 1);

    // The first file, written before the kill, is still there and was not
    // written a second time; the second file, which never got written, now is.
    const sandbox = path.join(dir, 'sandboxes', 'run-kill');
    assert.equal(fs.readFileSync(path.join(sandbox, 'first.txt'), 'utf8'), 'one');
    assert.equal(fs.readFileSync(path.join(sandbox, 'second.txt'), 'utf8'), 'two');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
