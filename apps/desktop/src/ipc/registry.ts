import { z } from 'zod';

/**
 * The provider kinds, duplicated here rather than imported from
 * `@chimera/providers`.
 *
 * This module is imported by preload.ts, which runs sandboxed with no Node
 * integration. Importing the providers package pulls in `@chimera/store` and
 * through it `@napi-rs/keyring`'s native `.node` binary, which the preload
 * bundler cannot even parse — the build fails outright. That is the same
 * boundary the registry/handler split exists to protect, reached by a new path.
 *
 * A duplicated list can drift, so it is not left to vigilance:
 * `registry.test.ts` asserts this array equals `PROVIDER_KINDS` exactly, and
 * `scripts/check-package-boundaries.mjs` fails the build if this file ever
 * imports the providers or store package again.
 */
const PROVIDER_KINDS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'omniroute',
  'ollama',
  'ollama-cloud',
  'lmstudio',
  'openai-compatible',
] as const;
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

// Mirrors NodeConfig in @chimera/core. Restated rather than imported because
// preload.ts bundles this file and must not reach into a workspace package that
// pulls native modules with it.
const conditionSchema = z.object({
  source: z.string(),
  test: z.enum(['contains', 'equals', 'matches', 'isEmpty', 'notEmpty']),
  value: z.string(),
  whenTrue: z.array(z.string()),
  whenFalse: z.array(z.string()),
});

const nodeConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent') }),
  z.object({ type: z.literal('condition'), condition: conditionSchema }),
  z.object({
    type: z.literal('loop'),
    loop: z.object({
      body: z.array(z.string()),
      maxIterations: z.number(),
      until: conditionSchema.optional(),
    }),
  }),
  z.object({ type: z.literal('transform'), transform: z.object({ template: z.string() }) }),
  z.object({
    type: z.literal('approval'),
    approval: z.object({ prompt: z.string(), showSource: z.string() }),
  }),
]);

const briefSchema = z.object({
  name: z.string(),
  instruction: z.string(),
  attachments: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      kind: z.enum(['text', 'image', 'binary']),
      content: z.string(),
      note: z.string(),
    }),
  ),
  steps: z.array(
    z.object({
      nodeId: z.string(),
      // Absent means `agent`, which is every brief saved before the other node
      // types existed. Adding an optional field is a v-compatible change.
      type: z.enum(['agent', 'condition', 'loop', 'transform', 'approval']).optional(),
      config: nodeConfigSchema.optional(),
      roleId: z.string(),
      instruction: z.string(),
      connectionId: z.string(),
      model: z.string(),
    }),
  ),
  edges: z.array(z.tuple([z.string(), z.string()])),
  // Where each node sits on the canvas. Not part of the run, but part of what
  // the user arranged — and a schema that silently dropped it made every reopen
  // rearrange the graph into a column.
  layout: z.array(z.object({ nodeId: z.string(), x: z.number(), y: z.number() })).optional(),
});

export const workflowSave = defineInvokeChannel({
  channel: 'workflow:save',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    id: z.string().optional(),
    name: z.string(),
    definition: briefSchema,
  }),
  responseSchema: z.object({ id: z.string(), versionId: z.string(), version: z.number() }),
});

export const workflowList = defineInvokeChannel({
  channel: 'workflow:list',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ status: z.string().optional() }),
  responseSchema: z.object({
    workflows: z.array(z.object({ id: z.string(), name: z.string(), updatedAt: z.string() })),
  }),
});

export const workflowGet = defineInvokeChannel({
  channel: 'workflow:get',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    id: z.string(),
    version: z.union([z.string(), z.number()]).optional(),
  }),
  responseSchema: z.object({
    id: z.string(),
    name: z.string(),
    version: z.number(),
    definition: briefSchema,
  }),
});

export const runStart = defineInvokeChannel({
  channel: 'run:start',
  // v2: takes the canvas's brief directly. v1 took a `workflowVersionId` for
  // saved workflows, which do not exist yet — M4-9 brings them back and this
  // channel gains the id alongside the brief rather than instead of it.
  v: 2,
  sensitive: false,
  requestSchema: z.object({ brief: briefSchema }),
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

// The approval gate's renderer half. The run pauses in main until this
// arrives; nothing about the answer is inferred from a closed window, because
// CLAUDE.md's rule is that an irreversible action needs a person, and a person
// who never answered has not approved.
export const runApprove = defineInvokeChannel({
  channel: 'run:approve',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    runId: z.string(),
    nodeId: z.string(),
    approved: z.boolean(),
    note: z.string(),
  }),
  responseSchema: z.object({ accepted: z.boolean() }),
});

export const providerTestConnection = defineInvokeChannel({
  channel: 'provider:testConnection',
  v: 2,
  sensitive: false,
  requestSchema: z.object({ connectionId: z.string() }),
  responseSchema: z.object({
    ok: z.boolean(),
    latencyMs: z.number(),
    detail: z.string().optional(),
  }),
});

