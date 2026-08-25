import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import os from 'node:os';
import path from 'node:path';
import {
  Governor,
  createRoleRegistry,
  runAutomation,
  serverIdForApp,
  type RunBrief,
} from '@chimera/core';
import {
  getSecret,
  nodeStatesRepository,
  runsRepository,
  settingsRepository,
  tracesRepository,
  type AuthRef,
} from '@chimera/store';
import { adapterFor } from '@chimera/providers';
import {
  connectInProcess,
  createEmailServer,
  createBrowserServer,
  createHttpServer,
  createSearchServer,
  createComposioServer,
  createFilesystemServer,
  createSandbox,
  createMemoryServer,
  createShellServer,
  createToolRegistry,
} from '@chimera/tools';
import { getStore } from '../store/lifecycle.ts';
import { capabilitiesLookup, connectionFor } from '../providers/service.ts';
import { emitRunEvent, subscribe } from './subscriptions.ts';
import { createActivityReader, type Activity } from './activity.ts';
import { askSwarm } from '../swarm/threads.ts';
import { composioBackend, connectedToolkitSlugs } from '../composio/service.ts';
import { localBackend } from '../memory/backend.ts';
import { assertRunnable } from '../automations/store.ts';
import { pageForWorkspace } from './browser.ts';
import { cacheHookFor } from './cache.ts';
import { registerPlugins, pluginSecrets } from '../plugins/service.ts';
import { exportRun } from './otel.ts';
import { screenshotSinkFor } from './screenshots.ts';
import { readableFolders } from '../files/grants.ts';
import {
  credentialsFor,
  emailSecrets,
  listAccounts,
  serverIdForAccount,
} from '../email/service.ts';

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
/**
 * The state of a run, for something that has just started watching it.
 *
 * Events are a live view and nothing more: whatever was emitted before a
 * watcher subscribed is gone. The run monitor opens in a second window, which
 * takes long enough to load that a short run is finished before it is
 * listening — so it sat on "Starting…" and never moved, for exactly the runs
 * that were quickest to succeed.
 */
export function runSnapshot(runId: string): {
  status: string;
  output: string;
  errorSummary: string;
  startedAt: string;
  endedAt: string;
  steps: { nodeId: string; label: string; status: string }[];
  activity: Activity[];
} {
  const db = getStore();
  const record = runsRepository.get(db, runId);
  if (!record) {
    return {
      status: '',
      output: '',
      errorSummary: '',
      startedAt: '',
      endedAt: '',
      steps: [],
      activity: [],
    };
  }

  // The names the steps were given, out of the brief the run was started with.
  // Without them a watcher can only show node ids, and "planner-1" is not what
  // the step is called.
  const labels = new Map<string, string>();
  try {
    const brief = JSON.parse(record.inputJson) as {
      steps?: { nodeId: string; roleId: string; type?: string }[];
    };
    const roles = createRoleRegistry(db).list();
    for (const step of brief.steps ?? []) {
      labels.set(
        step.nodeId,
        roles.find((role) => role.id === step.roleId)?.name ?? step.type ?? step.nodeId,
      );
    }
  } catch {
    // A brief that will not parse costs the labels and nothing else.
  }

  const over = record.status !== 'running' && record.status !== AWAITING;

  // Replayed from the stored trace rather than remembered from the live feed.
  //
  // The live events go out as they happen, and a window that is not open yet
  // gets none of them — which is every window for the first moment of a run,
  // and *all* of a run that finishes in two seconds. Reading the trace back is
  // what makes the feed the same whether you were watching from the start,
  // opened the window late, or came back to a run that ended yesterday.
  const activity: Activity[] = [];
  try {
    const reader = createActivityReader();
    for (const event of tracesRepository.listForRun(db, runId)) {
      const line = reader.read(
        {
          nodeId: event.nodeId,
          eventType: event.eventType,
          payload: JSON.parse(event.payloadJson) as Record<string, unknown>,
        },
        Date.parse(event.ts),
      );
      if (line !== null) activity.push(line);
    }
  } catch {
    // A trace that will not read back costs the feed and nothing else; the
    // steps and the answer are read from their own tables.
  }

  return {
    status: record.status,
    output: record.output,
    errorSummary: record.errorSummary ?? '',
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? '',
    activity,
    steps: nodeStatesRepository.listForRun(db, runId).map((state) => ({
      nodeId: state.nodeId,
      label: labels.get(state.nodeId) ?? state.nodeId,
      // A step journaled as running on a run that is over did not finish. Left
      // as "running" it reads as still working, on a run that stopped minutes
      // ago.
      status: over && state.status === 'running' ? 'failed' : state.status,
    })),
  };
}

