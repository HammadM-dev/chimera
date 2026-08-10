// Main-process only. Never import this from preload.ts — the whole point of
// the registry/handler split is that a handler's imports (here: packages/store,
// and through it better-sqlite3 and @napi-rs/keyring) stay out of the
// sandboxed preload bundle. See the header comment on registry.ts.
import { setSecret, getSecret, type AuthRef } from '@chimera/store';
import {
  createConnection,
  estimateCost,
  listConnections,
  startChat,
  testConnection,
} from '../providers/service.ts';
import { registerHandler } from './types.ts';
import type { InvokeChannelDefinition } from './types.ts';
import * as channels from './registry.ts';

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

stub(channels.workflowSave);
stub(channels.workflowList);
stub(channels.workflowGet);
stub(channels.runStart);
stub(channels.runCancel);
stub(channels.runSubscribe);
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
registerHandler(channels.connectionCreate, (payload) => createConnection(payload));
registerHandler(channels.connectionList, () => listConnections());
registerHandler(channels.providerTestConnection, (payload) => testConnection(payload.connectionId));
registerHandler(channels.chatSend, (payload, context) => startChat(context.webContents, payload));
registerHandler(channels.chatEstimateCost, (payload) => ({
  cost: estimateCost(payload.model, payload.inputTokens, payload.outputTokens),
}));
