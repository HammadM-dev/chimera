import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { Governor, createRoleRegistry, runAutomation, type RunBrief } from '@chimera/core';
import { runsRepository, settingsRepository, tracesRepository } from '@chimera/store';
import { adapterFor } from '@chimera/providers';
import {
  connectInProcess,
  createBrowserServer,
  createHttpServer,
  createFilesystemServer,
  createSandbox,
  createMemoryServer,
  createShellServer,
  createToolRegistry,
} from '@chimera/tools';
import { getStore } from '../store/lifecycle.ts';
import { connectionFor } from '../providers/service.ts';
import { emitRunEvent, subscribe } from './subscriptions.ts';
import { localBackend } from '../memory/backend.ts';
import { assertRunnable } from '../automations/store.ts';
import { pageForWorkspace } from './browser.ts';
import { cacheHookFor } from './cache.ts';
import { registerPlugins, pluginSecrets } from '../plugins/service.ts';
import { exportRun } from './otel.ts';
import { screenshotSinkFor } from './screenshots.ts';

// Starting a run: the main-process half. Assembles the real pieces — the role
// registry, a per-run sandbox, the tool servers, an enforcing Governor — and
// hands them to the engine.

const cancellations = new Map<string, { cancelled: boolean }>();

/** Runs paused at an approval node, keyed by run id, then node id. */
const pendingApprovals = new Map<
  string,
  Map<string, (answer: { approved: boolean; note: string }) => void>
>();

/** The status a run holds while a person is being asked. */
const AWAITING = 'awaiting_approval';

/**
 * Cancels every run in flight, and reports how many there were.
 *
 * The panic key's half of M8-3. Cancellation is cooperative — the executor
 * checks the flag between steps and the agent loop between iterations — which
 * is why this returns a count rather than a promise: what a person needs to see
 * immediately is that the stop was heard.
 */
export function cancelEveryRun(): number {
  let stopped = 0;
  for (const flag of cancellations.values()) {
    if (!flag.cancelled) {
      flag.cancelled = true;
      stopped += 1;
    }
  }
  return stopped;
}

export function cancelRun(runId: string): { accepted: boolean } {
  const flag = cancellations.get(runId);
  if (!flag) return { accepted: false };
  flag.cancelled = true;
  return { accepted: true };
}

export interface AwaitingApproval {
  runId: string;
  nodeId: string;
  prompt: string;
  context: string;
  /** True when the process holding this run is still alive to resume it. */
  live: boolean;
}

/**
 * Runs stopped at a gate, including ones this process did not start.
 *
 * Read from the workspace rather than from memory, so a gate opened before a
 * crash is still a gate on the next launch. A run that quietly disappeared
 * because the app restarted would be the worst possible behaviour for the one
 * mechanism whose entire job is not to act without a person.
 */
export function awaitingApprovals(): { waiting: AwaitingApproval[] } {
  const db = getStore();
  const waiting = runsRepository.listByStatus(db, AWAITING).flatMap((run) => {
    const asked = tracesRepository
      .listForRun(db, run.id)
      .filter((event) => event.eventType === 'decision')
      .map((event) => ({
        nodeId: event.nodeId,
        payload: JSON.parse(event.payloadJson) as {
          decision?: string;
          prompt?: string;
          context?: string;
        },
      }))
      .filter((event) => event.payload.decision === 'approval:requested')
      .at(-1);

    if (!asked) return [];
    return [
      {
        runId: run.id,
        nodeId: asked.nodeId,
        prompt: asked.payload.prompt ?? 'Approve this step?',
        context: asked.payload.context ?? '',
        live: pendingApprovals.get(run.id)?.has(asked.nodeId) === true,
      },
    ];
  });

  return { waiting };
}

/**
 * Answers a waiting approval gate.
 *
 * Two paths, because a gate outlives the process that opened it. If the run is
 * still in flight, the waiting promise is resolved and it carries on where it
 * stopped. If the app restarted, the answer is written to the trace and the run
 * is started again — replaying its finished steps from the journal rather than
 * paying for them twice.
 */
