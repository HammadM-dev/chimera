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
  z.object({
    type: z.literal('subworkflow'),
    subworkflow: z.object({ workflowId: z.string(), version: z.string() }),
  }),
  z.object({
    type: z.literal('team'),
    team: z.object({
      goal: z.string(),
      orchestratorRoleId: z.string(),
      agents: z.array(z.object({ roleId: z.string(), instruction: z.string() })),
      maxRounds: z.number(),
      maxConcurrentAgents: z.number(),
      stallRounds: z.number(),
      goalPredicate: conditionSchema.optional(),
    }),
  }),
  z.object({
    type: z.literal('swarm'),
    swarm: z.object({
      question: z.string(),
      population: z.number(),
      maxRounds: z.number(),
      everyoneUpTo: z.number(),
    }),
  }),
  z.object({
    type: z.literal('aggregate'),
    aggregate: z.object({
      source: z.string(),
      strategy: z.enum(['concat', 'json_merge', 'reduce_with_agent', 'vote', 'template']),
      separator: z.string(),
      template: z.string(),
      roleId: z.string(),
      chunkSize: z.number(),
      instruction: z.string(),
    }),
  }),
  z.object({
    type: z.literal('fanout'),
    fanout: z.object({
      source: z.string(),
      parse: z.enum(['json', 'lines']),
      body: z.array(z.string()),
      concurrency: z.number(),
      maxItems: z.number(),
      onItemError: z.enum(['continue', 'halt']),
      deadLetterLimit: z.number(),
    }),
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
      type: z
        .enum([
          'agent',
          'condition',
          'loop',
          'transform',
          'approval',
          'subworkflow',
          'fanout',
          'aggregate',
          'team',
          'swarm',
        ])
        .optional(),
      config: nodeConfigSchema.optional(),
      // Set instead of connectionId/model, not alongside.
      tier: z.enum(['cheap', 'standard', 'frontier']).optional(),
      roleId: z.string(),
      instruction: z.string(),
      connectionId: z.string(),
      model: z.string(),
      // Which connected apps an App operator step may reach. Absent means all
      // of them, which is every automation saved before this existed.
      //
      // Named here rather than left to travel on its own: `z.object` drops any
      // key its schema does not list, silently and with no error at either
      // end. A field added to the canvas and not added here is stored, read
      // back, and thrown away at this boundary — which is exactly what
      // happened to the swarm graph, and it took a screenshot to find.
      apps: z.array(z.string()).optional(),
    }),
  ),
  edges: z.array(z.tuple([z.string(), z.string()])),
  // Golden cases this automation has to keep passing. They travel with the
  // file, so an automation somebody sends you arrives with its tests.
  evals: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        input: z.string(),
        scriptedAnswer: z.string(),
        assertions: z.array(
          z.object({
            path: z.string(),
            op: z.enum(['exists', 'equals', 'contains', 'matches', 'gte', 'lte', 'length']),
            value: z.string(),
          }),
        ),
      }),
    )
    .optional(),
  // What starts this automation when nobody presses Run.
  triggers: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('manual') }),
        z.object({ kind: z.literal('schedule'), cron: z.string() }),
        z.object({ kind: z.literal('webhook'), token: z.string() }),
        z.object({ kind: z.literal('fileWatch'), path: z.string() }),
        z.object({ kind: z.literal('folderDrop'), path: z.string() }),
      ]),
    )
    .optional(),
  // Hosts this automation's tools may reach. Empty means none.
  egressAllowlist: z.array(z.string()).optional(),
  egressMode: z.enum(['allowlist', 'browse', 'open']).optional(),
  maxPageChars: z.number().int().positive().optional(),
  // Steps whose author has agreed they may act irreversibly without a gate.
  preauthorised: z.array(z.string()).optional(),
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
  // The response carries what the watcher missed. Events are a live view and
  // nothing more, so a window that opens after a run has already finished —
  // which is every window, when the run takes four seconds — would otherwise
  // have nothing to show and no way to ask.
  responseSchema: z.object({
    subscribed: z.boolean(),
    //
    // Every field a handler returns has to be declared here or Zod strips it,
    // silently and with the call still succeeding. `label`, `startedAt` and
    // `endedAt` were added to the snapshot and not to this schema, so the
    // monitor showed a step with no name and a run that took no time.
    snapshot: z.object({
      status: z.string(),
      output: z.string(),
      errorSummary: z.string(),
      startedAt: z.string(),
      endedAt: z.string(),
      steps: z.array(z.object({ nodeId: z.string(), label: z.string(), status: z.string() })),
      // What each step did, replayed from the trace. A run that finished before
      // the window opened emitted its whole live feed to nobody; this is how
      // the window catches up.
      activity: z.array(
        z.object({
          nodeId: z.string(),
          at: z.number(),
          text: z.string(),
          kind: z.enum(['thinking', 'search', 'web', 'file', 'mail', 'tool', 'done', 'problem']),
          artifact: z
            .object({ path: z.string(), name: z.string(), bytes: z.number().nullable() })
            .optional(),
          image: z.string().optional(),
        }),
      ),
    }),
  }),
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

