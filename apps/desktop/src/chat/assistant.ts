import { Governor, createRoleRegistry, createTraceSink, runAgentLoop } from '@chimera/core';
import type { Message } from '@chimera/providers';
import { adapterFor } from '@chimera/providers';
import {
  createToolRegistry,
  connectInProcess,
  createNotebookServer,
  createWorkspaceServer,
} from '@chimera/tools';
import { runsRepository } from '@chimera/store';
import { getStore } from '../store/lifecycle.ts';
import { connectionFor } from '../providers/service.ts';
import { workspaceBackend } from './workspaceBackend.ts';
import { planAutomation } from '../automations/planner.ts';
import { notebookBackend } from '../notes/service.ts';

// The assistant on the home screen.
//
// It used to be a single call straight to `adapter.streamChat` with the user's
// message and nothing else — no workspace, no tools, and, worth saying plainly,
// no Governor. CLAUDE.md's first hard rule is that every model call goes
// through one, and that path did not. Anything with tools certainly must, so
// this is built on `runAgentLoop` like every other agent: same authorisation,
// same budget, same untrusted-data envelope, same trace.
//
// One run of the loop per message the person sends, with the conversation so
// far seeded as history. That is what makes it a conversation rather than a
// series of strangers, and it costs nothing extra — the loop already knew how
// to carry a history, it had simply never been given one.

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantAnswer {
  text: string;
  /**
   * An automation the assistant designed during this turn, if it designed one.
   *
   * Returned separately so the home screen can offer to open it on the canvas.
   * The assistant applies nothing itself.
   */
  plan: { name: string; summary: string; steps: unknown; edges?: unknown } | null;
  costUsd: number;
  tokens: number;
}

export async function askAssistant(input: {
  connectionId: string;
  model: string;
  /** The newest thing the person said. */
  message: string;
  /** Everything said before it, oldest first. */
  history: AssistantTurn[];
}): Promise<AssistantAnswer> {
  const db = getStore();

  const role = createRoleRegistry(db).get('assistant');
  if (!role) throw new Error('The Assistant agent is missing from this workspace.');

  const { adapter, options } = (() => {
    const connection = connectionFor(input.connectionId);
    return {
      adapter: adapterFor(connection.kind),
      options: {
        authRef: connection.authRef,
        ...(connection.baseUrl === null ? {} : { baseUrl: connection.baseUrl }),
      },
    };
  })();

  // Whatever the assistant designs is kept here and handed back with the
  // answer. The tool returns it to the model as well, so the model can talk
  // about what it built rather than announcing a plan the user cannot see.
  let designed: AssistantAnswer['plan'] = null;

  const tools = createToolRegistry();
  await tools.registerServer(
    'workspace',
    await connectInProcess(
      createWorkspaceServer(
        workspaceBackend({
          plan: async (description) => {
            const result = await planAutomation({
              description,
              connectionId: input.connectionId,
              model: input.model,
            });
            designed = result;
            return result;
          },
        }),
      ),
    ),
  );

  // The notes board. The assistant reads this workspace and, now, can write one
  // specific kind of thing to it: a note or a reminder for the person.
  //
  // Worth saying plainly, because it narrows a property this file used to claim
  // outright. The assistant was read-only by construction and that was
  // deliberate — an assistant quietly recording memories during a conversation
  // about the memories is a thing nobody asked for. This is the opposite case
  // and was asked for: something written where the person will see it, on a
  // board with an edit and a delete beside every row. `memory.remember` is
  // still not granted here.
  await tools.registerServer(
    'notebook',
    await connectInProcess(createNotebookServer(notebookBackend('assistant'))),
  );

  // A run row, because the Governor and the trace are both per-run and because
  // a conversation that cost money should appear in the history that shows what
  // money went where.
  const run = runsRepository.create(db, { triggerType: 'chat' });

  // Enforcing, with the assistant's own declared budget as the cap. A
  // conversation spends real money on a real provider, and the permissive mode
  // exists for planning and dry runs.
  const governor = new Governor('enforcing', {
    budget: {
      perRole: {
        [role.id]: { maxTokens: role.budget.maxTokens, maxCostUsd: role.budget.maxCostUsd },
      },
    },
  });

  const result = await runAgentLoop(
    {
      runId: run.id,
      nodeId: 'assistant',
      role,
      task: input.message,
      connectionId: input.connectionId,
      model: input.model,
      // Nothing this agent can reach is irreversible — the workspace server is
      // reads and a design — so there is nothing here for a gate to stand in
      // front of.
      gated: false,
    },
    {
      governor,
      provider: adapter,
      tools,
      callOptions: options,
      // Traced like any other run. A conversation that reads the workspace and
      // spends real money on a real provider is exactly the thing an audit
      // trail is for, and it had none — the loop simply defaulted to the null
      // sink because nobody passed one.
      trace: createTraceSink(db, run.id),
      seedHistory: input.history.map<Message>((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
    },
  );

  const spend = runsRepository.listRecent(db, 50).find((row) => row.id === run.id);
  runsRepository.finish(db, run.id, result.status === 'succeeded' ? 'succeeded' : 'failed', '');
  runsRepository.setOutput(db, run.id, result.output);

  return {
    text: result.output,
    plan: designed,
    costUsd: spend?.costUsd ?? 0,
    tokens: spend?.tokensUsed ?? 0,
  };
}