export function answerApproval(input: {
  runId: string;
  nodeId: string;
  approved: boolean;
  note: string;
}): { accepted: boolean } {
  const db = getStore();
  const forRun = pendingApprovals.get(input.runId);
  const resolve = forRun?.get(input.nodeId);

  if (forRun && resolve) {
    forRun.delete(input.nodeId);
    runsRepository.setStatus(db, input.runId, input.approved ? 'running' : 'cancelled');
    resolve({ approved: input.approved, note: input.note });
    return { accepted: true };
  }

  const run = runsRepository.get(db, input.runId);
  if (!run || run.status !== AWAITING) return { accepted: false };

  // The answer goes to the trace first. It is what the resumed run reads to
  // know it has already been asked, and it is the record of who decided what.
  tracesRepository.append(db, {
    runId: input.runId,
    nodeId: input.nodeId,
    eventType: 'decision',
    payloadJson: JSON.stringify({
      decision: input.approved ? 'approval:granted' : 'approval:refused',
      note: input.note,
      answeredAfterRestart: true,
    }),
  });

  if (!input.approved) {
    runsRepository.finish(
      db,
      input.runId,
      'cancelled',
      input.note === '' ? 'Refused.' : `Refused: ${input.note}`,
    );
    emitRunEvent(input.runId, 'finished', {
      runId: input.runId,
      status: 'cancelled',
      summary: 'Refused.',
      steps: [],
      output: '',
    });
    return { accepted: true };
  }

  let brief: RunBrief;
  try {
    brief = JSON.parse(run.inputJson) as RunBrief;
  } catch {
    return { accepted: false };
  }

  runsRepository.setStatus(db, input.runId, 'running');
  void execute(input.runId, brief, true);
  return { accepted: true };
}

/**
 * Runs an automation to completion, in the background.
 *
 * Deliberately not awaited by its callers: `run:start` returns a run id
 * immediately so the renderer can subscribe and watch, rather than blocking a
 * channel for the length of a run that may take minutes.
 */
