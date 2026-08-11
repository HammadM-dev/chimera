import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase, runsRepository, tracesRepository } from '@chimera/store';
import { MockProvider } from '@chimera/providers';
import type { AdapterCallOptions } from '@chimera/providers';
import {
  connectInProcess,
  createToolRegistry,
  createSandbox,
  createFilesystemServer,
  createShellServer,
} from '@chimera/tools';
import { Governor } from '../governor/Governor.ts';
import type { ModelCallAuthorization, ToolCallAuthorization } from '../governor/types.ts';
import { STARTER_ROLES } from './roleRegistry.ts';
import { runAgentLoop } from './agentLoop.ts';
import { createCheckpointStore } from './checkpoint.ts';
import { createTraceSink } from './trace.ts';

// M2-11, the milestone's exit criterion: "give one agent a real task in a
// sandbox dir, it plans/executes/verifies/completes; kill the app mid-run and
// resume it."
//
// The kill-and-resume half is exercised against a real process in
// checkpoint.test.ts; this file is the whole-milestone demo — a real role, a
// real sandbox, real MCP servers, the Governor on the call path, and a complete
// trace in the database at the end.

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, '..', '..', '..', 'store', 'src', 'migrations');
const workerPath = path.join(here, '..', '..', 'fixtures', 'resumeWorker.ts');
const AUTH: AdapterCallOptions = { authRef: 'vault:connection:0'.padEnd(48, '0') as never };

const coder = STARTER_ROLES.find((role) => role.id === 'coder');
if (!coder) throw new Error('coder role missing');

class CountingGovernor extends Governor {
  modelCalls = 0;
  toolCalls = 0;

  override authorizeModelCall(
    request: Parameters<Governor['authorizeModelCall']>[0],
  ): ModelCallAuthorization {
    this.modelCalls += 1;
    return super.authorizeModelCall(request);
  }
  override authorizeToolCall(
    request: Parameters<Governor['authorizeToolCall']>[0],
  ): ToolCallAuthorization {
    this.toolCalls += 1;
    return super.authorizeToolCall(request);
  }
}

