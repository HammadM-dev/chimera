// Main-process only. Never import this from preload.ts — the whole point of
// the registry/handler split is that a handler's imports (here: packages/store,
// and through it better-sqlite3 and @napi-rs/keyring) stay out of the
// sandboxed preload bundle. See the header comment on registry.ts.
import { setSecret, getSecret, type AuthRef } from '@chimera/store';
import {
  importCatalogue as importConnectionCatalogue,
  createConnection,
  estimateCost,
  removeConnection,
  listConnections,
  startChat,
  sweepHealth,
  testConnection,
  getTiers,
  setTiers,
  getCachePolicy,
  setCachePolicy,
  getTelemetry,
  setTelemetry,
  getSearch,
  setSearch,
} from '../providers/service.ts';
import { detect, importCatalogue } from '../providers/omniroute.ts';
import {
  deleteFact,
  forgetMemory,
  listFacts,
  listMemories,
  setFact,
  writeMemory,
} from '../memory/service.ts';
import { previewCost } from '../providers/costPreview.ts';
import { subscribe } from '../runs/subscriptions.ts';
import {
  answerApproval,
  awaitingApprovals,
  cancelRun,
  runSnapshot,
  startRun,
} from '../runs/service.ts';
import { exportTrace, listFailures, listRuns, listTrace } from '../runs/history.ts';
import { readScreenshot } from '../runs/screenshots.ts';
import { costSummary } from '../runs/costs.ts';
import { exportRun } from '../runs/otel.ts';
import { controlSession, grantControl, panic, revokeControl } from '../control/session.ts';
import { panicKeyAccelerator } from '../control/panicKey.ts';
import { runEvals, tagProduction } from '../evals/service.ts';
import { listTriggers } from '../triggers/service.ts';
import { listRoles, removeRole, saveRole } from '../roles/service.ts';
import {
  listPlugins,
  listTools,
  removePlugin,
  savePlugin,
  testPlugin,
} from '../plugins/service.ts';
import { pickAttachments, pickDirectory } from '../files/service.ts';
import { planAutomation } from '../automations/planner.ts';
import {
  checkAutomation,
  getAutomation,
  listAutomations,
  removeAutomation,
  saveAutomation,
} from '../automations/store.ts';
import { registerHandler } from './types.ts';
import type { InvokeChannelDefinition } from './types.ts';
import * as channels from './registry.ts';
import { grantFolder, listGrants, revokeFolder } from '../files/grants.ts';
import { readProfile, updateProfile, type Profile } from '../settings/profile.ts';
import { listTemplates } from '../templates/service.ts';
import { saveArtifact } from '../runs/artifacts.ts';
import { askAssistant } from '../chat/assistant.ts';
import { listAccounts, removeAccount, saveAccount, testAccount } from '../email/service.ts';

// Most channels are still stubs: real business logic arrives with the
// milestone that owns each domain (M1 providers, M2 runtime, M4 workflow
// engine). Registered rather than omitted so an unimplemented channel fails
// with a clear "not implemented" rather than looking unregistered, which
// means something different and is worth telling apart.
function stub<TReq, TRes>(def: InvokeChannelDefinition<TReq, TRes>): void {
  registerHandler(def, () => {
    throw new Error(`${def.channel}: not implemented until its owning milestone lands`);
  });
}

stub(channels.licenceActivate);
stub(channels.licenceStatus);
stub(channels.templateImport);
stub(channels.evalRun);

// vault:setSecret and vault:hasSecret are real as of M0-11 — the milestone's
// exit criterion is that the app stores a secret in the OS keychain and reads
// it back.
//
// This is the one channel that carries a raw secret value, which is why it is
// flagged `sensitive: true` in the registry and its payload is redacted before
// it reaches a log line (ipc/logging.ts). The value stops here: what goes back
// to the renderer is the vault handle, and nothing ever returns the value
// itself over IPC. CLAUDE.md: "Agents receive handles, not values."
registerHandler(channels.vaultSetSecret, (payload) => ({
  handle: setSecret(payload.scope, payload.value),
}));

// Deliberately "has", not "get". There is no IPC channel that reads a secret
// value back out of the vault, and there should not be one — the renderer's
// legitimate need is to know whether a credential is still present, which this
// answers without the value crossing a process boundary.
registerHandler(channels.vaultHasSecret, (payload) => ({
  exists: getSecret(payload.handle as AuthRef) !== undefined,
}));