// Gates still open, including ones from before a restart. The renderer asks on
// mount: a run that stopped for a person and then vanished from the screen
// would be the one failure this mechanism cannot afford.
export const runAwaiting = defineInvokeChannel({
  channel: 'run:awaiting',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({
    waiting: z.array(
      z.object({
        runId: z.string(),
        nodeId: z.string(),
        prompt: z.string(),
        context: z.string(),
        live: z.boolean(),
      }),
    ),
  }),
});

// M4-7 and M4-8: what happened, and what it cost. The trace has been written
// since M2-11 with nothing to read it.
export const runList = defineInvokeChannel({
  channel: 'run:list',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ limit: z.number().optional() }),
  responseSchema: z.object({
    runs: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        status: z.string(),
        startedAt: z.string(),
        endedAt: z.string().nullable(),
        triggerType: z.string(),
        tokensUsed: z.number(),
        costUsd: z.number(),
        frontierCostUsd: z.number().nullable(),
        savedByCacheUsd: z.number(),
        errorSummary: z.string().nullable(),
      }),
    ),
  }),
});

export const traceList = defineInvokeChannel({
  channel: 'trace:list',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ runId: z.string() }),
  responseSchema: z.object({
    events: z.array(
      z.object({
        seq: z.number(),
        ts: z.string(),
        nodeId: z.string(),
        eventType: z.string(),
        payloadJson: z.string(),
        tokensIn: z.number().nullable(),
        tokensOut: z.number().nullable(),
        costUsd: z.number().nullable(),
      }),
    ),
  }),
});

// The failure report M5's exit criterion asks for: what could not be
// processed, and why, kept rather than counted.
export const runFailures = defineInvokeChannel({
  channel: 'run:failures',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ runId: z.string() }),
  responseSchema: z.object({
    failures: z.array(
      z.object({
        nodeId: z.string(),
        itemIndex: z.number(),
        itemJson: z.string(),
        error: z.string(),
        ts: z.string(),
      }),
    ),
  }),
});

// A screenshot the browser tool took, for the trace viewer. Returned as a data
// URL rather than a path: the renderer cannot read the disk, and it should not
// be able to.
// M9-4's cost dashboard: what this workspace spent, sliced four ways.
const costSliceSchema = z.object({
  key: z.string(),
  label: z.string(),
  costUsd: z.number(),
  tokens: z.number(),
  runs: z.number(),
});

export const runCosts = defineInvokeChannel({
  channel: 'run:costs',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ days: z.number().optional() }),
  responseSchema: z.object({
    sinceIso: z.string(),
    totalCostUsd: z.number(),
    totalTokens: z.number(),
    runCount: z.number(),
    byAutomation: z.array(costSliceSchema),
    byAgent: z.array(costSliceSchema),
    byModel: z.array(costSliceSchema),
    byDay: z.array(costSliceSchema),
  }),
});

// M9-2: run an automation's golden cases, and tag a version as trusted.
export const evalsRun = defineInvokeChannel({
  channel: 'evals:run',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ workflowId: z.string() }),
  responseSchema: z.object({
    workflowId: z.string(),
    passed: z.boolean(),
    untested: z.boolean(),
    outcomes: z.array(
      z.object({
        caseId: z.string(),
        name: z.string(),
        passed: z.boolean(),
        runProblem: z.string(),
        results: z.array(
          z.object({
            passed: z.boolean(),
            actual: z.string(),
            assertion: z.object({ path: z.string(), op: z.string(), value: z.string() }),
          }),
        ),
      }),
    ),
  }),
});

export const evalsTagProduction = defineInvokeChannel({
  channel: 'evals:tagProduction',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ workflowId: z.string() }),
  responseSchema: z.object({ tagged: z.boolean(), reason: z.string() }),
});

export const traceScreenshot = defineInvokeChannel({
  channel: 'trace:screenshot',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ runId: z.string(), name: z.string() }),
  responseSchema: z.object({ dataUrl: z.string() }),
});

export const traceExport = defineInvokeChannel({
  channel: 'trace:export',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ runId: z.string() }),
  responseSchema: z.object({ path: z.string(), events: z.number() }),
});

