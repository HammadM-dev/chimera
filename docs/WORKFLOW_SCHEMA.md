# Workflow schema

**Schema version** 3
**Status** contract. The canvas, engine, and swarm all bind to this. Changing it is expensive — get it right before writing engine code.

**Version 3** (M5) added the `fanout`, `aggregate` and `swarm` node types and
`steps[].tier`. **Version 2** (M4-3, M4-6) added, to the run brief below: `steps[].type` and
`steps[].config` for the five non-agent node types, `preauthorised`, and
`layout`.
Every one is optional, so a version 1 definition loads unchanged.

---

## Design rules

1. A workflow is a directed graph, not a list. Cycles are legal only inside a `loop` node's body.
2. Every node declares its own budget and limits. The Governor reads these; it never infers them.
3. No node can loop forever. Loop and agent nodes must declare a termination condition.
4. Data flows through named ports. No implicit "previous node output" magic — it makes debugging impossible at forty nodes.
5. The schema is forward-compatible: unknown fields are preserved on load and round-tripped on save, so an older build doesn't destroy a newer workflow.

---

## Top level

```jsonc
{
  "schemaVersion": 1,
  "id": "wf_7bd21c",
  "name": "Invoice triage",
  "version": 12,
  "description": "Classify inbound invoices and flag exceptions",
  "tags": ["finance", "production"],

  "inputs": [
    { "key": "folder", "type": "path", "label": "Invoice folder", "required": true }
  ],

  "budget": {
    "maxTokens": 2000000,
    "maxCostUsd": 40.00,
    "maxWallClockSec": 3600,
    "onExceed": "halt"
  },

  "policy": {
    "egressAllowlist": ["api.company.com"],
    "requireApprovalFor": ["email.send", "fs.delete", "native.input"],
    "localModelsOnly": false
  },

  "defaults": {
    "modelBinding": { "connectionId": "conn_anthropic", "model": "claude-sonnet-4-6" },
    "retry": { "maxAttempts": 3, "backoff": "exponential", "jitter": true }
  },

  "nodes": [],
  "edges": [],
  "triggers": [],
  "evals": []
}
```

`onExceed` is one of `halt`, `pause_for_approval`, `degrade_to_cheaper_model`.

---

## Nodes

Common envelope on every node:

```jsonc
{
  "id": "n_classify",
  "type": "agent",
  "label": "Classify invoice",
  "position": { "x": 320, "y": 180 },
  "ports": {
    "in":  [{ "key": "document", "type": "file" }],
    "out": [{ "key": "result", "type": "json" }]
  },
  "budget": { "maxTokens": 20000, "maxCostUsd": 0.20 },
  "retry": { "maxAttempts": 2 },
  "onError": "fail",
  "config": { }
}
```

`onError` is one of `fail`, `continue`, `route_to_error_port`, `dead_letter`.

### `agent`

```jsonc
"config": {
  "roleId": "role_extractor",
  "modelBinding": { "connectionId": "conn_omniroute", "model": "auto/quality" },
  "goal": "Extract vendor, amount, due date, and PO number from {{in.document}}",
  "toolAllowlist": ["fs.read", "pdf.extract"],
  "maxIterations": 8,
  "requireVerification": true,
  "outputContract": {
    "schema": { "type": "object", "required": ["vendor", "amountUsd", "dueDate"] },
    "onInvalid": "repair_once"
  },
  "memory": { "scratchpad": true, "workspaceFacts": true, "vectorStore": false }
}
```

**Supported schema keywords.** `outputContract.schema` is validated by `packages/core/src/runtime/jsonSchema.ts`, which implements a documented subset of JSON Schema: `type` (including a type array), `properties`, `required`, `additionalProperties: false`, `items`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, and `pattern`. Annotation keywords (`title`, `description`, `default`, `examples`, `$schema`) are accepted and ignored. **Any other keyword is reported as a validation error rather than skipped** — a contract that quietly stops checking a field is worse than one that refuses, because the author believes a constraint is being enforced when it is not. If a workflow needs full draft-2020 (`oneOf`, `$ref`, `allOf`), that is a concrete case for adding a schema library, and it is a decision for the project owner rather than a silent dependency.