export const connectionCreate = defineInvokeChannel({
  channel: 'connection:create',
  // v2: `kind` narrowed to the real provider union and the response widened to
  // the created row's fields when the handler landed in M1-10. CLAUDE.md —
  // changing a field needs a version bump.
  v: 2,
  sensitive: true, // carries the raw key before it is exchanged for a vault handle
  requestSchema: z.object({
    label: z.string().min(1),
    kind: z.enum(PROVIDER_KINDS),
    baseUrl: z.string().optional(),
    inlineKey: z.string().optional(),
  }),
  responseSchema: z.object({ id: z.string(), label: z.string(), kind: z.string() }),
});

export const connectionSummary = z.object({
  // Added in the M1-7 follow-up: the imported catalogue was being stored and
  // never shown, so a connection with 211 models looked identical to one with
  // none. Additive, so no version bump.
  models: z.array(z.string()).default([]),
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  baseUrl: z.string().nullable(),
  healthState: z.string(),
});

export const connectionList = defineInvokeChannel({
  channel: 'connection:list',
  // v2: the response shape went from `unknown[]` to a real summary in M1-10.
  // Deliberately carries no authRef — the renderer has no use for a vault
  // handle and giving it one would put a credential reference on a channel
  // flagged non-sensitive.
  v: 2,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({
    connections: z.array(connectionSummary),
    localOnlyMode: z.boolean(),
    // Additive in M1-11 (CLAUDE.md: "adding a field is fine"). The renderer
    // needs the kind list to offer it in the connection form, and deriving it
    // here rather than duplicating PROVIDER_KINDS in apps/ui keeps one answer.
    kinds: z.array(z.string()),
  }),
});

/**
 * Runs one health sweep and returns the result.
 *
 * Renderer-driven rather than a timer in main: the status bar is the only
 * consumer, a window that is closed needs no probing, and a pull keeps the
 * probe cadence visible in one place instead of split across processes.
 */
export const healthSweep = defineInvokeChannel({
  channel: 'health:sweep',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({
    connections: z.array(connectionSummary),
  }),
});

// M2-10's workspace facts. The minimal editing surface the ticket asks for:
// the renderer can list, write and delete, which is what makes the tier
// "user-editable" rather than a store only agents can reach.
const workspaceFact = z.object({
  key: z.string(),
  value: z.string(),
  source: z.string(),
  updatedAt: z.string(),
});

export const memoryListFacts = defineInvokeChannel({
  channel: 'memory:listFacts',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({ facts: z.array(workspaceFact) }),
});

export const memorySetFact = defineInvokeChannel({
  channel: 'memory:setFact',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ key: z.string(), value: z.string() }),
  responseSchema: z.object({ fact: workspaceFact }),
});

export const memoryDeleteFact = defineInvokeChannel({
  channel: 'memory:deleteFact',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ key: z.string() }),
  responseSchema: z.object({ removed: z.boolean() }),
});

// M3-3's cost preview. Available before run:start — the whole point is to know
// what a run will cost while it is still possible not to start it.
export const runCostPreview = defineInvokeChannel({
  channel: 'run:costPreview',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    itemCount: z.number().int().positive().optional(),
    concurrency: z.number().int().positive().optional(),
    nodes: z.array(
      z.object({
        id: z.string(),
        model: z.string(),
        maxIterations: z.number().int().positive(),
        expectedInputTokensPerIteration: z.number().nonnegative(),
        expectedOutputTokensPerIteration: z.number().nonnegative(),
        expectedMsPerIteration: z.number().nonnegative().optional(),
        budget: z
          .object({
            maxTokens: z.number().nullable(),
            maxCostUsd: z.number().nullable(),
          })
          .optional(),
      }),
    ),
  }),
  responseSchema: z.object({
    itemCount: z.number(),
    totalTokens: z.number(),
    totalCostUsd: z.number().nullable(),
    pricedCostUsd: z.number(),
    unpricedModels: z.array(z.string()),
    estimatedMs: z.number(),
    summary: z.string(),
    perNode: z.array(
      z.object({
        nodeId: z.string(),
        model: z.string(),
        tokens: z.number(),
        costUsd: z.number().nullable(),
        estimatedMs: z.number(),
        cappedByBudget: z.boolean(),
      }),
    ),
  }),
});

// The agent roster the automation builder offers. Real roles from the role
// registry (M2-5), not a hardcoded list in the renderer — a palette that
// disagreed with what the runtime will actually execute is worse than none.
export const roleList = defineInvokeChannel({
  channel: 'role:list',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({
    roles: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        systemPrompt: z.string(),
        toolAllowlist: z.array(z.string()),
        tier: z.string(),
        maxIterations: z.number(),
        maxCostUsd: z.number().nullable(),
      }),
    ),
  }),
});