// M1-10: the provider channels the chat panel drives. `connection:create` is
// the one channel that carries a raw key, which is why it is flagged
// `sensitive` in the registry — its payload is redacted before it reaches a log
// line, and the key is exchanged for a vault handle inside createConnection()
// and never returned.
registerHandler(channels.connectionCreate, async (payload) => {
  const created = createConnection(payload);
  // The catalogue, immediately. A connection with no models reaches the picker
  // as a text box and the canvas as a step that cannot be bound — it works and
  // looks broken. Failure here is swallowed: the connection is real either way,
  // and a provider with no catalogue endpoint is still usable by typing a name.
  try {
    await importConnectionCatalogue(created.id);
  } catch {
    // Left without a catalogue rather than left uncreated.
  }
  return created;
});
registerHandler(channels.connectionList, () => listConnections());
registerHandler(channels.providerTestConnection, (payload) => testConnection(payload.connectionId));
registerHandler(channels.chatSend, (payload, context) => startChat(context.webContents, payload));
registerHandler(channels.healthSweep, () => sweepHealth());

registerHandler(channels.runCostPreview, (payload) => previewCost(payload));

// M3-4: the renderer asks to watch a run, and receives `run:event` pushes for
// it. Subscription is per WebContents, so a second window watching a different
// run does not receive this one's events.
registerHandler(channels.runSubscribe, (payload, context) => ({
  ...subscribe(payload.runId, context.webContents),
  snapshot: runSnapshot(payload.runId),
}));

registerHandler(channels.runStart, async (payload, context) => {
  const started = await startRun(payload.brief, 'manual', context.webContents);
  // The monitor opens once the run has an id, and subscribes itself. Opening
  // it earlier would give it nothing to watch.
  //
  // Its failure is never the run's failure: the run is already going, and
  // reporting "could not start" because a window would not open would be a
  // lie about the thing the user actually asked for.
  try {
    // Imported here rather than at module scope. `windows.ts` imports
    // `electron` at its top, and everything reachable from this file must load
    // under plain `node --test` — the same trap `store/lifecycle.ts` hit at
    // M1-10, `files/service.ts` at M4-11 and `control/panicKey.ts` at M8-3,
    // documented in all three and walked into a fourth time here.
    const { openRunWindow } = await import('../windows.ts');
    openRunWindow(started.runId, payload.brief.name ?? '');
  } catch {
    // Watched from the canvas instead, which is where it was watched before
    // this window existed.
  }
  return started;
});
registerHandler(channels.runCancel, (payload) => cancelRun(payload.runId));
registerHandler(channels.runApprove, (payload) => answerApproval(payload));
registerHandler(channels.runAwaiting, () => awaitingApprovals());
registerHandler(channels.runList, (payload) => listRuns(payload.limit));
registerHandler(channels.traceList, (payload) => listTrace(payload.runId));
registerHandler(channels.runFailures, (payload) => listFailures(payload.runId));
registerHandler(channels.runCosts, (payload) => costSummary(payload.days));
registerHandler(channels.evalsRun, (payload) => runEvals(payload.workflowId));
registerHandler(channels.evalsTagProduction, (payload) => tagProduction(payload.workflowId));
registerHandler(channels.traceScreenshot, (payload) => readScreenshot(payload.runId, payload.name));
registerHandler(channels.tiersGet, () => getTiers());
registerHandler(channels.tiersSet, (payload) => setTiers(payload.tiers));
registerHandler(channels.cacheGet, () => getCachePolicy());
registerHandler(channels.cacheSet, (payload) => setCachePolicy(payload.policy));
registerHandler(channels.telemetryGet, () => getTelemetry());
registerHandler(channels.telemetrySet, (payload) => setTelemetry(payload.telemetry));
registerHandler(channels.telemetryTest, (payload) => exportRun(payload.runId));
/**
 * The profile minus the parts the renderer has no business seeing.
 *
 * `installId` and `lastReportedAt` belong to the ping, which is sent from main.
 * A renderer that could read the install id could put it in a prompt.
 */
function publicProfile(profile: Profile): {
  firstName: string;
  lastName: string;
  theme: 'dark' | 'light';
  usageStats: boolean;
  onboarded: boolean;
} {
  return {
    firstName: profile.firstName,
    lastName: profile.lastName,
    theme: profile.theme,
    usageStats: profile.usageStats,
    onboarded: profile.onboarded,
  };
}