`requireVerification: true` adds the verify step to the loop — the agent must produce evidence its sub-goal was met before the node reports success. `onInvalid` is `repair_once`, `repair_until_attempts`, or `fail`.

`modelBinding` is validated against the capability matrix at save time. Binding a node with `toolAllowlist` to a model without tool-calling support is a save-blocking error, not a runtime surprise.

### `tool`

```jsonc
"config": {
  "toolId": "http.request",
  "params": { "method": "GET", "url": "{{in.endpoint}}" },
  "requiresApproval": false
}
```

### `condition`

```jsonc
"config": {
  "expression": "in.result.amountUsd > 5000",
  "branches": { "true": "n_approval", "false": "n_autofile" }
}
```

Expressions are a small sandboxed language — comparisons, boolean ops, property access, `length()`, `contains()`. No arbitrary code execution.

### `loop`

```jsonc
"config": {
  "body": ["n_draft", "n_review"],
  "exit": {
    "maxIterations": 5,
    "condition": "in.review.approved == true",
    "verifiedGoal": "The draft satisfies every item in the brief"
  },
  "collect": "last"
}
```

At least one of `maxIterations`, `condition`, or `verifiedGoal` **must** be present. `collect` is `last`, `all`, or `none`.

### `fanout`

```jsonc
"config": {
  "over": "{{in.items}}",
  "bodyNodeId": "n_process_one",
  "concurrency": 25,
  "maxItems": 5000,
  "itemBudget": { "maxTokens": 8000, "maxCostUsd": 0.02 },
  "modelTier": "cheap",
  "onItemError": "dead_letter",
  "deadLetterLimit": 50
}
```

`concurrency` is the number in flight, not the number of tasks. The queue holds the rest. `modelTier` is `cheap`, `standard`, or `frontier`, resolved against the workspace tiering config so a workflow stays portable across provider setups.

If `deadLetterLimit` is exceeded, the whole fan-out halts — a systematic failure shouldn't burn the full budget proving itself 5,000 times.

### `swarm`

```jsonc
"config": {
  "orchestrator": { "roleId": "role_planner", "modelTier": "frontier" },
  "agents": [
    { "roleId": "role_researcher", "count": 4, "modelTier": "standard" },
    { "roleId": "role_reviewer",   "count": 2, "modelTier": "frontier" }
  ],
  "maxConcurrentAgents": 20,
  "blackboard": { "maxEntries": 500, "writeScopes": "per_role" },
  "termination": {
    "maxRounds": 12,
    "goalPredicate": "All research questions have a cited answer",
    "stallRounds": 3
  }
}
```

`maxConcurrentAgents` is hard-capped at 20 by the engine. Above that, coordination overhead exceeds useful output. The UI states this rather than hiding it.

### `aggregate`

```jsonc
"config": {
  "strategy": "reduce_with_agent",
  "roleId": "role_summariser",
  "chunkSize": 50,
  "instruction": "Merge into a single exception report grouped by vendor"
}
```

Strategies: `concat`, `json_merge`, `reduce_with_agent`, `vote`, `custom_expression`.

### `humanApproval`

```jsonc
"config": {
  "title": "Approve payment hold",
  "summaryTemplate": "{{in.vendor}} — ${{in.amountUsd}} flagged as {{in.reason}}",
  "showFullContext": true,
  "options": ["approve", "reject", "edit"],
  "timeoutSec": 86400,
  "onTimeout": "reject",
  "notify": ["desktop", "email"]
}
```

### `transform`

Deterministic data shaping with no model call — expression-based mapping, filtering, JSON path extraction. Free, fast, and it removes a huge class of "use an LLM to reformat JSON" waste.

### `subworkflow`

```jsonc
"config": { "workflowId": "wf_3aa910", "version": "production", "inputMap": { } }
```

