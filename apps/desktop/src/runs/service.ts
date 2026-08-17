import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Governor, createRoleRegistry, runAutomation, type RunBrief } from '@chimera/core';
import { runsRepository } from '@chimera/store';
import { adapterFor } from '@chimera/providers';
import {
  connectInProcess,
  createFilesystemServer,
  createSandbox,
  createMemoryServer,
  createShellServer,
  createToolRegistry,
} from '@chimera/tools';
import { getStore } from '../store/lifecycle.ts';
import { connectionFor } from '../providers/service.ts';
import { emitRunEvent } from './subscriptions.ts';
import { localBackend } from '../memory/backend.ts';

// Starting a run: the main-process half. Assembles the real pieces — the role
// registry, a per-run sandbox, the tool servers, an enforcing Governor — and
// hands them to the engine.

const cancellations = new Map<string, { cancelled: boolean }>();

/** Runs paused at an approval node, keyed by run id, then node id. */
const pendingApprovals = new Map<
  string,
  Map<string, (answer: { approved: boolean; note: string }) => void>
>();

/**
 * Answers a waiting approval gate.
 *
 * Returns false for a gate that is not waiting — a stale click from a window
 * that was reopened, or a second answer to a gate already answered. Silently
 * accepting either would let a run past a gate twice.
 */
export function answerApproval(input: {
  runId: string;
  nodeId: string;
  approved: boolean;
  note: string;
}): { accepted: boolean } {
  const forRun = pendingApprovals.get(input.runId);
  const resolve = forRun?.get(input.nodeId);
  if (!forRun || !resolve) return { accepted: false };
  forRun.delete(input.nodeId);
  resolve({ approved: input.approved, note: input.note });
  return { accepted: true };
}

export function cancelRun(runId: string): { accepted: boolean } {
  const flag = cancellations.get(runId);
  if (!flag) return { accepted: false };
  flag.cancelled = true;
  return { accepted: true };
}

export async function startRun(brief: RunBrief): Promise<{ runId: string }> {
  const db = getStore();
  const run = runsRepository.create(db, { id: randomUUID(), inputJson: JSON.stringify(brief) });
  const cancellation = { cancelled: false };
  cancellations.set(run.id, cancellation);

  const roles = createRoleRegistry(db).list();
  const sandbox = createSandbox(path.join(os.tmpdir(), 'chimera-runs'), run.id);
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));
  await tools.registerServer('shell', await connectInProcess(createShellServer(sandbox)));
  // Memory is per-run only in its attribution: what is written is workspace-wide
  // and outlives the run, which is the entire point of it.
  await tools.registerServer(
    'memory',
    await connectInProcess(createMemoryServer(localBackend(run.id, 'agent'))),
  );

  // Enforcing, with each role's own declared budget as its cap. A run started
  // from the canvas is a real run and gets real limits — the permissive mode
  // exists for planning and dry runs, not for anything that spends money.
  const governor = new Governor('enforcing', {
    budget: {
      perRole: Object.fromEntries(
        roles.map((role) => [
          role.id,
          { maxTokens: role.budget.maxTokens, maxCostUsd: role.budget.maxCostUsd },
        ]),
      ),
    },
  });

  emitRunEvent(run.id, 'started', { steps: brief.steps.map((step) => step.nodeId) });

  // Deliberately not awaited: the invoke returns a run id immediately so the
  // renderer can subscribe and watch, rather than blocking a channel for the
  // length of a run that may take minutes.
  void (async () => {
    try {
      const outcome = await runAutomation({
        db,
        runId: run.id,
        brief,
        roles,
        providerFor: (connectionId) => {
          const connection = connectionFor(connectionId);
          return {
            adapter: adapterFor(connection.kind),
            options: {
              authRef: connection.authRef,
              ...(connection.baseUrl === null ? {} : { baseUrl: connection.baseUrl }),
            },
          };
        },
        tools,
        governor,
        cancellation,
        onStep: (event) => {
          emitRunEvent(run.id, `step:${event.phase}`, event);
        },
        requestApproval: (input) =>
          new Promise((resolve) => {
            const forRun = pendingApprovals.get(run.id) ?? new Map();
            pendingApprovals.set(run.id, forRun);
            forRun.set(input.nodeId, resolve);
            // The run now waits. No timeout: a gate that approves itself after
            // an interval is a gate that approves itself, and the user can
            // always cancel the run instead.
            emitRunEvent(run.id, 'approval:requested', input);
          }),
      });
      emitRunEvent(run.id, 'finished', outcome);
    } catch (err) {
      // Surfaced as an event rather than thrown into a void: the invoke has
      // already resolved, so a rejection here would be an unhandled one in main
      // and the renderer would wait forever.
      const message = err instanceof Error ? err.message : String(err);
      runsRepository.finish(db, run.id, 'failed', message);
      emitRunEvent(run.id, 'failed', { message });
    } finally {
      cancellations.delete(run.id);
      // Anything still waiting is refused rather than left hanging: the run is
      // over, so an approval for it can no longer mean anything.
      for (const resolve of pendingApprovals.get(run.id)?.values() ?? []) {
        resolve({ approved: false, note: 'The run ended before this was answered.' });
      }
      pendingApprovals.delete(run.id);
      await tools.close();
    }
  })();

  return { runId: run.id };
}