registerHandler(channels.templateList, () => listTemplates());
registerHandler(channels.runSaveArtifact, (payload) => saveArtifact(payload));
registerHandler(channels.assistantAsk, (payload) => askAssistant(payload));
registerHandler(channels.profileGet, () => publicProfile(readProfile()));
registerHandler(channels.profileSet, (payload) => publicProfile(updateProfile(payload)));
registerHandler(channels.searchGet, () => getSearch());
registerHandler(channels.searchSet, (payload) => setSearch(payload));

registerHandler(channels.controlGet, () => ({
  session: controlSession(),
  panicKey: panicKeyAccelerator(),
}));
registerHandler(channels.controlGrant, (payload) => ({
  session: grantControl({ reason: payload.reason, dryRun: payload.dryRun }),
}));
registerHandler(channels.controlRevoke, () => ({ session: revokeControl() }));
registerHandler(channels.controlPanic, () => panic());
registerHandler(channels.traceExport, (payload) => exportTrace(payload.runId));

registerHandler(channels.workflowSave, (payload) =>
  saveAutomation({
    ...(payload.id === undefined ? {} : { id: payload.id }),
    name: payload.name,
    definition: payload.definition,
  }),
);
registerHandler(channels.workflowList, () => listAutomations());
registerHandler(channels.workflowGet, (payload) => getAutomation(payload.id));

registerHandler(channels.roleList, () => listRoles());
registerHandler(channels.roleSave, (payload) => saveRole(payload));
registerHandler(channels.roleRemove, (payload) => removeRole(payload.id));
registerHandler(channels.toolList, () => listTools());
registerHandler(channels.pluginList, () => listPlugins());
registerHandler(channels.pluginSave, (payload) => savePlugin(payload));
registerHandler(channels.pluginRemove, (payload) => removePlugin(payload.id));
registerHandler(channels.pluginTest, (payload) => testPlugin(payload.id));
registerHandler(channels.filesPick, (payload) => pickAttachments(payload.mode));
registerHandler(channels.filesPickDirectory, () => pickDirectory());

// Granting is one gesture: the OS folder picker, then the grant. Splitting it
// into "choose" and "confirm" would give the user two chances to say yes to
// the same thing, which reads as a warning rather than a permission.
registerHandler(channels.fileGrantList, () => listGrants());
registerHandler(channels.fileGrantAdd, async () => {
  const picked = await pickDirectory();
  if (picked.path === '') return { granted: false, reason: '' };
  return grantFolder(picked.path);
});
registerHandler(channels.fileGrantRevoke, (payload) => revokeFolder(payload.path));

registerHandler(channels.workflowRemove, (payload) => removeAutomation(payload.id));
registerHandler(channels.connectionRemove, (payload) => removeConnection(payload.id));
registerHandler(channels.emailAccountList, () => listAccounts());
registerHandler(channels.emailAccountSave, (payload) => saveAccount(payload));
registerHandler(channels.emailAccountRemove, (payload) => removeAccount(payload.id));
registerHandler(channels.emailAccountTest, (payload) => testAccount(payload.id));
registerHandler(channels.triggerList, () => listTriggers());
registerHandler(channels.automationPlan, (payload) => planAutomation(payload));
registerHandler(channels.automationCheck, (payload) => checkAutomation(payload.definition));

registerHandler(channels.memoryList, (payload) => listMemories(payload.query));
registerHandler(channels.memoryWrite, (payload) => writeMemory(payload));
registerHandler(channels.memoryForget, (payload) => forgetMemory(payload.id));

registerHandler(channels.memoryListFacts, () => listFacts());
registerHandler(channels.memorySetFact, (payload) => setFact(payload.key, payload.value));
registerHandler(channels.memoryDeleteFact, (payload) => deleteFact(payload.key));

registerHandler(channels.omnirouteDetect, async (payload) => {
  const result = await detect(payload.baseUrl, payload.apiKey);
  return { state: result.state, baseUrl: result.baseUrl, modelCount: result.models.length };
});
registerHandler(channels.omnirouteImport, (payload) =>
  importCatalogue(payload.baseUrl, payload.apiKey),
);

registerHandler(channels.chatEstimateCost, (payload) => ({
  cost: estimateCost(payload.model, payload.inputTokens, payload.outputTokens),
}));