test('an agent plans, acts, verifies and completes a real task in its sandbox', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-m2-demo-'));
  const db = openDatabase({ dbPath: path.join(dir, 'workspace.sqlite'), migrationsDir });
  runsRepository.create(db, { id: 'demo-run' });

  const sandbox = createSandbox(path.join(dir, 'sandboxes'), 'demo-run');
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));
  await tools.registerServer('shell', await connectInProcess(createShellServer(sandbox)));

  const governor = new CountingGovernor();

  try {
    // The task: write a file, then prove it is there by reading it back. Both
    // steps are real tool calls against a real sandbox.
    const result = await runAgentLoop(
      {
        runId: 'demo-run',
        nodeId: 'writer',
        role: coder,
        task: 'Create notes/report.md containing the word "complete", then confirm it is readable.',
        connectionId: 'conn-1',
        model: 'mock-frontier',
      },
      {
        governor,
        provider: new MockProvider({
          script: {
            queue: [
              { kind: 'text', content: 'Plan: write the file, then read it back to confirm.' },
              {
                kind: 'toolCall',
                toolId: 'filesystem__writeFile',
                toolName: 'filesystem__writeFile',
                params: { path: 'notes/report.md', content: 'complete' },
              },
              { kind: 'text', content: '{"verified": false, "evidence": "not read back yet"}' },
              {
                kind: 'toolCall',
                toolId: 'filesystem__readFile',
                toolName: 'filesystem__readFile',
                params: { path: 'notes/report.md' },
              },
              {
                kind: 'text',
                content: '{"verified": true, "evidence": "readFile returned \\"complete\\""}',
              },
            ],
          },
        }),
        tools,
        callOptions: AUTH,
        checkpoints: createCheckpointStore(db),
        trace: createTraceSink(db, 'demo-run'),
      },
    );

    assert.equal(result.status, 'succeeded');
    assert.equal(result.iterations, 2);
    assert.equal(result.verification?.verified, true);

    // The file is really on disk, inside the sandbox and nowhere else.
    assert.equal(
      fs.readFileSync(path.join(sandbox.root, 'notes', 'report.md'), 'utf8'),
      'complete',
    );

    // Every model call and every tool call went through the Governor: five
    // model calls (plan, two acts, two verifies) and two tool calls.
    assert.equal(governor.modelCalls, 5);
    assert.equal(governor.toolCalls, 2);

    // Only allowlisted tools were used. The coder may write and shell out; it
    // did neither anything else nor anything outside its grant.
    const usedTools = result.observations.map((observation) => observation.toolId);
    assert.deepEqual(usedTools, ['filesystem.writeFile', 'filesystem.readFile']);
    for (const toolId of usedTools) {
      assert.ok(
        coder.toolAllowlist.some(
          (entry) => entry === toolId || entry === `${toolId.split('.')[0] ?? ''}.*`,
        ),
        toolId,
      );
    }
    assert.equal(
      result.observations.every((observation) => !observation.isError),
      true,
    );

    // ---- the trace ------------------------------------------------------
    const events = tracesRepository.listForRun(db, 'demo-run');
    const kinds = new Set(events.map((event) => event.eventType));

    // The criterion names these five. The viewer is M4-7; the data has to be
    // right from now on, or M4 has nothing to render for any earlier run.
    for (const required of [
      'prompt',
      'response',
      'tool_call',
      'tool_result',
      'decision',
      'checkpoint',
    ]) {
      assert.ok(kinds.has(required as never), `no ${required} events in the trace`);
    }

    // Replay order is defined and gapless.
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
    );

    // Prompts and responses pair up, and the responses carry usage.
    const prompts = events.filter((event) => event.eventType === 'prompt');
    const responses = events.filter((event) => event.eventType === 'response');
    assert.equal(prompts.length, 5);
    assert.equal(responses.length, 5);
    assert.ok(responses.every((event) => (event.tokensIn ?? 0) > 0));

    // A tool result is recorded for every tool call, and it says whether it was
    // really executed or replayed from a checkpoint — the distinction the
    // resume path depends on.
    const toolCalls = events.filter((event) => event.eventType === 'tool_call');
    const toolResults = events.filter((event) => event.eventType === 'tool_result');
    assert.equal(toolCalls.length, 2);
    assert.equal(toolResults.length, 2);
    for (const event of toolResults) {
      const payload = JSON.parse(event.payloadJson) as { replayedFromCheckpoint: boolean };
      assert.equal(payload.replayedFromCheckpoint, false);
    }

    // The prompt event carries what was actually sent, including the untrusted
    // envelope around the tool output — this is the record an auditor reads.
    const secondPrompt = prompts[2];
    assert.ok(secondPrompt);
    const promptPayload = JSON.parse(secondPrompt.payloadJson) as {
      system: string;
      messages: { role: string; content: string }[];
    };
    assert.ok(promptPayload.system.includes(coder.systemPrompt));
    assert.ok(
      promptPayload.messages.some(
        (message) => message.role === 'tool' && message.content.includes('BEGIN UNTRUSTED DATA'),
      ),
      'the tool output was not enveloped in the traced prompt',
    );

    // The final decision is the verified one.
    const decisions = events.filter((event) => event.eventType === 'decision');
    const last = decisions.at(-1);
    assert.ok(last);
    assert.equal((JSON.parse(last.payloadJson) as { decision: string }).decision, 'verified');
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the killed-and-resumed run leaves one continuous trace, not two', async () => {
  // The resume half of the exit criterion, checked from the trace's point of
  // view: an auditor reading the run afterwards sees one story with the kill in
  // the middle, not a run that started twice.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-m2-resume-'));

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

    const resumed = spawn(
      process.execPath,
      ['--experimental-strip-types', workerPath, dir, 'finish'],
      { stdio: 'ignore' },
    );
    assert.equal(
      await new Promise<number>((resolve) => {
        resumed.on('exit', (code) => resolve(code ?? -1));
      }),
      0,
    );

    const db = openDatabase({ dbPath: path.join(dir, 'run.sqlite'), migrationsDir });
    try {
      const events = tracesRepository.listForRun(db, 'run-kill');

      // One continuous sequence across both processes: `seq` is allocated in
      // SQLite from the current maximum, so the second process continues the
      // numbering rather than restarting it.
      assert.deepEqual(
        events.map((event) => event.seq),
        events.map((_, index) => index + 1),
      );

      // Exactly one plan prompt in the whole trace. The resumed process did not
      // replan, and the trace shows that rather than us taking the loop's word.
      const planPrompts = events.filter(
        (event) =>
          event.eventType === 'prompt' &&
          (JSON.parse(event.payloadJson) as { purpose: string }).purpose === 'plan',
      );
      assert.equal(planPrompts.length, 1);

      // The first file was written once. A second tool_result for it would mean
      // a side effect repeated on resume.
      const writes = events.filter((event) => {
        if (event.eventType !== 'tool_result') return false;
        const payload = JSON.parse(event.payloadJson) as { toolId: string; output: string };
        return payload.toolId === 'filesystem.writeFile' && payload.output.includes('first.txt');
      });
      assert.equal(writes.length, 1, 'the first write appears more than once in the trace');

      const decisions = events.filter((event) => event.eventType === 'decision');
      assert.equal(
        (JSON.parse(decisions.at(-1)?.payloadJson ?? '{}') as { decision?: string }).decision,
        'verified',
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