async function execute(runId: string, brief: RunBrief, resume: boolean): Promise<void> {
  const db = getStore();
  const cancellation = { cancelled: false };
  cancellations.set(runId, cancellation);

  const roles = createRoleRegistry(db).list();
  // Whatever folders the user has granted read access to, read fresh each run
  // so a revoke takes effect on the next one rather than the next restart.
  const sandbox = createSandbox(path.join(os.tmpdir(), 'chimera-runs'), runId, readableFolders());
  const tools = createToolRegistry({ secrets: () => [...pluginSecrets(), ...emailSecrets()] });
  await tools.registerServer(
    'filesystem',
    await connectInProcess(
      createFilesystemServer(sandbox, {
        ...(brief.maxFileBytes === undefined ? {} : { maxReadBytes: brief.maxFileBytes }),
      }),
    ),
  );
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
    await connectInProcess(
      createHttpServer({
        egressAllowlist: brief.egressAllowlist ?? [],
        egressMode: brief.egressMode ?? 'browse',
        ...(brief.maxPageChars === undefined ? {} : { maxPageChars: brief.maxPageChars }),
      }),
    ),
  );

  // Search, alongside the fetcher rather than inside it: finding a page and
  // sending to one are different permissions, and a role can now be given the
  // first without the second.
  //
  // The key is read here and handed to the server as a value. It goes no
  // further: the server puts it in a request header, and nothing that comes
  // back to the model has been anywhere near it.
  const searchSettings = settingsRepository.read(db).search;
  let searchKey = '';
  if (searchSettings.provider !== 'none' && searchSettings.authRef !== '') {
    try {
      searchKey = getSecret(searchSettings.authRef as AuthRef) ?? '';
    } catch {
      // A key the keychain will not give back is a key this run does not have.
      // Search falls back to the keyless engines rather than the run failing
      // over a setting that is only ever an improvement.
      searchKey = '';
    }
  }
  await tools.registerServer(
    'search',
    await connectInProcess(
      createSearchServer({
        egressMode: brief.egressMode ?? 'browse',
        provider: searchSettings.provider,
        ...(searchKey === '' ? {} : { apiKey: searchKey }),
        ...(searchSettings.region === '' ? {} : { region: searchSettings.region }),
      }),
    ),
  );

  // Composio, when the workspace has a key for it. Registered unconditionally —
  // the backend answers every call with "not connected here" when it has none,
  // which is a message an agent can read and act on, where a missing server
  // means it is told it has no tools at all.
  await tools.registerServer(
    'composio',
    await connectInProcess(createComposioServer(composioBackend())),
  );

  // And one server per connected app, so an App operator can be pointed at a
  // single one of them.
  //
  // The same arrangement as the mailboxes below, for the same reason: an agent
  // is granted *an account*, not a category. A step that triages support mail
  // and a step that posts release notes should not both be able to reach both,
  // and the way that is made true rather than merely asked for is that the one
  // holding `composio-slack` has no Gmail tool in its list at all.
  //
  // Only the connected ones. There are over a thousand apps and registering a
  // server for each would be a thousand servers to hold an agent's attention;
  // an app nobody has signed into has nothing to offer anyway.
  for (const slug of await connectedToolkitSlugs()) {
    try {
      await tools.registerServer(
        serverIdForApp(slug),
        await connectInProcess(createComposioServer(composioBackend([slug]), slug)),
      );
    } catch {
      // A duplicate id or a server that would not start is one app an
      // operator cannot be narrowed to. The unscoped `composio` above still
      // works, so the run goes ahead.
    }
  }

  // Every mailbox the workspace holds, each under its own server id so an
  // agent is granted one account rather than "email". A workspace with two
  // mailboxes gets `email-<id>.send` twice over, and a role's allowlist says
  // which — the alternative being an agent told to handle support mail that
  // can also send from the founder's personal address.
  for (const account of listAccounts().accounts) {
    try {
      const { record, password } = credentialsFor(account.id);
      const { createMailTransport } = await import('../email/transport.ts');
      await tools.registerServer(
        serverIdForAccount(account.id),
        await connectInProcess(createEmailServer(createMailTransport(record, password))),
      );
    } catch {
      // A mailbox whose password will not read is a mailbox this run does not
      // have. The account panel is where that is diagnosed; a run that refused
      // to start over it would be worse than one that runs without it.
    }
  }

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
        egressMode: brief.egressMode ?? 'browse',
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
    // What the providers themselves publish, over the static matrix. Without
    // this an OpenRouter model prices as `unknown`, and the Governor will not
    // enforce a spend cap on a price nobody verified — so a run on any of the
    // four hundred models it routes to had no budget at all.
    capabilitiesFor: capabilitiesLookup(),
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

  const activityReader = createActivityReader();

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
      // The live feed the run window reads. Most trace events are machinery and
      // become nothing; the ones that survive are what a person would say the
      // agent is doing.
      // A swarm inside an automation makes a thread in the Swarm section rather
      // than burying its transcript in a step's output. The trace records the
      // thread id, which is what the button on the node uses to get there.
      runSwarmNode: async (input) => {
        // A swarm runs on the workspace's standard tier rather than on a model
        // chosen per node: a population of three hundred on a frontier model is
        // a bill nobody meant to run up. An unset tier is said plainly here —
        // the alternative was a throw from `connectionFor('')` that left the
        // step spinning with nothing on screen to explain it.
        if (tiers.standard.connectionId === '' || tiers.standard.model === '') {
          throw new Error(
            'A swarm runs on the "standard" tier, and this workspace has not said which model that is. Set it in Providers.',
          );
        }

        const asked = await askSwarm({
          question: input.question,
          source: input.runId,
          settings: {
            connectionId: tiers.standard.connectionId,
            model: tiers.standard.model,
            population: input.population,
            maxRounds: input.maxRounds,
            everyoneUpTo: input.everyoneUpTo,
          },
        });
        return {
          threadId: asked.threadId,
          answer: asked.turn.answer,
          population: asked.turn.result?.population ?? 0,
          mode: asked.turn.result?.mode ?? 'archetypes',
        };
      },
      onTraceEvent: (event) => {
        const activity = activityReader.read(event);
        if (activity !== null) emitRunEvent(runId, 'activity', activity);
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
    // Kept, not only broadcast. A window that opens while the run is already
    // over — which is every window, when the run takes four seconds — has to be
    // able to ask what happened.
    runsRepository.setOutput(db, runId, outcome.output);
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