// Everything wrong with an automation, asked for while it is being edited.
// The same rules the save and run paths enforce, so the canvas cannot say a
// graph is fine and then have `run:start` refuse it.
export const automationCheck = defineInvokeChannel({
  channel: 'automation:check',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ definition: briefSchema }),
  responseSchema: z.object({
    problems: z.array(
      z.object({
        nodeId: z.string().nullable(),
        message: z.string(),
        stops: z.enum(['save', 'run']).optional(),
      }),
    ),
  }),
});

// M5-4's tier map: which connection and model this workspace calls cheap,
// standard and frontier. A workflow names a tier, so the same file runs for a
// buyer on hosted keys and a buyer running everything locally.
const tierBindingSchema = z.object({ connectionId: z.string(), model: z.string() });
const tierMapSchema = z.object({
  cheap: tierBindingSchema,
  standard: tierBindingSchema,
  frontier: tierBindingSchema,
});

export const tiersGet = defineInvokeChannel({
  channel: 'tiers:get',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({ tiers: tierMapSchema }),
});

export const tiersSet = defineInvokeChannel({
  channel: 'tiers:set',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ tiers: tierMapSchema }),
  responseSchema: z.object({ tiers: tierMapSchema }),
});

/**
 * The models this workspace keeps at the top of every picker.
 *
 * `connectionId::model` keys, in the order they were pinned. Order is the
 * user's rather than a sort — "the ones I use" is a list somebody curates.
 */
export const pinnedGet = defineInvokeChannel({
  channel: 'pinned:get',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({ pinned: z.array(z.string()) }),
});

export const pinnedSet = defineInvokeChannel({
  channel: 'pinned:set',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ pinned: z.array(z.string()) }),
  responseSchema: z.object({ pinned: z.array(z.string()) }),
});

// What is armed right now, and where to post for a webhook.
export const triggerList = defineInvokeChannel({
  channel: 'trigger:list',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({
    webhookPort: z.number(),
    triggers: z.array(
      z.object({
        workflowId: z.string(),
        name: z.string(),
        kind: z.enum(['manual', 'schedule', 'webhook', 'fileWatch', 'folderDrop']),
        detail: z.string(),
        url: z.string(),
      }),
    ),
  }),
});

// A folder to watch. Separate from `files:pick`, which reads files into a
// brief — this wants the folder itself, and reads nothing.
export const filesPickDirectory = defineInvokeChannel({
  channel: 'files:pickDirectory',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({ path: z.string() }),
});

// M9-3: whether this workspace reuses answers it has already paid for.
const cachePolicySchema = z.object({
  exact: z.boolean(),
  semantic: z.boolean(),
  threshold: z.number(),
  embeddingModel: z.string(),
  embeddingConnectionId: z.string(),
});

export const cacheGet = defineInvokeChannel({
  channel: 'cache:get',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({ policy: cachePolicySchema }),
});

export const cacheSet = defineInvokeChannel({
  channel: 'cache:set',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ policy: cachePolicySchema }),
  responseSchema: z.object({ policy: cachePolicySchema }),
});

// M9-5: where runs are exported, if anywhere.
const telemetrySchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string(),
  headersJson: z.string(),
  includePayloads: z.boolean(),
});

export const telemetryGet = defineInvokeChannel({
  channel: 'telemetry:get',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({ telemetry: telemetrySchema }),
});

export const telemetrySet = defineInvokeChannel({
  channel: 'telemetry:set',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ telemetry: telemetrySchema }),
  responseSchema: z.object({ telemetry: telemetrySchema }),
});

// The assistant on the home screen: one turn of conversation, with the whole
// workspace readable behind it. Goes through the Governor like every other
// agent — see `chat/assistant.ts` for why that is worth saying.
export const assistantAsk = defineInvokeChannel({
  channel: 'assistant:ask',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    connectionId: z.string(),
    model: z.string(),
    message: z.string(),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
  }),
  responseSchema: z.object({
    text: z.string(),
    // The design, when it designed one. `steps` and `edges` pass through as the
    // canvas's own shape rather than being re-declared here — this channel is a
    // courier for them, not an author.
    plan: z
      .object({
        name: z.string(),
        summary: z.string(),
        steps: z.unknown(),
        edges: z.unknown().optional(),
      })
      .nullable(),
    costUsd: z.number(),
    tokens: z.number(),
  }),
});

// Composio: one account per workspace, and the apps connected through it.
const composioStateSchema = z.object({
  enabled: z.boolean(),
  hasKey: z.boolean(),
  userId: z.string(),
});

