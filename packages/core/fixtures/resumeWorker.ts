import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runsRepository } from '@chimera/store';
import { MockProvider } from '@chimera/providers';
import type { AdapterCallOptions, NormalisedRequest, ProviderAdapter } from '@chimera/providers';
import {
  connectInProcess,
  createToolRegistry,
  createSandbox,
  createFilesystemServer,
} from '@chimera/tools';
import { Governor } from '../src/governor/Governor.ts';
import { STARTER_ROLES } from '../src/runtime/roleRegistry.ts';
import { runAgentLoop } from '../src/runtime/agentLoop.ts';
import { createCheckpointStore } from '../src/runtime/checkpoint.ts';

// A real agent run in a real process, so the SIGKILL test kills something that
// is genuinely mid-run rather than a simulation of one.
//
// argv: <workDir> <mode>
//   mode "die"  — runs until the parent kills it. It appends to calls.log on
//                 every provider call and to steps.log on every checkpoint, so
//                 the parent knows when it is safe to kill.
//   mode "finish" — resumes from the journal and runs to completion, writing
//                 result.json.

const [workDir, mode] = process.argv.slice(2);
if (!workDir || !mode) throw new Error('usage: resumeWorker <workDir> <mode>');

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'store',
  'src',
  'migrations',
);

const callsLog = path.join(workDir, 'calls.log');

class LoggingProvider implements ProviderAdapter {
  readonly kind = 'openai-compatible' as const;
  private readonly inner: MockProvider;

  constructor(inner: MockProvider) {
    this.inner = inner;
  }

  async chat(request: NormalisedRequest, options: AdapterCallOptions) {
    fs.appendFileSync(callsLog, 'call\n');
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

const db = openDatabase({ dbPath: path.join(workDir, 'run.sqlite'), migrationsDir });
runsRepository.create(db, { id: 'run-kill' });
const checkpoints = createCheckpointStore(db);

const sandbox = createSandbox(path.join(workDir, 'sandboxes'), 'run-kill');
const tools = createToolRegistry();
await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));

const coder = STARTER_ROLES.find((role) => role.id === 'coder');
if (!coder) throw new Error('coder role missing');

// The mock's queue is its model's utterances in order. A real provider is
// stateless and simply answers whatever conversation it is handed; the mock has
// to be told where the conversation is, so the resumed process starts from the
// answers that come *next* rather than replaying the ones already journaled.
// That is a property of the test double, not of the checkpoint mechanism.
const writeFirst = {
  kind: 'toolCall' as const,
  toolId: 'filesystem__writeFile',
  toolName: 'filesystem__writeFile',
  params: { path: 'first.txt', content: 'one' },
};
const writeSecond = {
  kind: 'toolCall' as const,
  toolId: 'filesystem__writeFile',
  toolName: 'filesystem__writeFile',
  params: { path: 'second.txt', content: 'two' },
};
const done = {
  kind: 'text' as const,
  content: '{"verified": true, "evidence": "both files exist"}',
};

const provider = new LoggingProvider(
  new MockProvider({
    script: {
      queue:
        mode === 'die'
          ? [
              { kind: 'text', content: 'Plan: write two files.' },
              writeFirst,
              { kind: 'text', content: '{"verified": false, "evidence": "one file so far"}' },
              // The second iteration's tool call. Its tool never returns, so
              // the parent's SIGKILL lands with the run genuinely in flight.
              writeSecond,
              done,
            ]
          : [writeSecond, done],
    },
  }),
);

const task = {
  runId: 'run-kill',
  nodeId: 'node-1',
  role: coder,
  task: 'Write two files.',
  connectionId: 'conn-1',
  model: 'mock-frontier',
};

if (mode === 'die') {
  // Signals readiness once the first iteration's tool result is journaled, then
  // hangs. The parent kills it here — mid-run, with a valid checkpoint on disk.
  const watcher = setInterval(() => {
    const state = checkpoints.load('run-kill', 'node-1');
    if (state && Object.keys(state.completedToolCalls).length >= 1) {
      fs.writeFileSync(path.join(workDir, 'ready'), 'ready');
    }
  }, 20);

  await runAgentLoop(task, {
    governor: new Governor(),
    provider,
    tools: {
      ...tools,
      invoke: async (toolId, params, context) => {
        const result = await tools.invoke(toolId, params, context);
        if (params.path === 'second.txt') {
          // Never returns. The kill lands while the run is genuinely in flight.
          await new Promise(() => undefined);
        }
        return result;
      },
    },
    callOptions: { authRef: 'vault:connection:0'.padEnd(48, '0') as never },
    checkpoints,
  });
  clearInterval(watcher);
} else {
  const result = await runAgentLoop(task, {
    governor: new Governor(),
    provider,
    tools,
    callOptions: { authRef: 'vault:connection:0'.padEnd(48, '0') as never },
    checkpoints,
  });
  fs.writeFileSync(
    path.join(workDir, 'result.json'),
    JSON.stringify({
      status: result.status,
      iterations: result.iterations,
      steps: result.steps.map((step) => step.purpose),
    }),
  );
  await tools.close();
  db.close();
  process.exit(0);
}
