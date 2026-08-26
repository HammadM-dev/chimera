# CHIMERA — Architecture

Status: implementable spec. Companion documents: `docs/WORKFLOW_SCHEMA.md` (schema contract, do not modify alongside this document unless the change is itself a schema change), `docs/ROADMAP.md`, `docs/SECURITY.md`, `docs/DESIGN.md`, `docs/LICENSING.md`, `docs/TESTING.md`.

This document is binding on implementation. Where the master plan (`docs/MASTER_PLAN.md`) was silent and a concrete choice was required to make the system buildable, the choice is marked inline as `DECISION:` and collected at the end of this document. Every hard rule in `CLAUDE.md` is traceable to a specific mechanism below — this document is where "no bypass path" and "secrets never leave the vault" stop being sentences and become file names, function names, and lint rules.

---

## 1. Layer model

CHIMERA is eight layers, strictly ordered. A layer may only call the layer immediately below it through that layer's declared interface — it may not reach past it. The Governor's position (above the agent runtime, below the workflow engine) is the load-bearing fact of this diagram: every model call and every tool call the runtime wants to make is a request the Governor must approve first, not a service the runtime discovers and calls directly.

```
┌────────────────────────────────────────────────────┐
│  Shell — Electron window, routing, command bar      │  apps/desktop, apps/ui (chrome)
├────────────────────────────────────────────────────┤
│  GUI — canvas · run view · inspector · trace        │  apps/ui
├────────────────────────────────────────────────────┤
│  Workflow engine — DAG exec, loops, fan-out          │  packages/core/src/engine
├────────────────────────────────────────────────────┤
│  Governor — budgets · limits · stall · rate          │  packages/core/src/governor
├────────────────────────────────────────────────────┤
│  Agent runtime — loop · roles · memory               │  packages/core/src/runtime
├────────────────────────────────────────────────────┤
│  Tool layer — MCP client + internal servers          │  packages/tools, packages/control
├────────────────────────────────────────────────────┤
│  Provider layer — registry · adapters · keys         │  packages/providers
├────────────────────────────────────────────────────┤
│  Persistence — SQLite · vault · run journal          │  packages/store
└────────────────────────────────────────────────────┘
```

**Shell.** Owns the OS-level window, application menu, global hotkey registration (including the Tier 2 panic hotkey once M8 lands), auto-update lifecycle, and the command palette's keybinding surface. It has no knowledge of workflows, models, or tools — it hosts the renderer and routes IPC. Lives in `apps/desktop/src`.

**GUI.** Owns everything the user sees and directly manipulates: the React Flow canvas, the node inspector, the live run view, the trace viewer, onboarding, and the command palette's content. It never talks to a provider, a tool, or SQLite directly — every read and write crosses the preload bridge as an IPC call into the main process. Lives in `apps/ui/src`.

**Workflow engine.** Owns graph validity and execution order: topological walk of the DAG, loop-body iteration, fan-out queue management, condition branching, subworkflow budget nesting. It decides *what runs next*; it never decides *whether a call is allowed to happen* — that question always goes to the Governor. Lives in `packages/core/src/engine`.

**Governor.** Owns authorization: budgets (token, cost, wall-clock), per-node and per-role caps, stall detection, rate-limit accounting and backoff, cost preview. Every model call and every tool call the engine or runtime wants to make is a request into `Governor.authorizeModelCall()` or `Governor.authorizeToolCall()` — see §7. It is the only layer with veto power over both the runtime and the engine's node runners. Lives in `packages/core/src/governor`.

**Agent runtime.** Owns the plan-act-observe-verify-decide loop, role resolution, prompt assembly (including the untrusted-data envelope described in `docs/SECURITY.md`), and the three memory tiers. It calls the Governor before every provider or tool invocation and never reaches the provider or tool layer on its own. Lives in `packages/core/src/runtime`.

**Tool layer.** Owns the MCP client and the internal MCP servers (filesystem, shell, HTTP, search, browser), plus the tool allowlist check. It is invoked only through the Governor-gated call path; it never initiates a call into the runtime or the engine. Lives in `packages/tools/src` and, for browser/native control specifically, `packages/control/src`.

**Provider layer.** Owns the provider registry, the capability matrix, and one adapter per provider, each translating the normalised internal request shape to and from that provider's wire format. It has no knowledge of workflows, roles, budgets, or the Governor — adapters are pure translation. Lives in `packages/providers/src`.

**Persistence.** Owns SQLite (workflows, versions, runs, traces, cache, connections, licence, blackboard, dead-letter, evals) and the OS-keychain vault wrapper. Every other layer that needs durable state goes through `packages/store`'s repositories — no layer opens `better-sqlite3` directly except `packages/store/src/db.ts`. Lives in `packages/store/src`.

---

## 2. Process model

Three process kinds, per master plan §3.2, plus the M8+ sidecar.

**Renderer process.** Runs the React UI (`apps/ui`). Owns rendering and user input only — no Node integration (`nodeIntegration: false`), no direct filesystem or network access, no `require`. Sandboxed (`sandbox: true`). Everything it needs from the rest of the system — workflow CRUD, run control, provider health, vault writes — is a call through `window.chimera.*`, the object `apps/desktop/src/preload.ts` exposes via `contextBridge.exposeInMainWorld`. If the renderer crashes (a bad canvas render, a runaway React state loop), the main process and any in-flight runs are unaffected; Electron recreates the window.

**Main process.** Runs the workflow engine, Governor, agent runtime, provider layer, and persistence layer (`packages/core`, `packages/providers`, `packages/tools`, `packages/store`, orchestrated from `apps/desktop/src/main.ts`). Long-lived for the life of the application. It owns the SQLite connection, the vault, and all outbound network calls to providers and MCP tool targets that don't require worker isolation. It is the IPC server side — every `window.chimera.*` call in the renderer resolves to a handler registered here.

**Worker processes.** Node `utilityProcess` instances, spawned and reaped by `apps/desktop/src/workerPool.ts`. One worker per active run (or a pooled worker per concurrent fan-out lane, per the swarm design in M5) executes the actual agent loop and tool calls for that run, communicating with the main process over a versioned message schema (same envelope shape as the IPC design in §4, reused because it is already typed and already has a version rule). If a run enters a bad state — an agent stuck spinning, a memory leak from an unbounded context, a tool hang — the worker that hosts it can be terminated and restarted without taking down the main process or any other concurrent run. This is the concrete mechanism behind the risk-register mitigation for "memory growth over long unattended runs": workers are recycled processes, not long-lived heap, and the chaos-test suite (`docs/TESTING.md`) verifies a killed worker's run resumes cleanly from its last checkpoint.