export const composioGet = defineInvokeChannel({
  channel: 'composio:get',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: composioStateSchema,
});

export const composioSet = defineInvokeChannel({
  channel: 'composio:set',
  v: 1,
  // Carries an API key on the way in.
  sensitive: true,
  requestSchema: z.object({ enabled: z.boolean(), apiKey: z.string().optional() }),
  responseSchema: composioStateSchema,
});

/**
 * Which Composio tools fit a job, in plain words.
 *
 * The same call an agent makes through the MCP server, reachable from the
 * renderer so a person can check what exists before building an automation
 * around it — and so the live suite can assert on the one code path that
 * cannot be proved against a stand-in.
 */
export const composioSearch = defineInvokeChannel({
  channel: 'composio:search',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    query: z.string(),
    toolkits: z.array(z.string()).optional(),
  }),
  responseSchema: z.object({
    tools: z.array(
      z.object({
        slug: z.string(),
        toolkit: z.string(),
        description: z.string(),
        inputSchema: z.unknown(),
      }),
    ),
    toolkits: z.array(z.object({ toolkit: z.string(), connected: z.boolean(), note: z.string() })),
    guidance: z.array(z.string()),
    pitfalls: z.array(z.string()),
    reason: z.string(),
  }),
});

/** One connection's models, with price and capability for each. */
export const connectionCatalogue = defineInvokeChannel({
  channel: 'connection:catalogue',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ connectionId: z.string() }),
  responseSchema: z.object({
    models: z.array(
      z.object({
        id: z.string(),
        displayName: z.string(),
        vendor: z.string(),
        contextWindowTokens: z.number().nullable(),
        maxOutputTokens: z.number().nullable(),
        inputPerMillion: z.number().nullable(),
        outputPerMillion: z.number().nullable(),
        toolCalling: z.string(),
        vision: z.string(),
      }),
    ),
  }),
});

/** One app's logo, as data. See `toolkitLogo` for why it cannot be a URL. */
export const composioLogo = defineInvokeChannel({
  channel: 'composio:logo',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ slug: z.string(), url: z.string() }),
  responseSchema: z.object({ dataUri: z.string() }),
});

export const composioToolkits = defineInvokeChannel({
  channel: 'composio:toolkits',
  v: 1,
  sensitive: false,
  // Added fields, not changed ones — an older caller sending `{}` still gets
  // the unfiltered list it always got.
  requestSchema: z.object({
    search: z.string().optional(),
    connectedOnly: z.boolean().optional(),
  }),
  responseSchema: z.object({
    toolkits: z.array(
      z.object({
        name: z.string(),
        slug: z.string(),
        isNoAuth: z.boolean(),
        connected: z.boolean(),
        description: z.string(),
        logo: z.string(),
        categories: z.array(z.string()),
        toolsCount: z.number(),
        authSchemes: z.array(z.string()),
        appUrl: z.string(),
      }),
    ),
    reason: z.string(),
  }),
});

// Starts connecting an app. Composio runs the sign-in; this hands back the page
// the user has to visit, and the connection is not made until they finish there.
export const composioConnect = defineInvokeChannel({
  channel: 'composio:connect',
  // Bumped: `opened` is a new field, and the renderer needs to know whether the
  // browser actually came up rather than assuming it did — which is what the
  // last version did, and it was wrong every single time.
  v: 2,
  sensitive: false,
  requestSchema: z.object({ toolkit: z.string() }),
  responseSchema: z.object({ url: z.string(), opened: z.boolean(), reason: z.string() }),
});

/**
 * Which app one Composio tool slug belongs to.
 *
 * A read, and deliberately the only new Composio channel: there is no channel
 * that *runs* a tool, because CLAUDE.md's first hard rule is that every tool
 * call goes through the Governor and an IPC channel around it would be exactly
 * the bypass that forbids.
 *
 * Answered by Composio rather than worked out from the name. `GMAIL_SEND_EMAIL`
 * looks like it belongs to `gmail` and does, but `ZOHO_MAIL_MESSAGES_SEND_EMAIL`
 * belongs to `zoho_mail` while `ZOHO` is also a real toolkit — twenty-five
 * colliding pairs in the catalogue, measured — so a prefix rule would put one
 * app's tools inside another app's limit.
 */
export const composioToolkitOf = defineInvokeChannel({
  channel: 'composio:toolkitOf',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ slug: z.string() }),
  responseSchema: z.object({ toolkit: z.string() }),
});

/**
 * Opens a link in the user's own browser.
 *
 * The renderer cannot do this: `applyNavigationGuard` denies `window.open` for
 * every origin but the app's own, deliberately. See `openExternal` for the
 * destinations this will accept and why it is a list rather than "any https".
 */