// Attachments for an automation brief: the OS picker, and the text read out of
// what came back. Paths are the user's own choice, so this is not an egress
// surface — but the content is untrusted the moment it reaches a prompt, and
// M2-6's envelope is what handles that.
export const filesPick = defineInvokeChannel({
  channel: 'files:pick',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ mode: z.enum(['files', 'folder']) }),
  responseSchema: z.object({
    truncated: z.boolean(),
    attachments: z.array(
      z.object({
        path: z.string(),
        name: z.string(),
        kind: z.enum(['text', 'image', 'binary']),
        bytes: z.number(),
        content: z.string(),
        note: z.string(),
      }),
    ),
  }),
});

// "Describe what you want automated" → a draft built from the real roster.
export const automationPlan = defineInvokeChannel({
  channel: 'automation:plan',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    connectionId: z.string(),
    model: z.string(),
    description: z.string(),
  }),
  responseSchema: z.object({
    name: z.string(),
    summary: z.string(),
    steps: z.array(z.object({ roleId: z.string(), instruction: z.string() })),
  }),
});

const memoryRecord = z.object({
  id: z.string(),
  kind: z.string(),
  subject: z.string(),
  body: z.string(),
  source: z.string(),
  runId: z.string().nullable(),
  confidence: z.number(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const memoryList = defineInvokeChannel({
  channel: 'memory:list',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ query: z.string().optional() }),
  responseSchema: z.object({
    memories: z.array(memoryRecord),
    counts: z.record(z.string(), z.number()),
    backend: z.object({
      name: z.string(),
      available: z.boolean(),
      detail: z.string(),
    }),
  }),
});

export const memoryWrite = defineInvokeChannel({
  channel: 'memory:write',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    kind: z.string(),
    subject: z.string(),
    body: z.string(),
    tags: z.array(z.string()).optional(),
  }),
  responseSchema: z.object({ memory: memoryRecord }),
});

export const memoryForget = defineInvokeChannel({
  channel: 'memory:forget',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ id: z.string() }),
  responseSchema: z.object({ removed: z.boolean() }),
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
/**
 * Starts a streamed completion. Resolves as soon as the request is accepted;
 * the tokens arrive as `chat:delta` events keyed by the returned streamId.
 *
 * Split this way because Electron's invoke/handle is request/response and
 * cannot yield — a single invoke that resolved with the whole answer would
 * defeat the point of streaming, which is that the user sees the first token
 * immediately rather than after the last one.
 */
export const chatSend = defineInvokeChannel({
  channel: 'chat:send',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    connectionId: z.string(),
    model: z.string(),
    prompt: z.string().min(1),
  }),
  responseSchema: z.object({ streamId: z.string() }),
});

/**
 * Prices a completed exchange.
 *
 * Lives in main rather than the renderer because the capability matrix is the
 * single source of truth for a model's rate, and duplicating that table into
 * the renderer bundle would create two answers to the same question — one of
 * which would eventually be stale.
 */
export const chatEstimateCost = defineInvokeChannel({
  channel: 'chat:estimateCost',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    model: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
  // Nullable, not zero: a model with no verified price is not free (M1-3).
  responseSchema: z.object({ cost: z.number().nullable() }),
});

/** F1.5 detection. Never rejects for "not installed" — that is a normal answer. */
export const omnirouteDetect = defineInvokeChannel({
  channel: 'omniroute:detect',
  // v2: carries an optional API key, for an OmniRoute configured to require
  // one. Sensitive from here on — the payload holds a credential.
  v: 2,
  sensitive: true,
  requestSchema: z.object({ baseUrl: z.string().optional(), apiKey: z.string().optional() }),
  responseSchema: z.object({
    state: z.enum(['detected', 'not-detected']),
    baseUrl: z.string(),
    modelCount: z.number(),
  }),
});

export const omnirouteImport = defineInvokeChannel({
  channel: 'omniroute:import',
  v: 2,
  sensitive: true,
  requestSchema: z.object({ baseUrl: z.string().optional(), apiKey: z.string().optional() }),
  responseSchema: z.object({
    connectionId: z.string(),
    modelCount: z.number(),
    created: z.boolean(),
  }),
});

export const chatDelta = defineEventChannel({
  channel: 'chat:delta',
  v: 1,
  sensitive: false,
  payloadSchema: z.object({
    streamId: z.string(),
    // Discriminated so the renderer never has to guess which fields are set.
    type: z.enum(['start', 'text', 'finish', 'error']),
    text: z.string().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    finishReason: z.string().optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
  }),
});

const ALL_CHANNELS: ChannelDefinition[] = [
  workflowSave,
  workflowList,
  workflowGet,
  runStart,
  runCancel,
  runSubscribe,
  runApprove,
  runEvent,
  providerTestConnection,
  connectionCreate,
  connectionList,
  healthSweep,
  roleList,
  filesPick,
  automationPlan,
  runCostPreview,
  memoryListFacts,
  memoryList,
  memoryWrite,
  memoryForget,
  memorySetFact,
  memoryDeleteFact,
  vaultSetSecret,
  vaultHasSecret,
  licenceActivate,
  licenceStatus,
  templateImport,
  evalRun,
  chatSend,
  chatEstimateCost,
  omnirouteDetect,
  omnirouteImport,
  chatDelta,
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