**Rust native-control sidecar (M8+, not built before M8).** A single spawned child process, `sidecar/` at the repo root, communicating with the main process over stdio using line-delimited JSON. It is reached only through `packages/control/src/sidecar/` (bridge client and protocol types) — the sidecar itself holds no product logic, only screen-capture and input-injection primitives and the UI Automation tree walk it's asked for; per the risk register, if the sidecar ever grows past roughly 1500 lines something belongs back in TypeScript instead. Its process boundary gives Tier 2 native control the same crash-isolation property as a worker: a sidecar crash triggers a `SidecarError` (see §6) surfaced to the run, not a main-process crash. Before M8 this section is aspirational — no code in `sidecar/` exists yet, but the process boundary is specified now because `packages/control/src/sidecar/` (the bridge client) is listed in the M0 repository layout and should not need a shape change when M8 arrives.

---

## 3. Package boundaries

Dependency direction, stated once and enforced by `scripts/check-package-boundaries.mjs` and lint (below): `packages/errors` is the floor and imports nothing; every package may import it. `apps/*` depend on `packages/*`. `packages/core` depends on `packages/store`, `packages/providers`, and `packages/tools`, but its `runtime` and `engine` subtrees may reach `providers` and `tools` *only* through `packages/core/src/governor/Governor.ts` — never by importing an adapter or an internal MCP server directly. `packages/providers` and `packages/tools` must never import `packages/core`, which would create a cycle (the Governor calling into providers, providers calling back into the engine, is exactly the shape that makes "no bypass path" unverifiable by inspection). `packages/control` depends on `packages/tools` (to register its browser and sidecar-backed tools into the MCP tool registry) and `packages/store` (to persist connection health and, from M8, sidecar session state).

**`packages/core/src/governor/`** — `budget.ts` (token/cost/wall-clock accounting), `limits.ts` (per-node, per-role, recursion-depth, step-count caps), `stallDetector.ts` (output-similarity + tool-call-novelty comparison across consecutive iterations), `rateLimiter.ts` (token-bucket per connection, backoff/jitter, spillover), `costPreview.ts` (pre-run cost/time estimate), `Governor.ts` (the public interface: `authorizeModelCall()`, `authorizeToolCall()`). Public interface: the two `authorize*` methods plus a `previewCost()` entry point the engine calls before a run starts. Imports: `packages/store` (to read budget state and write spend), `packages/providers/src/capabilityMatrix.ts` (to validate a requested call against what the target model supports) — never an adapter or a tool server directly, since the Governor is what *hands off* to them once it has approved a call, and the handoff itself lives in the runtime/engine call sites, not inside the Governor.

**`packages/core/src/engine/`** — `dagExecutor.ts` (topological execution, loop-body iteration, fan-out queue draining, subworkflow budget nesting), `nodeRunners/` with one file per node type (`agent.ts`, `tool.ts`, `condition.ts`, `loop.ts`, `fanout.ts`, `swarm.ts`, `aggregate.ts`, `humanApproval.ts`, `transform.ts`, `subworkflow.ts`, `trigger.ts`), `validator.ts` (the eight save-time rules from `docs/WORKFLOW_SCHEMA.md`). Public interface: `dagExecutor.run(workflowVersion, input)` returning a run handle the main process can subscribe to. Imports: `packages/core/src/governor` (every node runner that calls a model or a tool goes through it), `packages/store` (run/trace/node-state persistence), `packages/core/src/runtime` (the `agent` node runner delegates to `runtime/agentLoop.ts` for the actual plan-act-observe-verify-decide cycle). Must not import `packages/providers/src/adapters/*` or `packages/tools/src/servers/*` — see the lint rule below.

**`packages/core/src/runtime/`** — `agentLoop.ts` (the loop itself), `roleRegistry.ts` (role CRUD and resolution), `memory/` (`scratchpad.ts`, `workspaceFacts.ts`, `vectorStore.ts`), `checkpoint.ts` (journal-after-every-step, idempotency-key issuance for side-effectful tool calls), `promptAssembly.ts` (the untrusted-data envelope construction described in `docs/SECURITY.md`). Public interface: `agentLoop.run(role, goal, context)`. Imports: `packages/core/src/governor` only, for reaching a provider or a tool — never `packages/providers` or `packages/tools` directly.

**`packages/errors/src/`** — `ChimeraError` and its subclasses (§6), in their own package rather than inside `packages/core`. It imports nothing at all, which is what lets it sit below every other package: `packages/providers` and `packages/tools` are forbidden from importing `packages/core` (the dependency direction below), yet every layer needs to raise typed errors. Both constraints are correct and cannot both hold with the taxonomy inside `core`, so it is a leaf package that everything may depend on. `packages/core` deliberately does not re-export it — a second import path would quietly reopen the edge this split closes. Enforced by `scripts/check-package-boundaries.mjs`.