export const shellOpenExternal = defineInvokeChannel({
  channel: 'shell:openExternal',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ url: z.string() }),
  responseSchema: z.object({ opened: z.boolean(), reason: z.string() }),
});

// The swarm section: a population, and every question ever put to it.
const swarmResultSchema = z.object({
  mode: z.enum(['everyone', 'archetypes']),
  population: z.number(),
  thinking: z.number(),
  stopped: z.enum(['settled', 'rounds', 'cancelled']),
  final: z.object({
    for: z.number(),
    against: z.number(),
    undecided: z.number(),
    weighted: z.number(),
  }),
  rounds: z.array(
    z.object({
      round: z.number(),
      movement: z.number(),
      distribution: z.object({
        for: z.number(),
        against: z.number(),
        undecided: z.number(),
        weighted: z.number(),
      }),
      said: z.array(z.object({ name: z.string(), position: z.number(), said: z.string() })),
      // Optional: threads recorded before the graph existed have no stances,
      // and a schema that demanded them would make those threads unreadable.
      stances: z
        .array(z.object({ id: z.string(), position: z.number(), confidence: z.number() }))
        .optional(),
    }),
  ),
  personas: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      traits: z.array(z.string()),
      susceptibility: z.number(),
      influence: z.number(),
      kind: z.enum(['archetype', 'follower']),
      follows: z.string(),
    }),
  ),
  // The drawn population. Optional for the same reason as `stances` above.
  //
  // Left out when this was added, and the omission is invisible in a way worth
  // recording: a Zod object strips what it does not name, so the graph was
  // stored correctly, read back correctly, and then quietly removed on its way
  // through the IPC boundary. Nothing errored — the picture was simply absent
  // on every finished thread while working perfectly during the run.
  graph: z
    .object({
      nodes: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          kind: z.enum(['archetype', 'follower']),
          follows: z.string(),
          influence: z.number(),
        }),
      ),
      ties: z.array(z.object({ from: z.string(), to: z.string(), weight: z.number() })),
      drawn: z.number(),
      total: z.number(),
    })
    .optional(),
});

const swarmTurnSchema = z.object({
  id: z.string(),
  seq: z.number(),
  asked: z.string(),
  answer: z.string(),
  result: swarmResultSchema.nullable(),
  createdAt: z.string(),
});

export const swarmList = defineInvokeChannel({
  channel: 'swarm:list',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({
    threads: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        updatedAt: z.string(),
        source: z.string(),
      }),
    ),
  }),
});

export const swarmGet = defineInvokeChannel({
  channel: 'swarm:get',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ id: z.string() }),
  responseSchema: z.object({
    thread: z
      .object({
        id: z.string(),
        name: z.string(),
        question: z.string(),
        source: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
        turns: z.array(swarmTurnSchema),
      })
      .nullable(),
  }),
});

export const swarmAsk = defineInvokeChannel({
  channel: 'swarm:ask',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    threadId: z.string().optional(),
    question: z.string(),
    settings: z.object({
      connectionId: z.string(),
      model: z.string(),
      population: z.number().int().min(2).max(50_000),
      maxRounds: z.number().int().min(1).max(20),
      everyoneUpTo: z.number().int().min(0).max(200),
      // Read around the question first. Added, not changed, so a caller that
      // omits it gets exactly the behaviour it had.
      research: z.boolean().optional(),
    }),
  }),
  responseSchema: z.object({
    threadId: z.string(),
    name: z.string(),
    turn: swarmTurnSchema,
  }),
});

export const swarmRename = defineInvokeChannel({
  channel: 'swarm:rename',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ id: z.string(), name: z.string() }),
  responseSchema: z.object({ renamed: z.boolean() }),
});

export const swarmArchive = defineInvokeChannel({
  channel: 'swarm:archive',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ id: z.string() }),
  responseSchema: z.object({ archived: z.boolean() }),
});

// The thread an automation run created, for the button on a swarm node.
export const swarmForRun = defineInvokeChannel({
  channel: 'swarm:forRun',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ runId: z.string() }),
  responseSchema: z.object({ threadId: z.string() }),
});

// Rounds as they happen, so a population of two thousand is something to watch
// rather than a spinner.
/**
 * The population, pushed once it exists.
 *
 * Separate from `swarm:round` because it is sent once and is much larger: a
 * few hundred nodes and the ties between them, where a round is a handful of
 * numbers. Putting the graph on every round would send it twenty times over.
 */