Budgets nest. A subworkflow cannot exceed the parent's remaining budget.

### `trigger`

Entry node. Types: `manual`, `schedule` (cron), `webhook`, `fileWatch`, `folderDrop`, `hotkey`.

---

## Edges

```jsonc
{
  "id": "e_1",
  "from": { "node": "n_classify", "port": "result" },
  "to":   { "node": "n_condition", "port": "in" },
  "kind": "data"
}
```

`kind` is `data`, `control`, or `error`. Error edges carry failures from nodes with `onError: "route_to_error_port"`.

---

## Evals

```jsonc
"evals": [
  {
    "id": "ev_1",
    "name": "Handles missing PO number",
    "inputs": { "folder": "./fixtures/missing_po" },
    "assertions": [
      { "path": "output.exceptions.length", "op": "gte", "value": 1 },
      { "path": "output.exceptions[0].reason", "op": "contains", "value": "PO" }
    ],
    "provider": "mock"
  }
]
```

Evals run against the mock provider by default so CI costs nothing. A workflow with failing evals cannot be tagged `production`.

---

## Validation rules the editor enforces at save

1. Graph is acyclic outside `loop` bodies.
2. Every loop node has at least one exit condition.
3. Every port connection is type-compatible.
4. Every `modelBinding` satisfies the node's capability requirements.
5. Every node reachable from a trigger; unreachable nodes warn.
6. Sum of node budgets does not exceed the workflow budget.
7. Any node calling a tool in `policy.requireApprovalFor` has an approval node upstream, or the workflow carries an explicit pre-authorisation flag.
8. `fanout.concurrency` does not exceed the rate-limit headroom of its bound connection.

Failing 1, 2, 4, or 7 blocks the save. The rest warn.

---

## The run brief — what is saved today

The document above is the target. What the canvas writes and the engine reads
today is a smaller shape, `RunBrief` in `packages/core/src/engine/runBrief.ts`,
which is a subset rather than a divergence: every field here has a home in the
document above, and the fields above that are missing here are ones no
implemented feature reads yet.

```jsonc
{
  "name": "Invoice triage",
  "instruction": "Summarise every invoice in the folder.",   // reaches the first step
  "attachments": [
    { "name": "invoices", "path": "/…", "kind": "text", "content": "…", "note": "" }
  ],
  "steps": [
    {
      "nodeId": "researcher-1",
      "type": "agent",            // agent | condition | loop | transform | approval
                              // | subworkflow | fanout | aggregate | swarm
      "config": { "type": "agent" },
      "roleId": "researcher",
      "instruction": "",          // empty falls back to the brief's
      "connectionId": "conn_…",       // or "tier": "cheap" — see below
      "model": "claude-haiku-4-5"
    }
  ],
  "edges": [["researcher-1", "summariser-2"]],
  "preauthorised": ["coder-3"],   // steps allowed to act irreversibly without a gate
  "layout": [{ "nodeId": "researcher-1", "x": 120, "y": 60 }]
}
```

`config` by node type:

| `type` | `config` | Notes |
| --- | --- | --- |
| `agent` | `{ "type": "agent" }` | The step makes a model call. `roleId` and `model` are required. |
| `condition` | `{ "type": "condition", "condition": { "source", "test", "value", "whenTrue": [], "whenFalse": [] } }` | `test` is one of `contains`, `equals`, `matches`, `isEmpty`, `notEmpty`. A **declared comparison, never an expression** — a saved file must not be a code-execution surface. `source` empty means the previous step. The branch not taken is skipped, and so is everything reachable only through it. |
| `loop` | `{ "type": "loop", "loop": { "body": [], "maxIterations": 3, "until": { …condition } } }` | `maxIterations` is required and has no default; the editor refuses to save without it. `body` is the node ids the loop runs itself. |
| `transform` | `{ "type": "transform", "transform": { "template": "…{{step-id}}…" } }` | Fills `{{step-id}}` from earlier outputs; `{{previous}}` is the step before. No model call. |
| `approval` | `{ "type": "approval", "approval": { "prompt": "Send this?", "showSource": "" } }` | The run stops, persists as `awaiting_approval`, and survives a restart in that state. |
| `subworkflow` | `{ "type": "subworkflow", "subworkflow": { "workflowId": "wf_…", "version": "" } }` | Runs another saved automation here. `version` empty means the latest at run time. The child's node ids are prefixed with the calling node's, and automations nest at most five deep. |
| `fanout` | `{ "type": "fanout", "fanout": { "source", "parse": "json\|lines", "body": [], "concurrency": 25, "maxItems": 1000, "onItemError": "continue\|halt", "deadLetterLimit": 50 } }` | Runs the body once per item, `concurrency` at a time — in flight, not in total. `maxItems` is required. Failed items go to `dead_letter` with the item itself; past `deadLetterLimit` the node stops. |
| `aggregate` | `{ "type": "aggregate", "aggregate": { "source", "strategy", "separator", "template", "roleId", "chunkSize", "instruction" } }` | `concat`, `json_merge`, `vote`, `template`, `reduce_with_agent`. Only the last makes a model call; it folds a chunk at a time and folds the results again. |
| `swarm` | `{ "type": "swarm", "swarm": { "goal", "orchestratorRoleId", "agents": [], "maxRounds", "maxConcurrentAgents", "stallRounds", "goalPredicate" } }` | An orchestrator and specialists on one goal, through the blackboard. Concurrency is hard-capped at 20 by the engine. Three ways to stop: the goal predicate, the round limit, and rounds that change nothing. |

### Triggers

`triggers` on the brief is what starts the automation when nobody presses Run:

```jsonc
"triggers": [
  { "kind": "schedule", "cron": "0 9 * * mon-fri" },
  { "kind": "folderDrop", "path": "/home/me/Dropbox/orders" },
  { "kind": "fileWatch", "path": "/home/me/reports" },
  { "kind": "webhook", "token": "…24 random bytes as hex…" }
]
```

Five fields of cron, with `*`, lists, ranges, steps and names (`mon-fri`,
`jan`). The extended vocabulary — `@daily`, `L`, `W`, `#`, seconds — is refused
rather than approximated. A schedule missed while the app was closed is not
fired late when it opens.

A `folderDrop` hands the new file to the first step as an attachment. A webhook
listens on loopback only, at `http://127.0.0.1:<port>/hook/<token>`; the port is
chosen at launch and shown in the brief.

### Tiers instead of model ids

A step may carry `"tier": "cheap" | "standard" | "frontier"` **instead of**
`connectionId` and `model`. The workspace says which connection and model each
tier means (Providers → Model tiers, stored on the settings row). The same
automation then runs for somebody on hosted keys and somebody running
everything locally, with no edit — which is the difference between a template
you can ship and one that only works where it was written.

A step bound to a tier the workspace has not configured fails, naming the tier.
It does not fall back to another model: running on a model nobody chose is the
failure the indirection exists to prevent.

### What the editor refuses, and when

Two bars, not one:

- **Refuses to save** — a loop with no bound, and a step that may use a tool
  that is irreversible however it is called (`shell.exec`, or any tool from a
  server this build does not ship) with no approval node upstream and no entry
  in `preauthorised`. The saved file is what one person sends another, so it
  has to be safe in their hands.
- **Refuses to run** — the above, plus everything a draft is allowed to be
  missing: a step with no model, a brief with no instruction, a branch that
  goes nowhere, a model whose capability entry says `unsupported` for something
  the step needs. `unknown` is not a refusal.

Argument-dependent calls — an HTTP POST from a step whose GETs are fine — are
not a save-time question at all. They are refused at call time by the Governor,
which is the only place the arguments exist.

---

## Runtime state (not part of the saved document)

Persisted per run in SQLite: node status, iteration counts, token and cost accumulators, blackboard contents, queue state, checkpoint pointers, and the full trace. This is what makes crash-resume and replay work — keep it strictly separate from the workflow definition.