**`packages/providers/src/`** — `registry.ts` (the `ProviderConnection` table's in-memory/runtime view), `capabilityMatrix.ts` (per-model context window, max output, tool-calling, vision, streaming, structured-output, cost/million-tokens — data, not branching code), `adapters/` (`anthropic.ts`, `openai.ts`, `google.ts`, `openrouter.ts`, `omniroute.ts`, `ollama.ts`, `lmstudio.ts`, `openaiCompatible.ts`), `mock.ts` (the CI test double). Public interface: `createConnectionRegistry(db)` returning `{ list, get, unusable, refresh, close }` (a factory rather than a module singleton, so tests and — later — multiple open workspaces get isolated instances instead of sharing hidden global state), `adapter.chat(normalisedRequest)` returning a normalised response, `capabilityMatrix.supports(modelId, capability)`. The registry's cache is invalidated by subscribing to `packages/store`'s `onConnectionsChanged(db, …)`, so a write through the repository is visible to the next `list()` with no restart and no explicit refresh. A row it cannot parse — an unrecognised provider kind, a corrupt capabilities blob — is quarantined into `unusable()` with a reason rather than dropped silently (which would make a connection vanish from the UI with nothing to explain it) or thrown (which would let one bad row take out every other connection in the workspace). Imports: `packages/store` (to persist connection rows and read auth handles from the vault indirectly, via the vault-backed `connections` repository — never the raw secret itself) only. Must never import `packages/core` — this is the cycle-prevention rule from the dependency direction above, and it is also what makes CLAUDE.md's "provider differences live in adapters only" true structurally: an adapter physically cannot see a role, a budget, or a workflow, so it cannot branch on them even if someone tried.

**The home-screen assistant.** `apps/desktop/src/chat/assistant.ts` runs one turn of conversation per message, on `runAgentLoop` with the `assistant` role, seeded with the conversation so far. DECISION: **it is an ordinary agent, not a privileged path.** It was a direct call to `adapter.streamChat` with no Governor, which CLAUDE.md's first hard rule forbids and which anything holding tools certainly cannot do — so it now takes the same authorisation, budget, untrusted-data envelope and trace as every other agent. Its `workspace` MCP server (`packages/tools/src/servers/workspace.ts`, backed by `chat/workspaceBackend.ts`) is read-only by construction: no tool on it writes, deletes, renames or runs anything, and `planAutomation` returns a design and applies nothing. Credentials cannot reach it — the connection shape it reads carries labels, kinds and model ids and no vault handle — and neither can run prompts, which are enormous and full of third-party content; it gets each step's answer instead.

**Document reading.** `packages/tools/src/documents.ts` turns spreadsheets, Word documents, PDFs, PowerPoint decks and zip listings into text an agent can read; `documentReader.ts` runs it. DECISION: **the parsers run in a child process, never in the app.** Four libraries there read files that arrived from somebody else, which is the shape of most document-parser CVEs — a malformed `.docx` that walks a parser off a buffer, a PDF with a recursive object graph. The child gets the path, a character limit, a wall-clock timeout and an environment holding nothing but `PATH`; a crash is a non-zero exit the parent reports as a tool error, and a hang is a kill. Spreadsheets are rendered as TSV per sheet rather than flattened, because a data extractor asked which column holds the totals cannot answer from a stream of cells in reading order, and dates are rendered ISO from the UTC instant rather than `cell.text`, which gives a locale string that loses a day west of UTC. Zips are listed and never unpacked: an agent that extracts an archive is an agent that can be handed a zip bomb.

**`stats/`** — not part of the application. A Cloudflare Worker and a D1 table that count how many copies of CHIMERA are running, deployed separately and sharing no code with anything above; the app depends on it for nothing, so an outage here is invisible to every user. It is the one place in this repository that holds anything about other people's use of the product, and it holds the least a counter can: one row per install id per day, where an install id is a UUID a copy generated about itself and which joins to nothing. No names, no workspaces, no prompts, no file paths, no times finer than a date. The endpoint is compiled into the app from `CHIMERA_USAGE_ENDPOINT` at build time rather than read from a settings file, so a user's collector cannot be repointed by editing one. Unset — which is every development build — nothing is sent. See `stats/README.md`.

**`packages/tools/src/`** — `mcpClient.ts` (MCP protocol client), `servers/` (`filesystem.ts`, `shell.ts`, `http.ts`, `search.ts`, `browser.ts` — internal MCP servers, one code path shared by built-in and future third-party tools), `toolRegistry.ts` (tool metadata: name, schema, which servers back it), `allowlist.ts` (checks `role.toolAllowlist` before a call reaches a server — see §7 and `docs/SECURITY.md`). Public interface: `toolRegistry.invoke(toolId, params, callerRole)`. Imports: `packages/store` (workspace policy for `egressAllowlist`, sandbox root paths). Must never import `packages/core`.

**`packages/store/src/`** — `db.ts` (better-sqlite3 initialisation and the `PRAGMA journal_mode = WAL` call), `migrations/` (forward-only numbered SQL files), `vault.ts` (OS keychain wrapper: `@napi-rs/keyring` — see `docs/ROADMAP.md` M0-6 for why this was chosen over `keytar`), `repositories/` (`workflows.ts`, `versions.ts`, `runs.ts`, `traces.ts`, `cache.ts`, `connections.ts`, `licence.ts`, `blackboard.ts`, `deadLetter.ts`, `evals.ts`) — one repository per table family, each the *only* code in the codebase permitted to write raw SQL against its table. Public interface: one typed method per query shape per repository (e.g. `runsRepository.create()`, `runsRepository.updateStatus()`) — no repository exposes a raw `db.prepare()` handle to callers. Imports: nothing above it; `packages/store` is the floor.

**`packages/control/src/`** — `browser/` (Playwright profile manager — one isolated profile per workspace, never the user's personal browser profile — plus the browser tool set registered into `packages/tools`'s registry), `sidecar/` (bridge client and protocol types for the Rust binary; the client exists from M0's repository scaffolding even though the binary doesn't ship until M8). Public interface: `browserProfileManager.getOrCreate(workspaceId)`, `sidecarBridge.send(command)` (a no-op/`SidecarError`-throwing stub until M8). Imports: `packages/tools` (to register into the MCP tool registry) and `packages/store` (connection/health persistence for browser profiles and, later, sidecar session state).

**`packages/licensing/`** — new package, not present in the master plan's original list. DECISION: holds licence activation and validation logic only (`activate()`, `validate()`, grace-period arithmetic against the `licence` table) and nothing else — no product features. Isolating this now, before the public/private split in M7, means the split is mechanical: one directory becomes a private binary dependency, rather than a search-and-replace of conditionals scattered through `packages/store` or `apps/desktop`. Full rationale in `docs/LICENSING.md`. Imports: `packages/store` (the `licence` repository) and `packages/store/src/vault.ts` (the activation token is a vault handle, never stored raw — see §5). Nothing imports `packages/licensing` except `apps/desktop` (to gate feature availability at startup) and, from M7, the tier-gating checks the UI consults to grey out Business/Enterprise-only nodes.

**`apps/desktop/src/`** — `main.ts` (process entry, wires engine/governor/runtime/store together), `preload.ts` (the sole `contextBridge` surface), `ipc/` (channel definitions and versioned envelope types — see §4), `windows.ts` (BrowserWindow lifecycle), `settings/` (device-local cosmetic preferences as a JSON file under `userData` — deliberately not SQLite and deliberately not reachable over IPC; see `docs/DESIGN.md` §5.2), `workerPool.ts` (`utilityProcess` spawn/monitor/restart), `autoUpdater.ts`, `security/` (CSP policy, session permission handler, navigation guard). Imports: all of `packages/*`. Nothing imports `apps/desktop`.

**`apps/ui/src/`** — `splash/` and `shell/` (both from M0-8), `canvas/` (React Flow), `inspector/`, `runView/`, `commandPalette/`, `onboarding/`, `design-tokens/`. Imports: nothing from `packages/*` directly — it talks to `window.chimera.*` only, which is the preload-exposed surface, not a package import. This keeps the renderer bundle free of Node-only code (better-sqlite3, `@napi-rs/keyring`) that would break in the sandboxed renderer context if accidentally pulled in by a transitive import. The same boundary is asserted in the type system: `apps/ui/tsconfig.json` sets `"types": []`, so a stray `process` or `Buffer` reference fails to compile rather than failing at runtime in the one process where that failure is least visible.

**How the renderer is loaded.** `apps/ui` builds to a single IIFE bundle plus one stylesheet, copied into `apps/desktop/dist/renderer/` and loaded with `loadFile` over `file://`. There is no dev server and no custom protocol handler: ES module scripts are blocked over `file://`, so a classic script tag is the one format that needs no relaxation of the M0-3 security posture and no extra origin in `navigationGuard.ts`'s allowlist. Development and production consequently load the renderer by exactly the same path. Rationale and the trade-off (no hot reload) in `docs/ROADMAP.md` M0-8.

**Structural enforcement of the Governor's no-bypass path.** CLAUDE.md's rule ("every model call and every tool call goes through the Governor, no bypass path") is enforced by an ESLint rule, not left to reviewer attention:

    // .eslintrc — excerpt, packages/core/src/runtime and packages/core/src/engine
    "no-restricted-imports": ["error", {
      "patterns": [
        {
          "group": ["**/providers/src/adapters/*", "**/tools/src/servers/*"],
          "message": "Reach providers and tools only through packages/core/src/governor/Governor.ts."
        }
      ]
    }]

This rule is scoped to `packages/core/src/runtime/**` and `packages/core/src/engine/**` (their respective `.eslintrc` or a shared root config with path overrides). Any commit that imports an adapter or an internal MCP server directly from those two subtrees fails lint, which fails CI, which blocks merge — the same enforcement tier as a type error. DECISION: enforce this as a path-scoped lint rule rather than a runtime assertion, because a lint failure blocks the commit before the bypass ever ships, whereas a runtime check only catches it if the code path executes during a test.

---

## 4. IPC message design

All renderer-to-main communication is `window.chimera.*`, exposed by `apps/desktop/src/preload.ts` via `contextBridge.exposeInMainWorld('chimera', { ... })`. This is the only renderer-to-main path — `contextIsolation` is on and `nodeIntegration` is off for every `BrowserWindow`, so there is no other way for renderer code to reach the main process.

**Invoke/handle envelope** (renderer calls main, awaits a response — Electron's `ipcRenderer.invoke` / `ipcMain.handle`):

    { v: number, channel: string, requestId: string, payload: unknown }

**Push event envelope** (main sends unsolicited updates to a subscribed renderer — `webContents.send`, received via a channel-specific listener registered in preload):

    { v: number, channel: string, payload: unknown }

**Channel naming convention.** `domain:action`, lower camelCase action, colon-delimited domain. The domain groups match the store repositories and the top-level feature areas; the action is a verb.

| Channel | Direction | Sensitive | Purpose |
|---|---|---|---|
| `workflow:save` | invoke | no | Persist a new workflow version (validator runs first; save-blocking rule failures return a `ValidationError`) |
| `workflow:list` | invoke | no | List workflows for the current workspace, with archive/status filters |
| `workflow:get` | invoke | no | Fetch a workflow plus its latest (or a specific tagged) version |
| `run:start` | invoke | no | Begin a run from a workflow version and input payload; returns the new `runs.id` |
| `run:cancel` | invoke | no | Request cancellation of an in-flight run; engine honours it at the next checkpoint boundary |
| `run:subscribe` | invoke (opens a push stream) | no | Subscribe the caller to `run:event` push messages for a given `runId` |
| `run:event` | push | no | Streamed run update: node status change, token/cost delta, trace append |
| `provider:testConnection` | invoke | no | Round-trip a lightweight request to a `ProviderConnection` to confirm reachability and auth validity |
| `connection:create` | invoke | **yes** | Register a new `ProviderConnection`; if called with an inline raw key rather than a pre-vaulted handle, payload is redacted before logging |
| `connection:list` | invoke | no | List connections with current `healthState`, the workspace's local-only flag, and the provider kinds the form may offer |
| `run:costPreview` | invoke | no | Estimate tokens, cost and duration for a workflow before it runs; needs no run in progress |
| `health:sweep` | invoke | no | Probe every visible connection once and return their refreshed `healthState`s (M1-8's monitor, pulled by the status bar) |
| `omniroute:detect` | invoke | no | Probe the local OmniRoute instance; "not detected" is a normal answer, never an error |
| `omniroute:import` | invoke | no | Import OmniRoute's `/v1/models` catalogue and create or update its single `connections` row |
| `chat:send` | invoke | no | Start a streamed completion against a connection; returns a `streamId` immediately |
| `chat:delta` | push | no | One streamed chunk, terminal usage, or terminal error for a `streamId` |
| `chat:estimateCost` | invoke | no | Cost in USD for a completed exchange, or `null` when the model has no verified price |
| `vault:setSecret` | invoke | **yes** | Write a secret into the OS keychain and return a handle; payload (the raw secret) is never logged |
| `vault:hasSecret` | invoke | no | Boolean existence check by handle, no secret material returned |
| `licence:activate` | invoke | **yes** | Submit an activation token; payload redacted in logs and traces |
| `licence:status` | invoke | no | Current tier, seat, grace-period state |
| `template:import` | invoke | no | Import a shipped or user-supplied workflow JSON as a new workflow |
| `eval:run` | invoke | no | Run a workflow's `evals[]` against the mock provider (or, if explicitly requested, a live connection) and record `eval_runs` |

**Versioning rule.** Adding an optional field to a payload is non-breaking and requires no version bump. Renaming a field, removing a field, or changing what an existing field means is a breaking change to that channel's envelope: it requires incrementing `v` for that channel and updating the preload type definition and the main-process handler in the same commit. A handler receiving an envelope with an unexpected `v` for its channel rejects with a `ValidationError` rather than guessing at the shape — silent coercion between envelope versions is not permitted.

**Sensitive-channel redaction.** Channels are flagged `sensitive: true` in the channel registry (`apps/desktop/src/ipc/`, alongside each channel's definition). The IPC logging middleware — the layer that would otherwise write every invoke/handle pair to the debug log or into a trace for replay — checks this flag before it touches the payload: for a sensitive channel it logs `{ v, channel, requestId, payload: '[redacted]' }` instead of the real payload. This is enforced at the channel-registry level, not by asking each handler to remember to redact itself, so a new sensitive channel is one flag away from being safe by default rather than safe by discipline. `connection:create` is flagged sensitive specifically because its payload *may* carry an inline raw key during initial setup before that key is exchanged for a vault handle — see §5's rule on the `connections` repository rejecting raw-looking auth values outright, which is the second line of defence behind this logging redaction.

---

## 5. SQLite schema

`packages/store/src/db.ts` opens a single SQLite file per workspace via `better-sqlite3` and immediately sets `PRAGMA journal_mode = WAL`. **WAL rationale:** the renderer's run view needs to read `traces` and `node_states` continuously while a run is actively writing to those same tables from the main process — WAL allows concurrent readers alongside a single writer without the reader blocking on or being blocked by the writer, which rollback-journal mode does not give you. All access to these tables goes through `packages/store/src/repositories/*` — no other package prepares a raw SQL statement, per CLAUDE.md's "all SQLite access through packages/store" rule.

**Migration convention.** Forward-only, numbered files in `packages/store/src/migrations/`, named `NNNN_description.sql` (e.g. `0001_init.sql`, `0002_add_dead_letter.sql`). Applied migrations are tracked in a `_migrations` table (columns: `id` (pk, the `NNNN` number), `name`, `applied_at`). `db.ts` runs any unapplied migration, in order, on startup, inside a transaction. There is no down-migration mechanism — a schema mistake is corrected by a new forward migration, not a rollback, so that a production database's migration history is always a strictly increasing, replayable sequence.

### `workflows`

| column | type | notes |
|---|---|---|
| `id` | text | primary key |
| `name` | text | |
| `created_at` | text (ISO 8601) | |
| `updated_at` | text (ISO 8601) | |
| `latest_version_id` | text | fk → `workflow_versions.id` |
| `production_version_id` | text, nullable | fk → `workflow_versions.id`; set when a version is tagged `production` |
| `archived_at` | text, nullable | soft-delete marker |

Written by `workflow:save` (via `repositories/workflows.ts`) on every save that creates a new workflow, and updated (`updated_at`, `latest_version_id`) on every subsequent save. `production_version_id` is written only when a version is explicitly tagged, per the versioning rule in F7.6.

### `workflow_versions`

| column | type | notes |
|---|---|---|
| `id` | text | primary key |
| `workflow_id` | text | fk → `workflows.id` |
| `version_number` | integer | monotonically increasing per workflow |
| `schema_version` | integer | the `schemaVersion` from `docs/WORKFLOW_SCHEMA.md`, currently 1 |
| `definition_json` | text | the full workflow document, forward-compatible per the schema's round-tripping rule |
| `created_at` | text | |
| `created_by` | text | user/actor identifier; single-user today, the F10 seam for multi-user attribution |
| `tag` | text, nullable | e.g. `production`; at most one version per workflow may carry a given tag |

Written once per `workflow:save` call that validator.ts accepts — every save is a new immutable version row, never an update to an existing one, which is what makes diff/rollback (F7.6) free: rollback is "set `production_version_id`/`latest_version_id` to point at an older row," not a data-mutating operation.

### `runs`

| column | type | notes |
|---|---|---|
| `id` | text | primary key |
| `workflow_id` | text | fk → `workflows.id` |
| `workflow_version_id` | text | fk → `workflow_versions.id`, pins the run to the exact definition executed |
| `status` | text | `pending`\|`running`\|`paused`\|`completed`\|`failed`\|`cancelled` |
| `started_at` | text | |
| `ended_at` | text, nullable | |
| `trigger_type` | text | `manual`\|`schedule`\|`webhook`\|`fileWatch`\|`folderDrop`\|`hotkey` |
| `input_json` | text | the run's top-level input payload |
| `budget_tokens_used` | integer | running total, updated by the Governor's budget accounting |
| `budget_cost_usd_used` | real | running total |
| `error_summary` | text, nullable | set on `failed`, human-readable, never contains secret material (see §6) |

Created by `run:start`. `status`, `ended_at`, and the two budget-used columns are updated throughout execution by `dagExecutor.ts` via `repositories/runs.ts` — the budget columns specifically are written by the Governor's accounting path, not by node runners directly, so there is one writer for spend truth.

### `traces`

| column | type | notes |
|---|---|---|
| `id` | text | primary key |
| `run_id` | text | fk → `runs.id` |
| `node_id` | text | |
| `seq` | integer | monotonically increasing per run, defines replay order |
| `ts` | text | |
| `event_type` | text | `prompt`\|`response`\|`tool_call`\|`tool_result`\|`retry`\|`decision`\|`checkpoint`\|`compaction` |
| `payload_json` | text | event-specific detail; passed through the redaction pass described in §"Secrets never leave the vault" below before write |
| `tokens_in` | integer, nullable | |
| `tokens_out` | integer, nullable | |
| `cost_usd` | real, nullable | |

Appended by the agent runtime and the engine's node runners on every prompt sent, response received, tool call made, tool result returned, retry attempted, branching decision taken, checkpoint written, or compaction event — this is the F7.5 replayable audit trace, and it is append-only: no repository method exists to update or delete a trace row.

### `node_states`

| column | type | notes |
|---|---|---|
| `run_id` | text | fk → `runs.id`; part of composite primary key |
| `node_id` | text | part of composite primary key |
| `status` | text | |
| `iteration_count` | integer | for loop/agent nodes |
| `tokens_used` | integer | |
| `cost_used` | real | |
| `checkpoint_json` | text | the resumable state for this node — F2.6's crash/resume mechanism reads this on restart |
| `role_id` | text | which agent spent it (migration `0009`, M9-4). Null for rows written before that |
| `model` | text | which model it spent it on (migration `0009`, M9-4) |

Primary key `(run_id, node_id)`. `role_id` and `model` are written by the spend
meter alongside the figures, rather than derived at read time: the cost view
would otherwise have to re-parse every run's definition and every trace event,
which is the difference between a screen that opens instantly and one nobody
waits for. Written after every step of every node's execution — this is the literal "journaled to SQLite after every step" requirement from F2.6; on app restart, `dagExecutor.ts` reconstructs in-flight runs by reading `node_states` for any run still in `running`/`paused` status and resuming from each node's last `checkpoint_json`.

### `cache`

| column | type | notes |
|---|---|---|
| `key_hash` | text | primary key |
| `kind` | text | `exact`\|`semantic` |
| `embedding` | blob, nullable | populated for `kind = semantic`, consumed by sqlite-vec similarity search |
| `response_json` | text | the cached provider response |
| `created_at` | text | |
| `hits` | integer | incremented on every cache hit, drives the "saved by cache" figure in F9.4 |
| `workflow_id` | text, nullable | scopes a cache entry to a workflow when the workflow's cache policy requires it; null means workspace-global |

Written by the provider-call path in the runtime when a call completes and the workflow's cache policy allows caching; read (and `hits` incremented) before a model call is dispatched, downstream of Governor authorization — caching does not bypass the Governor, a cache hit is still an authorized call that happens to be served locally.

### `connections`

| column | type | notes |
|---|---|---|
| `id` | text | primary key |
| `label` | text | |
| `kind` | text | provider adapter key, e.g. `anthropic`, `omniroute`, `ollama` |
| `base_url` | text | |
| `auth_ref` | text | a vault handle string — **never** a raw secret |
| `capabilities_json` | text | `{ "capabilities": {…}, "limits": {…} }` — cached capability-matrix snapshot keyed by model id, plus that connection's per-connection ceilings. Both live in this one column rather than adding a `limits` column: the runtime shape needs both, and a second JSON column buys nothing a second key in this one does not. Shape owned by `packages/providers`; `packages/store` treats it as an opaque string |
| `health_state` | text | |
| `created_at` | text | |

**`workspace_settings`** — added by migration `0002` for M1-9's local-only mode. Single-row (`id` fixed at 1, same shape as `licence`), holding workspace-scoped *policy* rather than application data.

| Column | Type | Notes |
|---|---|---|
| `id` | integer | Always 1 — single row by construction |
| `local_only_mode` | integer | 0/1. When 1, the provider registry excludes every connection that could reach a third party (F1.7) |
| `model_tiers_json` | text | What this workspace calls cheap, standard and frontier |
| `cache_policy_json` | text | Whether answers are reused, and how closely they must match |
| `telemetry_json` | text | Where runs are exported, if anywhere (M9-5) |
| `search_json` | text | Which search API the agents use, and the vault handle for its key — never the key. Empty object means the built-in keyless search |
| `composio_json` | text | Whether Composio is on, the vault handle for its key, and which Composio "user" this workspace is — never the key |
| `pinned_models_json` | text | `connectionId::model` keys kept at the top of every model picker, in the order they were pinned. A workspace that connects a router gets several hundred models in a dropdown, and this is the two or three anybody uses |

**`workspace_facts`** — added by migration `0004` for M2-10, F2.7's second memory tier: curated key-value knowledge that outlives a run. Deliberately not the `cache` table, which holds derived data under an eviction policy — evicting a note a person typed to make room for a cached embedding would be indefensible. `source` records `user` or the id of the run that wrote the fact, and travels with it into the prompt, because what an agent asserted and what a person stated are not equally trustworthy.

| Column | Type | Notes |
|---|---|---|
| `key` | text | Primary key. Bounded to 200 characters |
| `value` | text | Bounded to 4,000 characters — facts go into every prompt for the workspace, and an unbounded one could push the real instructions out of the context window |
| `source` | text | `user`, or the run id that wrote it |
| `updated_at` | text | |

**Ad-hoc runs.** `runs.workflow_id` and `runs.workflow_version_id` are `NOT NULL REFERENCES`, and an M2-era agent run has no workflow behind it. Rather than weakening those foreign keys for the milestone that happens to come first — a constraint removed for convenience is never put back — such runs attach to one reserved workflow row (`00000000-0000-0000-0000-00000000ad0c`, "Ad-hoc agent runs") created on demand by `runsRepository.ensureAdHocWorkflow()`. The fixed id makes it recognisable and filterable rather than looking like a workflow the user created and forgot.

**`roles`** — added by migration `0003` for M2-5. Workspace-level configuration, not per-workflow: the same `researcher` is used by every workflow in a workspace, and a user who tightens its allowlist expects that to hold everywhere at once. The JSON columns hold shapes owned by `packages/core`; `packages/store` treats them as opaque strings, the same discipline as `connections.capabilities_json`.

| Column | Type | Notes |
|---|---|---|
| `id` | text | Stable identifier, e.g. `researcher`. Referenced by workflow nodes |
| `name` | text | Display name |
| `system_prompt` | text | The role's standing instructions. Never empty — the registry refuses to save one that is |
| `tool_allowlist_json` | text | JSON array of exact tool ids or whole-server grants (`filesystem.*`). A bare `*` is refused |
| `model_binding_json` | text | `{ "tier": "frontier"\|"balanced"\|"cheap", "preferredModel": string\|null }` — a tier rather than a model id, resolved at M5-4 |
| `budget_json` | text | `{ "maxTokens", "maxCostUsd", "maxWallClockMs" }`. Read by the Governor |
| `output_contract_json` | text | `{ "format": "text"\|"json", "schemaId": string\|null }` — the contract M2-8 enforces |
| `max_iterations` | integer | Hard loop cap. At least 1, refused otherwise (CLAUDE.md: no unbounded loops) |
| `is_builtin` | integer | 0/1. A starter role shipped by CHIMERA, so a later version can repair or add starters without overwriting a user's edit |
| `updated_at` | text | Refreshed on every write |

DECISION: this is a table rather than a key in `apps/desktop`'s `local-settings.json`. That file holds cosmetic per-device preferences (`hasSeenSplash`); local-only mode is a security posture a regulated or air-gapped buyer sets once for the workspace and expects to hold wherever that workspace database is opened, including on a different machine. Storing it per-device would silently drop the restriction the moment the workspace moved — the exact failure the flag exists to prevent.

Written by `connection:create`/`connection:update`. `repositories/connections.ts` rejects a write where `auth_ref` looks like a raw key rather than a vault handle: the repository's insert/update methods accept only a branded `AuthRef` type (a nominal wrapper distinct from `string`, produced solely by `vault.setSecret()`), so a caller cannot pass a plain string through by mistake — this is a compile-time boundary, not a runtime string-shape heuristic, backed by a runtime assertion as defence in depth for any payload arriving via IPC (where TypeScript's nominal typing doesn't survive serialization).

### `licence`

| column | type | notes |
|---|---|---|
| `id` | integer | primary key, singleton row, always `1` |
| `tier` | text | `community`\|`pro`\|`business`\|`enterprise` |
| `activation_token_ref` | text | vault handle |
| `activated_at` | text, nullable | |
| `grace_expires_at` | text, nullable | offline-grace deadline |
| `seat_id` | text, nullable | |

Owned by `packages/licensing` through `repositories/licence.ts`; same raw-secret rejection rule as `connections` applies to `activation_token_ref`.

### `blackboard_entries`

| column | type | notes |
|---|---|---|
| `run_id` | text | fk → `runs.id` |
| `id` | text | |
| `role_id` | text | writer's role, enforces the per-role write-scope rule from F5.3 |
| `key` | text | |
| `value_json` | text | |
| `written_at` | text | |
| `scope` | text | write-scope tag, checked against the swarm node's `blackboard.writeScopes` config at write time |

Append-only, written by collaborative-swarm agent nodes during a `swarm` node's execution; every write is attributed (`role_id`) and timestamped (`written_at`) per F5.3's requirement, and no repository method updates or deletes an existing entry — conflict resolution happens by writing a new entry, not mutating one.

### `dead_letter`

| column | type | notes |
|---|---|---|
| `id` | text | pk |
| `run_id` | text | fk → `runs.id` |
| `node_id` | text | the fan-out node, not the body step that failed — the step is named in `error` |
| `item_index` | text | position in the input array, so a report reads in the order the user's own list is in |
| `item_json` | text | the fan-out item (or swarm task) that failed past its retry policy |
| `error` | text | |
| `ts` | text | |

Widened by migration `0006` (M5-1). `0001` created this table ahead of the
feature that would use it, with no primary key and no record of *which* item
failed; a row you cannot address is a row you cannot clear once it is dealt
with. It was recreated rather than altered — SQLite cannot add a primary key to
an existing table, and the table had never been written to.

Written by `fanout` and `swarm` node runners when an item exhausts its retry policy under `onItemError: dead_letter`; read by the run view's failure report (F5.1's "on budget, with a failure report" exit criterion for M5) and by the aggregate node when a strategy needs to know what was excluded.

### `evals` / `eval_runs`

| column | type | notes |
|---|---|---|
| `workflow_id` (evals) | text | fk → `workflows.id` |
| `eval_id` | text | matches an entry in the workflow definition's `evals[]` |
| `ran_at` (eval_runs) | text | |
| `pass_fail` (eval_runs) | text | |
| `assertions_json` (eval_runs) | text | per-assertion pass/fail detail |

Written by `eval:run`, both on-demand and by the golden-eval CI job (`docs/TESTING.md`) that runs every shipped template's evals against `packages/providers/src/mock.ts` on every commit. A workflow version cannot be tagged `production` while its most recent `eval_runs` entries show a failing assertion — enforced at the tagging call site, not at the schema-validation layer, since evals are a runtime concern and validation rule 7 (its numbered list) doesn't cover them.

**Rule, restated:** any column that would otherwise hold a secret stores a vault handle instead. This is not only `connections.auth_ref` and `licence.activation_token_ref` — it is a standing constraint on every future migration. `packages/store`'s repository layer is the enforcement point, and the trace writer additionally runs a redaction pass over `traces.payload_json` for secret-shaped strings (matching common API-key formats) as defence in depth, in case a secret ever reaches a prompt or tool-result payload through a path that didn't originate from the vault (e.g. a user pasting a key into a workflow input by mistake).

---

## 6. Error taxonomy

`packages/errors/src/errors.ts` defines the base class and every subclass used across the codebase:

    ChimeraError extends Error
      code: string        // stable, machine-matchable, e.g. "GOVERNOR_BUDGET_EXCEEDED"
      message: string      // human-readable
      details?: unknown    // structured context, never raw secret material

Subclasses:

| Class | Raised by | Typical `code` |
|---|---|---|
| `GovernorLimitError` | `packages/core/src/governor` | budget/step/depth/stall/rate-limit exceeded |
| `ProviderError` | `packages/providers/src/adapters/*` | generic provider failure |
| `ProviderAuthError` | adapters | authentication rejected by provider |
| `ProviderRateLimitError` | adapters | provider-side 429/throttle |
| `ToolError` | `packages/tools/src` | generic tool failure |
| `ToolAllowlistError` | `packages/tools/src/allowlist.ts` | tool not in the calling role's allowlist |
| `ToolExecutionError` | `packages/tools/src/servers/*` | tool ran but failed |
| `ValidationError` | `packages/core/src/engine/validator.ts`, IPC handlers | schema/save-time rule violation, envelope version mismatch |
| `VaultError` | `packages/store/src/vault.ts` | keychain read/write failure |
| `SidecarError` | `packages/control/src/sidecar` | M8+, sidecar process crash, protocol violation, or timeout |

**Never throw raw strings** — every error surface in `packages/*` and `apps/desktop/src` throws a `ChimeraError` subclass, caught and handled at a boundary (an IPC handler, a node runner's error edge, the top-level run-loop catch).

**Crossing the IPC boundary.** Errors do not survive serialization as `Error` instances — `postMessage`/`ipcRenderer.invoke` structured-clones plain data, and an `Error` subclass's prototype chain and stack do not round-trip meaningfully into the renderer. Every IPC handler in `apps/desktop/src/ipc/` catches a thrown `ChimeraError` at the handler boundary and serializes it to `{ code, message, details }` before returning it to the renderer. A raised error whose payload would embed sensitive data (a `ProviderAuthError` carrying a partial key, for instance) is redacted at the point of construction, before it ever reaches this boundary — `details` on an auth-flavoured error never includes the credential itself, only the connection id it belongs to.

**A second, separate boundary — verified empirically in M0-4, not just reasoned about.** `contextBridge.exposeInMainWorld` has its own, independent loss of fidelity: a value *thrown* from a function it exposes crosses from preload's isolated world into the renderer's main world as a plain `Error` with exactly `stack` and `message` preserved — `name` is flattened to the generic `"Error"`, and any custom subclass or extra property (`code`, `details`) is silently dropped, confirmed by direct test in `apps/desktop/e2e/ipc.spec.ts`. This means the plan of "the preload-side wrapper reconstructs a renderer-local error-shaped object for the UI to branch on by `code`" does not survive this second hop as written — a real `.code` property is not there to branch on. The actual mechanism (`apps/desktop/src/ipc/clientError.ts`): `message` is the *only* field guaranteed to cross, so `invoke()` throws with `message` set to the JSON-encoded `{ code, message, details }` envelope rather than prose, and a `parseIpcError()` helper (also exposed as `window.chimera.parseError`) is the documented way to decode it back into a typed object. UI code branches on `parseError(err)?.code`, never on parsing prose out of `.message` directly.

---

## 7. The Governor enforcement mechanism

This is the architectural spine referenced throughout this document and the reason the layer model places the Governor above the agent runtime.

**Call path.** `packages/core/src/governor/Governor.ts` exposes exactly two entry points that matter for the no-bypass rule:

    Governor.authorizeModelCall(request: ModelCallRequest): AuthorizationResult<ModelCallRequest>
    Governor.authorizeToolCall(request: ToolCallRequest): AuthorizationResult<ToolCallRequest>

`AuthorizationResult<T>` is `{ decision: 'allow'; request: T; notes }` or `{ decision: 'deny'; code; message; details }`. The allow branch carries the request back because the Governor may return a *modified* one (the model downgrade below); callers dispatch `result.request`, never the request they submitted. It is parameterised so a model-call authorization cannot be mistaken for a tool-call one — the same type this section always described, stated precisely. Implemented in `packages/core/src/governor/types.ts`; frozen as of M2-1.

`packages/core/src/runtime/agentLoop.ts` calls `authorizeModelCall()` immediately before every provider invocation the agent loop wants to make (a plan step, an act step, a verify step) and calls `authorizeToolCall()` immediately before every tool invocation. The engine's tool-calling node runners (`nodeRunners/tool.ts`, and the tool-invoking path inside `nodeRunners/agent.ts`) do the same. Neither the runtime nor the engine holds a reference to a provider adapter or an MCP server — the only object they hold that can reach one is the Governor, and the Governor's `authorize*` methods return an `AuthorizationResult`, not a live handle to the adapter. The actual dispatch (calling `adapter.chat()` or `toolRegistry.invoke()`) happens in the runtime/engine code *after* a successful `AuthorizationResult`, using the Governor-approved, possibly Governor-modified request (e.g. Governor may downgrade to a cheaper model under `budget.onExceed: degrade_to_cheaper_model`) — the Governor is consulted for every call, not just the first one in a loop.

**What `authorizeModelCall()` checks:**
1. Remaining budget at run, node, and role level (`budget.ts`) against the request's estimated token/cost consumption.
2. Recursion depth and total step count against the workflow's declared limits (`limits.ts`).
3. Stall condition — has the calling node's last N iterations produced no new information (`stallDetector.ts`, comparing output similarity and tool-call novelty)?
4. Rate-limit headroom on the target connection (`rateLimiter.ts`'s token-bucket state); if exhausted, either backs off with jitter or spills over to the next connection in the workflow's configured chain.
5. Capability match — does the requested model actually support what the node needs (tool-calling, vision, structured output), per `packages/providers/src/capabilityMatrix.ts`? (This is also checked at save time by the validator per schema rule 4; the Governor re-checks at call time because a connection's available models can change between save and run.)

**What `authorizeToolCall()` checks:**
1. Allowlist membership — is the requested tool in the calling role's `toolAllowlist`, per `packages/tools/src/allowlist.ts`? Rejected independent of anything the prompt or a prior tool result said, which is the concrete mechanism behind CLAUDE.md's "capability limits are the real defence, not prompt wording."
2. Egress allowlist — for network-capable tools (`http`, `search`, `browser`), is the target domain in the workflow's `policy.egressAllowlist`? (Enforced again, redundantly, inside `http.ts`/`browser.ts` themselves as defence in depth — see `docs/SECURITY.md`'s egress-control row.)
3. Approval-gate requirement — does this tool match `policy.requireApprovalFor`, and if so, has an approval node executed upstream in this run (or does the workflow carry an explicit pre-authorisation flag)? This is the runtime half of schema validation rule 7; `dagExecutor.ts` refuses to execute the node if neither condition holds, independent of what `validator.ts` already checked at save time — a workflow edited to remove the approval node after being tagged production would still be caught here.
4. Budget and rate-limit checks, same mechanism as the model-call path, scoped to tool cost where the tool itself has a cost (e.g. a paid search API fronted by the `http` server).

**Structural, not conventional, bypass prevention.** Two independent mechanisms make "no bypass path" true by construction rather than by discipline: (a) the ESLint `no-restricted-imports` rule in §3, which makes it a lint failure — caught in CI before merge — for `packages/core/src/runtime` or `packages/core/src/engine` to import an adapter or a tool server directly, and (b) the fact that `packages/providers` and `packages/tools` never import `packages/core` (§3's dependency-direction rule), so even a determined attempt to reach into an adapter from the runtime cannot use the Governor's own imports as a back door — there is no path through the Governor's module graph that hands the runtime a live adapter reference. The only object the runtime or engine ever holds that can reach a provider or a tool is the Governor's `authorize*` return value plus the dispatch call the runtime/engine itself performs afterward — and that dispatch call target (`packages/providers`'s public `registry`/adapter interface, `packages/tools`'s public `toolRegistry.invoke`) is itself unreachable except through the same public interfaces those packages already expose to `packages/core` at the top of the file — i.e., authorization is not a gate bolted in front of an otherwise-open door, it is the only door.

---

## 8. Monorepo tooling

DECISION: use **npm workspaces** (built into npm, ships with the Node toolchain already required by every other stack choice) for the monorepo, rather than Turborepo, pnpm, or Nx. Rationale: CLAUDE.md requires asking the user before adding any new dependency, and Turborepo, pnpm, and Nx are each a new tool in the developer's environment and CI pipeline; npm workspaces achieves the one thing this project actually needs from monorepo tooling at this stage — shared `node_modules` hoisting and `packages/*`/`apps/*` cross-linking via `workspace:*`-equivalent local resolution — without that ask. `package.json` at the repo root declares `"workspaces": ["packages/*", "apps/*"]`. This is revisited, not permanently foreclosed: if build-graph caching or task orchestration becomes a real bottleneck (many packages, slow CI), that is a concrete, arguable case to bring to the user for one of the excluded tools — it is out of scope for this document because the master plan does not ask for it and CLAUDE.md's dependency rule means it is not this document's call to make unilaterally.

---

## Footnote: correcting a stale diagram

`docs/MASTER_PLAN.md` §3.1's layer-model diagram labels the shell "Tauri window." This is stale: §3.3 of the same document resolves the shell stack to Electron over Tauri, with a full rationale (single-language stack, TypeScript-native tooling for Playwright/MCP SDK/React Flow, a solo non-technical founder's risk profile against Rust's learning curve), and `CLAUDE.md` states "Shell: Electron" as a standing project fact. This is a bug fix using the plan's own later, more authoritative text, not a new decision — the diagram in §1 above reads "Shell — Electron window, routing, command bar" accordingly, and no other document in this set should be read as reintroducing Tauri anywhere in the stack.

---

## Decisions made in this document

- **`packages/licensing` scope**: holds licence activation/validation only, no product logic — isolating it now makes the M7 public/private repo split mechanical (one directory, one import boundary) rather than a search for scattered conditionals.
- **ESLint `no-restricted-imports` as the bypass-prevention mechanism**: scoped to `packages/core/src/runtime/**` and `packages/core/src/engine/**`, blocking direct imports of `packages/providers/src/adapters/*` and `packages/tools/src/servers/*` — enforced at CI/lint time, before a bypass can ship, rather than caught only by a runtime check or code review.
- **`AuthRef` as a branded nominal type** (not a plain `string`) at the `connections` and `licence` repository boundary, backed by a runtime shape-check for payloads arriving over IPC — makes "secrets never leave the vault" a compile-time property in-process and a checked invariant at the one place (IPC) where TypeScript's nominal typing doesn't survive serialization.
- **IPC error redaction is enforced via a per-channel `sensitive` flag read by shared logging middleware**, not by requiring each handler to self-censor — a new sensitive channel is safe by default the moment it's flagged, not contingent on every future handler author remembering to redact.
- **Trace payload redaction as defence in depth**: `traces.payload_json` is scanned for secret-shaped strings before write, on top of (not instead of) the vault-handle discipline, in case a secret reaches a prompt or tool result through a path that didn't originate in the vault (e.g. a user pasting a key into a workflow input).
- **Migration tracking via a singleton `_migrations` table, forward-only, no down-migrations**: a schema mistake is corrected by a new migration, not a rollback, keeping a production database's migration history a strictly increasing, replayable sequence.
- **Cache reads/writes sit downstream of Governor authorization**, not as a bypass around it: a cache hit is treated as a served, authorized call, not a free pass around budget/rate accounting.
- **npm workspaces for the monorepo**, explicitly ruling out Turborepo/pnpm/Nx for this stage without asking the user first, per CLAUDE.md's dependency-addition rule — revisitable later as a concrete, arguable ask if build-graph caching becomes a real bottleneck.
- **Production-tagging gate reads `eval_runs` at the tagging call site**, not inside `validator.ts`'s save-time rules, since evals are a runtime concern (they require executing the workflow against the mock provider) that the schema's eight save-time validation rules don't cover.