export const swarmPopulation = defineEventChannel({
  channel: 'swarm:population',
  v: 1,
  sensitive: false,
  payloadSchema: z.object({
    swarmId: z.string(),
    nodes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.enum(['archetype', 'follower']),
        follows: z.string(),
        influence: z.number(),
      }),
    ),
    ties: z.array(z.object({ from: z.string(), to: z.string(), weight: z.number() })),
    drawn: z.number(),
    total: z.number(),
  }),
});

export const swarmRound = defineEventChannel({
  channel: 'swarm:round',
  v: 1,
  sensitive: false,
  payloadSchema: z.object({
    swarmId: z.string(),
    round: z.number(),
    movement: z.number(),
    distribution: z.object({
      for: z.number(),
      against: z.number(),
      undecided: z.number(),
      weighted: z.number(),
    }),
    said: z.array(z.object({ name: z.string(), position: z.number(), said: z.string() })),
    stances: z.array(z.object({ id: z.string(), position: z.number(), confidence: z.number() })),
  }),
});

/**
 * One thing happening inside a running swarm, as it happens.
 *
 * Finer than `swarm:round` on purpose. A round of two dozen agents against a
 * rate-limited model is minutes long, and until this existed the window had
 * nothing to say for the whole of it — the graph sat perfectly still and the
 * only honest reading was that something had hung. This carries each agent
 * being asked and each answer landing, so what is on screen is the work.
 *
 * Every field is required. `z.object` drops keys it does not name, silently
 * and with no error at either end, and optional halves of a union are exactly
 * the shape that gets lost that way — it has already cost this section a whole
 * feature once. Absent values are sent as empty rather than omitted.
 */
export const swarmActivity = defineEventChannel({
  channel: 'swarm:activity',
  v: 1,
  sensitive: false,
  payloadSchema: z.object({
    swarmId: z.string(),
    stage: z.enum(['reading', 'casting', 'thinking', 'writing', 'done']),
    personaId: z.string(),
    round: z.number(),
    state: z.enum(['asking', 'answered', 'failed', 'none']),
    position: z.number(),
    confidence: z.number(),
    said: z.string(),
  }),
});

// Keeping a file a run produced. Opens the OS save dialog; the path is checked
// against the run's own sandbox before anything is read.
export const runSaveArtifact = defineInvokeChannel({
  channel: 'run:saveArtifact',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ runId: z.string(), path: z.string(), name: z.string() }),
  responseSchema: z.object({ saved: z.boolean(), path: z.string(), reason: z.string() }),
});

// The automations somebody can start from. Read-only: a template is data this
// build ships, not something the renderer edits.
export const templateList = defineInvokeChannel({
  channel: 'template:list',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({
    templates: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        audience: z.string(),
        summary: z.string(),
        needs: z.array(z.string()),
        steps: z.array(
          z.object({
            id: z.string().optional(),
            kind: z.string().optional(),
            roleId: z.string(),
            instruction: z.string(),
            settings: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
        edges: z.array(z.tuple([z.string(), z.string()])).optional(),
        egressAllowlist: z.array(z.string()).optional(),
        egressMode: z.enum(['allowlist', 'browse', 'open']).optional(),
      }),
    ),
  }),
});

// Who is sitting in front of this copy, and how they like it to look.
//
// Device-local and never in SQLite: the name is for the home screen and nothing
// else. `installId` is deliberately not on this channel — the renderer has no
// business knowing it, and the ping that uses it is sent from main.
const profileSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  theme: z.enum(['dark', 'light']),
  usageStats: z.boolean(),
  onboarded: z.boolean(),
});

export const profileGet = defineInvokeChannel({
  channel: 'profile:get',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: profileSchema,
});

export const profileSet = defineInvokeChannel({
  channel: 'profile:set',
  v: 1,
  sensitive: false,
  // Every field optional: the theme toggle sets one thing and setup sets four,
  // and neither should have to send the others back unchanged.
  requestSchema: z.object({
    firstName: z.string().max(80).optional(),
    lastName: z.string().max(80).optional(),
    theme: z.enum(['dark', 'light']).optional(),
    usageStats: z.boolean().optional(),
    onboarded: z.boolean().optional(),
  }),
  responseSchema: profileSchema,
});

// Which search service the agents use. The key travels one way only: in on
// `set`, never back out on `get` — the panel is told whether one is stored.
const searchProviderSchema = z.enum(['none', 'brave', 'tavily', 'serper']);
const searchStateSchema = z.object({
  provider: searchProviderSchema,
  region: z.string(),
  hasKey: z.boolean(),
});

export const searchGet = defineInvokeChannel({
  channel: 'search:get',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: searchStateSchema,
});

