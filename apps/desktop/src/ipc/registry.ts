import { z } from 'zod';
import { defineInvokeChannel, defineEventChannel } from './types.ts';
import type { ChannelDefinition } from './types.ts';

// Schemas below are intentionally minimal stubs — the domain types they
// describe (Workflow, Run, ProviderConnection, ...) don't exist until the
// milestone that owns them (M1 providers, M2 runtime, M4 workflow engine).
// This registry exists in M0 to prove the dispatch/versioning/redaction
// mechanism end to end; each schema gets real shape when its domain lands.
// See docs/ARCHITECTURE.md section 4 for the channel table this mirrors —
// keep the two in sync.
//
// Every entry goes through defineInvokeChannel/defineEventChannel, not a
// bare object literal — see the comment on those functions in types.ts for
// why that's load-bearing, not stylistic.
//
// This module holds definitions only, never handlers. preload.ts imports it,
// and preload runs sandboxed with no Node integration — a handler defined
// here would pull its own imports into the preload bundle, and the first real
// one reaches native modules that cannot load there at all. Handlers live in
// handlers.ts, which only the main process imports.

export const workflowSave = defineInvokeChannel({
  channel: 'workflow:save',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ id: z.string().optional(), definition: z.unknown() }),
  responseSchema: z.object({ id: z.string(), version: z.number() }),
});

export const workflowList = defineInvokeChannel({
  channel: 'workflow:list',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ status: z.string().optional() }),
  responseSchema: z.object({ workflows: z.array(z.unknown()) }),
});

export const workflowGet = defineInvokeChannel({
  channel: 'workflow:get',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    id: z.string(),
    version: z.union([z.string(), z.number()]).optional(),
  }),
  responseSchema: z.object({ workflow: z.unknown() }),
});

export const runStart = defineInvokeChannel({
  channel: 'run:start',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ workflowVersionId: z.string(), input: z.unknown() }),
  responseSchema: z.object({ runId: z.string() }),
});

export const runCancel = defineInvokeChannel({
  channel: 'run:cancel',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ runId: z.string() }),
  responseSchema: z.object({ accepted: z.boolean() }),
});

export const runSubscribe = defineInvokeChannel({
  channel: 'run:subscribe',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ runId: z.string() }),
  responseSchema: z.object({ subscribed: z.boolean() }),
});

export const runEvent = defineEventChannel({
  channel: 'run:event',
  v: 1,
  sensitive: false,
  payloadSchema: z.object({ runId: z.string(), type: z.string(), data: z.unknown() }),
});

export const providerTestConnection = defineInvokeChannel({
  channel: 'provider:testConnection',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ connectionId: z.string() }),
  responseSchema: z.object({ ok: z.boolean(), latencyMs: z.number().optional() }),
});

export const connectionCreate = defineInvokeChannel({
  channel: 'connection:create',
  v: 1,
  sensitive: true, // may carry an inline raw key before it's exchanged for a vault handle
  requestSchema: z.object({
    label: z.string(),
    kind: z.string(),
    baseUrl: z.string().optional(),
    inlineKey: z.string().optional(),
  }),
  responseSchema: z.object({ id: z.string() }),
});

export const connectionList = defineInvokeChannel({
  channel: 'connection:list',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({ connections: z.array(z.unknown()) }),
});

export const vaultSetSecret = defineInvokeChannel({
  channel: 'vault:setSecret',
  // v2: `scope` narrowed from an open string to the vault's actual scope
  // union when the handler landed in M0-11. CLAUDE.md: "adding a field is
  // fine, changing one needs a version bump" — narrowing what a field accepts
  // is changing it, so this bumps even though v1 never had a working handler
  // for anything to depend on.
  v: 2,
  sensitive: true,
  requestSchema: z.object({ scope: z.enum(['connection', 'licence']), value: z.string() }),
  responseSchema: z.object({ handle: z.string() }),
});

export const vaultHasSecret = defineInvokeChannel({
  channel: 'vault:hasSecret',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ handle: z.string() }),
  responseSchema: z.object({ exists: z.boolean() }),
});

export const licenceActivate = defineInvokeChannel({
  channel: 'licence:activate',
  v: 1,
  sensitive: true,
  requestSchema: z.object({ token: z.string() }),
  responseSchema: z.object({ tier: z.string(), activatedAt: z.string() }),
});

export const licenceStatus = defineInvokeChannel({
  channel: 'licence:status',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({ tier: z.string(), graceExpiresAt: z.string().nullable() }),
});

export const templateImport = defineInvokeChannel({
  channel: 'template:import',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    source: z.union([z.literal('shipped'), z.literal('file')]),
    path: z.string(),
  }),
  responseSchema: z.object({ workflowId: z.string() }),
});

export const evalRun = defineInvokeChannel({
  channel: 'eval:run',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    workflowId: z.string(),
    provider: z.union([z.literal('mock'), z.literal('live')]),
  }),
  responseSchema: z.object({ passed: z.boolean(), results: z.array(z.unknown()) }),
});

// Widened to the erased union for storage: the definitions above keep their
// inferred request/response types so handlers.ts can be checked against them,
// but a registry holding them side by side needs one common type.
const ALL_CHANNELS: ChannelDefinition[] = [
  workflowSave,
  workflowList,
  workflowGet,
  runStart,
  runCancel,
  runSubscribe,
  runEvent,
  providerTestConnection,
  connectionCreate,
  connectionList,
  vaultSetSecret,
  vaultHasSecret,
  licenceActivate,
  licenceStatus,
  templateImport,
  evalRun,
];

export const CHANNEL_REGISTRY: ReadonlyMap<string, ChannelDefinition> = new Map(
  ALL_CHANNELS.map((def) => [def.channel, def]),
);

export function getChannel(name: string): ChannelDefinition | undefined {
  return CHANNEL_REGISTRY.get(name);
}

export function listChannels(): readonly ChannelDefinition[] {
  return ALL_CHANNELS;
}