async function execute(runId: string, brief: RunBrief, resume: boolean): Promise<void> {
  const db = getStore();
  const cancellation = { cancelled: false };
  cancellations.set(runId, cancellation);

  const roles = createRoleRegistry(db).list();
  const sandbox = createSandbox(path.join(os.tmpdir(), 'chimera-runs'), runId);
  const tools = createToolRegistry({ secrets: pluginSecrets });
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));
  await tools.registerServer('shell', await connectInProcess(createShellServer(sandbox)));
  // Memory is per-run only in its attribution: what is written is workspace-wide
  // and outlives the run, which is the entire point of it.
  await tools.registerServer(
    'memory',
    await connectInProcess(createMemoryServer(localBackend(runId, 'agent'))),
  );
  // The web tool, bounded by the automation's own allowlist.
  //
  // It was built, tested and exported, and then registered nowhere — so an
  // agent granted `http.request` did not get a tool that failed, it got no
  // tools at all, and was told "you have no tools" in its own system prompt.
  // The shipped Researcher carries that grant, which made the one agent whose
  // job is reading sources unable to reach any.
  //
  // Absent means empty, and empty means nothing is reachable: the same
  // default-closed rule the browser server gets, for the same reason.
  await tools.registerServer(
    'http',
    await connectInProcess(createHttpServer({ egressAllowlist: brief.egressAllowlist ?? [] })),
  );

  // Whatever the user has plugged in. Registered after CHIMERA's own servers
  // so a plugin cannot shadow `filesystem` or `shell` by claiming the name —
  // the registry refuses a duplicate server id, and the built-ins get there
  // first.
  await registerPlugins(tools);

  // The browser. Registered every run, launched on the first call that needs
  // it: most automations never open one, and paying Chromium's startup for a
  // run that reads files would be a second and 200MB nobody asked for.
  //
  // The allowlist is the automation's own. Absent means empty, which means the
  // browser goes nowhere — capability limits are the real defence, and one that
  // defaulted to open would be a defence that defaulted to off.
  await tools.registerServer(
    'browser',
    await connectInProcess(
      createBrowserServer({
        page: pageForWorkspace(),
        egressAllowlist: brief.egressAllowlist ?? [],
        screenshotSink: screenshotSinkFor(runId),
      }),
    ),
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

  // Which model each tier means, here. Read once at the start of the run: a
  // tier that changed halfway through a run would make the trace a record of
  // two different automations.
  const tiers = settingsRepository.read(db).modelTiers;
  const cache = cacheHookFor(db, runId);

  emitRunEvent(runId, resume ? 'resumed' : 'started', {
    steps: brief.steps.map((step) => step.nodeId),
    // Names as well as ids. The canvas already knows what its own steps are
    // called; the run monitor is a separate window that has only ever seen
    // this event, and "researcher-1" is not what the step is called.
    plan: brief.steps.map((step) => ({
      nodeId: step.nodeId,
      label: roles.find((role) => role.id === step.roleId)?.name ?? step.type ?? 'Step',
    })),
  });

  try {
    const outcome = await runAutomation({
      db,
      runId,
      brief,
      roles,
      resume,
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
      resolveTier: (tier) => tiers[tier],
      frontierModel: tiers.frontier.model,
      // Absent unless this workspace asked for a cache, so a run that is not
      // reusing anything does not pay to derive a key it will never look up.
      ...(cache ? { cache } : {}),
      onStep: (event) => {
        emitRunEvent(runId, `step:${event.phase}`, event);
      },
      onSpend: (snapshot) => {
        emitRunEvent(runId, 'spend', snapshot);
      },
      requestApproval: (input) =>
        new Promise((resolve) => {
          const forRun = pendingApprovals.get(runId) ?? new Map();
          pendingApprovals.set(runId, forRun);
          forRun.set(input.nodeId, resolve);
          // The run now waits, and says so in the workspace as well as on
          // screen. No timeout: a gate that approves itself after an interval
          // is a gate that approves itself, and the user can cancel instead.
          runsRepository.setStatus(db, runId, AWAITING);
          emitRunEvent(runId, 'approval:requested', input);
        }),
    });
    emitRunEvent(runId, 'finished', outcome);
    // Sent after the run is recorded, and never waited on for anything: a run
    // that depended on an observability endpoint would have the dependency the
    // wrong way round.
    void exportRun(runId);
  } catch (err) {
    // Surfaced as an event rather than thrown into a void: the invoke has
    // already resolved, so a rejection here would be an unhandled one in main
    // and the renderer would wait forever.
    const message = err instanceof Error ? err.message : String(err);
    runsRepository.finish(db, runId, 'failed', message);
    emitRunEvent(runId, 'failed', { message });
  } finally {
    cancellations.delete(runId);
    // Anything still waiting when the run ends is refused rather than left
    // hanging. A gate whose run is over can no longer mean anything.
    for (const resolve of pendingApprovals.get(runId)?.values() ?? []) {
      resolve({ approved: false, note: 'The run ended before this was answered.' });
    }
    pendingApprovals.delete(runId);
    await tools.close();
  }
}

export function startRun(
  brief: RunBrief,
  triggerType = 'manual',
  /**
   * Subscribed before the first event, not after.
   *
   * The window that asked for the run cannot subscribe until it knows the run
   * id, and by then `started` has already been emitted to nobody. Everything
   * downstream of that — the status bar's count of what is running, and so the
   * control indicator — was silently missing its first event.
   */
  watcher?: WebContents,
): { runId: string } {
  // The same rules the save path applies. A run started from an unsaved canvas
  // must not be the way around them.
  assertRunnable(brief);
  const db = getStore();
  const run = runsRepository.create(db, {
    id: randomUUID(),
    inputJson: JSON.stringify(brief),
    // Recorded so a run that started itself is distinguishable from one a
    // person pressed Run for — which is the first question anybody asks about
    // an automation that ran at three in the morning.
    triggerType,
  });
  if (watcher) subscribe(run.id, watcher);
  void execute(run.id, brief, false);
  return { runId: run.id };
}