export const searchSet = defineInvokeChannel({
  channel: 'search:set',
  v: 1,
  // Carries an API key on the way in.
  sensitive: true,
  requestSchema: z.object({
    provider: searchProviderSchema,
    region: z.string(),
    apiKey: z.string().optional(),
  }),
  responseSchema: searchStateSchema,
});

export const telemetryTest = defineInvokeChannel({
  channel: 'telemetry:test',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ runId: z.string() }),
  responseSchema: z.object({ sent: z.boolean(), detail: z.string() }),
});

// M8-3: the grant, the indicator, and the stop.
const controlSessionSchema = z.object({
  granted: z.boolean(),
  reason: z.string(),
  grantedAt: z.string(),
  dryRun: z.boolean(),
});

export const controlGet = defineInvokeChannel({
  channel: 'control:get',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({
    session: controlSessionSchema,
    panicKey: z.string(),
  }),
});

export const controlGrant = defineInvokeChannel({
  channel: 'control:grant',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ reason: z.string(), dryRun: z.boolean() }),
  responseSchema: z.object({ session: controlSessionSchema }),
});

export const controlRevoke = defineInvokeChannel({
  channel: 'control:revoke',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({ session: controlSessionSchema }),
});

export const controlPanic = defineInvokeChannel({
  channel: 'control:panic',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({ cancelledRuns: z.number(), controlRevoked: z.boolean() }),
});

export const controlEvent = defineEventChannel({
  channel: 'control:event',
  v: 1,
  sensitive: false,
  payloadSchema: z.object({
    session: controlSessionSchema,
    cancelledRuns: z.number().optional(),
  }),
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
        maxTokens: z.number().nullable(),
        combinesMany: z.boolean(),
        outputFormat: z.string(),
        isBuiltin: z.boolean(),
      }),
    ),
  }),
});

// M-custom agents: the user's own roster entries, saved and removed like
// anything else they own.
export const roleSave = defineInvokeChannel({
  channel: 'role:save',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    id: z.string(),
    name: z.string(),
    systemPrompt: z.string(),
    toolAllowlist: z.array(z.string()),
    tier: z.string(),
    maxIterations: z.number(),
    maxCostUsd: z.number().nullable(),
    maxTokens: z.number().nullable(),
    combinesMany: z.boolean(),
    outputFormat: z.string(),
  }),
  responseSchema: z.object({ id: z.string() }),
});

export const roleRemove = defineInvokeChannel({
  channel: 'role:remove',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ id: z.string() }),
  responseSchema: z.object({ removed: z.boolean(), reason: z.string() }),
});

// Plugins: MCP servers the user added. The same protocol CHIMERA's own tool
// servers speak, which is how a user reaches email, calendars and issue
// trackers without an integration written per service.
const pluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  enabled: z.boolean(),
  command: z.string(),
  url: z.string(),
  lastError: z.string(),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
});

export const pluginList = defineInvokeChannel({
  channel: 'plugin:list',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({ plugins: z.array(pluginSchema) }),
});

export const pluginSave = defineInvokeChannel({
  channel: 'plugin:save',
  // Carries credentials on the way in, so it is marked sensitive: the IPC log
  // records that this channel was called and never what was on it.
  v: 1,
  sensitive: true,
  requestSchema: z.object({
    id: z.string().optional(),
    name: z.string(),
    kind: z.enum(['stdio', 'http']),
    command: z.string(),
    args: z.array(z.string()),
    url: z.string(),
    enabled: z.boolean(),
    secrets: z.record(z.string(), z.string()),
    headers: z.record(z.string(), z.string()),
  }),
  responseSchema: z.object({ id: z.string() }),
});

export const pluginRemove = defineInvokeChannel({
  channel: 'plugin:remove',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ id: z.string() }),
  responseSchema: z.object({ removed: z.boolean() }),
});

export const pluginTest = defineInvokeChannel({
  channel: 'plugin:test',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ id: z.string() }),
  responseSchema: z.object({ ok: z.boolean(), detail: z.string(), tools: z.number() }),
});

// Every tool that exists right now, so an agent's grants are picked rather
// than typed. Includes anything a plugin brought with it.
export const toolList = defineInvokeChannel({
  channel: 'tool:list',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({
    tools: z.array(
      z.object({
        id: z.string(),
        serverId: z.string(),
        description: z.string(),
        irreversible: z.boolean(),
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
// Folders the user has given CHIMERA read access to. Read access only — there
// is no channel here that makes anything writable, because there is no such
// capability to expose.
export const fileGrantList = defineInvokeChannel({
  channel: 'files:grants',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({
    grants: z.array(z.object({ path: z.string(), grantedAt: z.string(), missing: z.boolean() })),
  }),
});

export const fileGrantAdd = defineInvokeChannel({
  channel: 'files:grant',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({ granted: z.boolean(), reason: z.string() }),
});

export const fileGrantRevoke = defineInvokeChannel({
  channel: 'files:revoke',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ path: z.string() }),
  responseSchema: z.object({ revoked: z.boolean() }),
});

// Mailboxes an agent can be given. No channel here returns a password or a
// vault handle: the renderer's business is which mailboxes exist, not what
// opens them.
export const workflowRemove = defineInvokeChannel({
  channel: 'workflow:remove',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ id: z.string() }),
  responseSchema: z.object({ removed: z.boolean() }),
});

export const connectionRemove = defineInvokeChannel({
  channel: 'connection:remove',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ id: z.string() }),
  responseSchema: z.object({ removed: z.boolean() }),
});

export const emailAccountList = defineInvokeChannel({
  channel: 'email:accounts',
  v: 1,
  sensitive: false,
  requestSchema: z.object({}),
  responseSchema: z.object({
    accounts: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        address: z.string(),
        imapHost: z.string(),
        smtpHost: z.string(),
        username: z.string(),
      }),
    ),
  }),
});

export const emailAccountSave = defineInvokeChannel({
  channel: 'email:save',
  // Carries an app password on the way in, so it is logged by channel name
  // only — the same treatment connection:create and vault:setSecret get.
  v: 1,
  sensitive: true,
  requestSchema: z.object({
    id: z.string(),
    label: z.string(),
    address: z.string(),
    preset: z.string(),
    imapHost: z.string(),
    imapPort: z.number().int(),
    smtpHost: z.string(),
    smtpPort: z.number().int(),
    username: z.string(),
    password: z.string(),
  }),
  responseSchema: z.object({ id: z.string() }),
});

export const emailAccountRemove = defineInvokeChannel({
  channel: 'email:remove',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ id: z.string() }),
  responseSchema: z.object({ removed: z.boolean() }),
});

export const emailAccountTest = defineInvokeChannel({
  channel: 'email:test',
  v: 1,
  sensitive: false,
  requestSchema: z.object({ id: z.string() }),
  responseSchema: z.object({ ok: z.boolean(), detail: z.string() }),
});

export const automationPlan = defineInvokeChannel({
  channel: 'automation:plan',
  v: 1,
  sensitive: false,
  requestSchema: z.object({
    connectionId: z.string(),
    model: z.string(),
    description: z.string(),
  }),
  // Still v1: every field below is added, and the shape the previous planner
  // answered with still validates. CLAUDE.md — "adding a field is fine,
  // changing one needs a version bump".
  responseSchema: z.object({
    name: z.string(),
    summary: z.string(),
    steps: z.array(
      z.object({
        id: z.string().optional(),
        kind: z.enum(['agent', 'approval']).optional(),
        roleId: z.string(),
        instruction: z.string(),
      }),
    ),
    edges: z.array(z.tuple([z.string(), z.string()])).optional(),
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
  runAwaiting,
  runList,
  traceList,
  runFailures,
  runCosts,
  evalsRun,
  evalsTagProduction,
  triggerList,
  filesPickDirectory,
  traceScreenshot,
  tiersGet,
  tiersSet,
  pinnedGet,
  pinnedSet,
  cacheGet,
  cacheSet,
  profileGet,
  profileSet,
  templateList,
  runSaveArtifact,
  assistantAsk,
  swarmList,
  swarmGet,
  swarmAsk,
  swarmRename,
  swarmArchive,
  swarmForRun,
  swarmPopulation,
  swarmRound,
  swarmActivity,
  composioGet,
  composioSet,
  connectionCatalogue,
  composioLogo,
  composioToolkits,
  composioSearch,
  composioConnect,
  composioToolkitOf,
  shellOpenExternal,
  searchGet,
  searchSet,
  telemetryGet,
  telemetrySet,
  telemetryTest,
  controlGet,
  controlGrant,
  controlRevoke,
  controlPanic,
  controlEvent,
  traceExport,
  runEvent,
  providerTestConnection,
  connectionCreate,
  connectionList,
  healthSweep,
  roleList,
  roleSave,
  roleRemove,
  toolList,
  pluginList,
  pluginSave,
  pluginRemove,
  pluginTest,
  filesPick,
  automationPlan,
  workflowRemove,
  connectionRemove,
  emailAccountList,
  emailAccountSave,
  emailAccountRemove,
  emailAccountTest,
  fileGrantList,
  fileGrantAdd,
  fileGrantRevoke,
  automationCheck,
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
