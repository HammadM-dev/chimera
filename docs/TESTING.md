# CHIMERA — Testing strategy

Status: implementable spec. Companion documents: `docs/ARCHITECTURE.md` (package layout, dependency direction, error taxonomy), `docs/SECURITY.md` (§8, the `evals/injection/` corpus this document wires into CI), `docs/WORKFLOW_SCHEMA.md` (the `evals[]` array shape golden evals are built from), `docs/ROADMAP.md` (milestone exit criteria, most of which are testing claims).

This document expands master plan §7's six categories — unit, integration, golden evals, E2E, chaos, security — into concrete per-package conventions, the mock provider's full interface, the golden-eval CI wiring, chaos-suite mechanics, and how the security corpus fits alongside golden evals as a distinct CI job. Nothing here proposes a new dependency; per CLAUDE.md, that requires asking the user first, and this document does not.

---

## 1. Test runner and monorepo conventions

DECISION: use Node's built-in test runner (`node:test` plus `node:assert`) for all unit and integration tests, not Vitest or Jest — rationale: CLAUDE.md requires asking the user before adding a dependency, and both Vitest and Jest are new tooling; `node:test` ships with the Node version the project already requires for Electron and npm workspaces (see `docs/ARCHITECTURE.md`'s npm-workspaces decision), needs no config file to discover and run a colocated `*.test.ts` file, and its `describe`/`it`/`before`/`after`/mocking (`node:test`'s `mock` module) surface is sufficient for everything this project needs from a unit/integration runner. Playwright is already committed by the master plan itself (§3.3, browser control) so it is reused as the E2E driver with no new ask — one fewer test framework to maintain, not a compromise pick.

TypeScript execution for tests uses the same `tsx`/`ts-node`-equivalent loader the rest of the build already requires to run TypeScript under Node — whichever the build tooling settles on for `apps/desktop`'s own dev loop is the one test invocation reuses; this document does not introduce a second one.

### 1.1 File location and naming

Tests are colocated with the source they exercise, never in a parallel `__tests__/` or top-level `test/` tree, so a file and its test travel together in diffs and neither can go stale unnoticed:

    packages/core/src/governor/budget.ts
    packages/core/src/governor/budget.test.ts
    packages/core/src/engine/validator.ts
    packages/core/src/engine/validator.test.ts
    packages/providers/src/mock.ts
    packages/providers/src/mock.test.ts

Integration tests that exercise more than one module inside a package (e.g. the engine driving the mock provider through a full node runner) live in that package's `src/` tree too, named for the behaviour under test rather than a single source file, e.g. `packages/core/src/engine/dagExecutor.integration.test.ts`. DECISION: the `.integration.test.ts` suffix (rather than a separate directory) is this document's convention for integration tests, because npm's workspace-level `test` script and `node:test`'s own glob support both resolve `*.test.ts` uniformly — a second suffix segment is enough to let CI select "integration only" or "unit only" subsets via glob without a directory split that would separate a module from its integration coverage.

Chaos tests live in a dedicated top-level location, since they exercise the built Electron app end-to-end and belong to no single package: `evals/chaos/*.test.ts` (see §4). Golden-eval wiring lives in `evals/golden/runTemplateEvals.test.ts` (see §3). The injection corpus payload files live in `evals/injection/` per `docs/SECURITY.md` §8; the CI job that runs them is `evals/injection/runInjectionCorpus.test.ts` (see §5). E2E specs live in `apps/desktop/e2e/*.spec.ts`, using Playwright's own `.spec.ts` convention rather than `.test.ts`, to keep "run under `node:test`" and "run under `playwright test`" visually distinguishable in a directory listing and in CI job filters.

### 1.2 Per-package conventions

| Package | What unit tests cover | What integration tests cover |
|---|---|---|
| `packages/core/src/governor` | Budget arithmetic (`budget.ts`), limit comparisons (`limits.ts`), stall-detector similarity scoring (`stallDetector.ts`), token-bucket math and backoff/jitter calculation (`rateLimiter.ts`), cost-preview estimation (`costPreview.ts`) — all pure-function-shaped, no I/O, run in milliseconds | `Governor.authorizeModelCall()`/`authorizeToolCall()` against a real (in-memory) `packages/store` instance and `packages/providers/src/mock.ts`, asserting a call over budget is rejected before it reaches the mock adapter |
| `packages/core/src/engine` | `validator.ts`'s eight save-time rules, one test per rule per pass/fail case; `dagExecutor.ts`'s topological ordering and loop-body iteration on small synthetic graphs | Each `nodeRunners/*.ts` driven end-to-end through `dagExecutor.run()` against `packages/providers/src/mock.ts`, one integration test file per node type mirroring the `nodeRunners/` file split |
| `packages/core/src/runtime` | `promptAssembly.ts`'s envelope construction (never string-concatenation) in isolation; `roleRegistry.ts` CRUD; `checkpoint.ts` journal-write shape | `agentLoop.ts`'s full plan-act-observe-verify-decide cycle against the mock provider, asserting exit on verified success, budget exhaustion, depth limit, stall, and cancel — one test per exit condition |
| `packages/providers` | `capabilityMatrix.ts` lookups and the tool-calling-model-required validator check; each adapter's request/response normalisation against a fixture response body (no network) | `registry.ts` connection resolution plus adapter dispatch through `mock.ts` acting as a stand-in for every other adapter's interface shape (see §2) |
| `packages/tools` | `allowlist.ts` allow/deny matrix; `toolRegistry.ts` registration and lookup | `mcpClient.ts` against an in-process fake MCP server; each internal server (`filesystem.ts`, `shell.ts`, `http.ts`, `browser.ts`) against a temp sandbox directory, asserting path-traversal and egress-allowlist rejection |
| `packages/store` | Migration ordering and `_migrations` bookkeeping; each repository's typed query methods against an in-memory/temp-file SQLite database; `vault.ts`'s `AuthRef`-vs-raw-string rejection | Full `db.ts` init (WAL pragma, migration run) plus every repository exercised against the same temp database in one process lifecycle, mirroring a real app boot |
| `packages/control` | Sidecar bridge protocol message (de)serialisation (unit, no live sidecar); Playwright profile-manager path/isolation logic | Browser tool set driven against a local static-file test page served from a temp directory (no external network) |
| `apps/desktop` | IPC envelope versioning helpers; CSP policy string; permission-handler default-deny table; `sensitive=true` redaction middleware | IPC channel handlers invoked in-process against a stub `BrowserWindow`/`webContents`, asserting the request/response envelope round-trips and sensitive channels are redacted before their payload reaches the trace/log sink |
| `apps/ui` | Design-token usage lint (no inline hex — enforced by ESLint, not `node:test`); pure presentational/formatting helpers | Deferred to Playwright E2E (§6) rather than a separate React integration layer, since the UI's integration surface is "does it drive the real app," which E2E already covers; this document does not add a component-testing library, consistent with the no-new-dependency rule |

### 1.3 What "fast and exhaustive" means for unit tests

Per master plan §7, unit tests for governor arithmetic, schema validation, and capability matching are exhaustive over the input space where that space is small and enumerable (e.g. every `onExceed` value × every budget dimension for `budget.ts`; every validation-rule pass/fail branch for `validator.ts`) and property-style over ranges where it is not (e.g. `rateLimiter.ts`'s backoff/jitter, asserted to stay within documented bounds across a swept range of attempt counts, using `node:test`'s own loop constructs — no property-testing library is added for this, consistent with §1's no-new-dependency stance). The whole unit suite for `packages/core` and `packages/providers` is required to run in well under a minute on a developer machine; if it does not, that is treated as a signal a test has accidentally acquired real I/O and should be reclassified as integration.

---

## 2. The mock provider — `packages/providers/src/mock.ts`

`MockProvider` is the single test double for every provider adapter in the codebase. It implements the exact same adapter interface every real adapter implements (per `docs/ARCHITECTURE.md` §3's provider-layer public interface: a `chat(normalisedRequest)` method taking the OpenAI-compatible normalised request shape and returning a normalised response, plus the same streaming and capability-declaration surface every adapter exposes), so any code written against "an adapter" — the engine's `agent`/`tool` node runners, `agentLoop.ts`, the Governor's `authorizeModelCall` call sites — cannot distinguish `MockProvider` from `anthropic.ts` or `openai.ts` by shape. This is what makes the same code path serve three different consumers without a `NODE_ENV === 'test'` branch anywhere in `packages/core`:

1. **CI unit/integration tests** (§1) — a `MockProvider` instance configured per-test with scripted responses.
2. **Golden evals** (§3) — the real engine, the real validator, the real Governor, running a shipped template's graph with `MockProvider` standing in for every `ProviderConnection` the template references.
3. **Interactive dry run** (F7.9, workflow builder) — when a user clicks "dry run" in the GUI, `run:start`'s IPC payload carries a flag routing the run's `ProviderConnection` resolution to a workspace-scoped `MockProvider` instance instead of `registry.getConnection()`'s normal adapter lookup, so a user validates graph wiring without a live key or spend. The run view, trace writer, and node-status UI are unmodified — they read `traces`/`node_states` exactly as they would for a real run, because `MockProvider` writes real trace rows through the same `dagExecutor.ts`/`agentLoop.ts` code path a live run uses.

DECISION: dry run is implemented as a `ProviderConnection` resolution-time swap (the engine still calls "an adapter," it is simply hairpinned to `MockProvider`), not a separate `dryRunExecutor.ts` code path — rationale: the master plan's single-code-path philosophy (adapters differ only in `packages/providers`, never in branching engine logic) argues directly against a parallel execution path for dry run; a second executor is exactly the kind of engine-level branching CLAUDE.md hard rule 7 rules out, and it would silently drift from the real executor's behaviour over time (loop/budget/approval-node handling would need to be maintained twice).

### 2.1 Determinism

`MockProvider` makes no network calls, ever — this is what makes it safe to run in CI (CLAUDE.md: "never hit a real API in CI") and safe to run inside a customer's dry run without an egress prompt. Given the same configured script and the same sequence of calls, it returns byte-identical responses across runs and across machines: no wall-clock reads inside response generation, no random token counts, no `Math.random()`-seeded content. Token counts and cost are computed deterministically from the input/output text length against a fixed, documented per-mock-model rate table (see §2.3), not sampled.

### 2.2 Configuration surface

DECISION: response selection is queue-first with fingerprint-fallback — the master plan does not specify a resolution strategy, so one is defined here:

    interface MockScript {
      // Consumed in order, one entry per call, regardless of request content.
      // Exhausted before fingerprint rules are consulted. Used by tests that
      // care about call sequence (e.g. "second call returns a 429").
      queue?: MockResponse[];

      // Consulted once the queue is empty (or when no queue is configured
      // at all). Keyed by a fingerprint of the inbound normalised request.
      byFingerprint?: Map<string, MockResponse | MockResponse[]>;

      // Applied when neither a queued nor fingerprinted response matches.
      // Golden evals and dry run rely on this so a template author doesn't
      // have to script every call a workflow might make.
      default?: MockResponse;
    }

    // fingerprint(request) is a pure function of the normalised request:
    // hash of { roleId, modelBinding, goal-template-with-inputs-substituted,
    // toolAllowlist, iteration index within the node }. Two calls with the
    // same fingerprint get the same scripted response, which is what makes
    // a golden eval's "run this template twice, expect the same trace shape"
    // check meaningful.

    type MockResponse =
      | { kind: 'text'; content: string; finishReason: 'stop' }
      | { kind: 'toolCall'; toolId: string; params: unknown; finishReason: 'tool_calls' }
      | { kind: 'structuredOutput'; json: unknown; finishReason: 'stop' }
      | { kind: 'error'; error: 'auth' | 'rateLimit' | 'timeout' | 'contentFilter';
          retryAfterMs?: number };  // 'rateLimit' carries Retry-After, §4.3

`MockResponse.kind: 'error'` is how the chaos suite (§4) and the security corpus's adversarial variant (§5) drive `MockProvider` into failure modes without a real provider ever seeing a request: `'auth'` produces the same shape `ProviderAuthError` construction a real 401 would trigger in an adapter, `'rateLimit'` produces the same shape `ProviderRateLimitError` a real 429 would, carrying `retryAfterMs` the same way a real adapter reads a `Retry-After` header.

A second, separate configuration knob exists for the security corpus specifically:

    interface MockPersona {
      mode: 'cooperative' | 'adversarial-compliant';
      // 'cooperative' (default): MockProvider answers scripted responses
      // regardless of what's in the prompt — this is what every non-security
      // test uses.
      // 'adversarial-compliant': for any inbound request whose *untrusted*
      // content (content that arrived inside an UntrustedContentBlock per
      // docs/SECURITY.md §2.1, never the workflow-authored system/user text)
      // contains instruction-shaped text, MockProvider attempts to comply —
      // it emits a toolCall response matching whatever the injected text
      // asked for, if the model's schema allows any tool call at all. This
      // is the adversarial persona docs/SECURITY.md §8.3 requires for the
      // injection corpus job; it lives here, not in a second mock file,
      // since it is a configuration mode of the same MockProvider, not a
      // different adapter.
    }

### 2.3 Capability declaration and cost model

`MockProvider` declares a small fixed set of synthetic models through the same `capabilityMatrix.ts` shape every real adapter's models are declared through, so template/role bindings that specify `modelTier: cheap | standard | frontier` (per `docs/WORKFLOW_SCHEMA.md`'s fanout node) resolve sensibly under mock: `mock-frontier` (tool-calling, vision, structured-output, streaming all `true`, high per-token cost), `mock-standard` (tool-calling and structured-output `true`, vision `false`, mid cost), `mock-cheap` (tool-calling `true`, everything else `false`, lowest cost), and `mock-no-tools` (tool-calling `false`, used specifically by `validator.ts` tests asserting the save-blocking error when a tool-needing node is bound to a non-tool-capable model). Cost is computed from a fixed, documented per-million-token rate for each of the four, so golden-eval assertions and cost-preview unit tests can assert exact dollar figures rather than ranges.

### 2.4 Usage pattern

    const mock = new MockProvider({
      persona: { mode: 'cooperative' },
      script: {
        byFingerprint: new Map([
          [fingerprintOf({ roleId: 'researcher', ... }),
           { kind: 'structuredOutput', json: { findings: [...] } }],
        ]),
        default: { kind: 'text', content: 'ok', finishReason: 'stop' },
      },
    });
    registry.registerForTest(mock); // test-only registry entry point,
                                     // never reachable from production code

`registry.registerForTest()` DECISION: the production `registry.ts` public interface (`getConnection(id)`) never accepts an ad-hoc adapter instance from arbitrary caller code — only a `ProviderConnection` row resolves to a real adapter. A distinct, clearly-named `registerForTest()` entry point exists solely so integration tests and the dry-run resolution path (§2) can inject `MockProvider` without weakening `registry.ts`'s normal resolution logic or requiring a fake SQLite row for every test.

---

## 3. Golden evals — wiring `templates/*.json` into CI

Per `docs/WORKFLOW_SCHEMA.md`, every workflow document carries an `evals[]` array: `{ id, name, inputs, assertions[]: { path, op, value }, provider }`. Every shipped file under `templates/` is a full workflow document per that schema, and therefore already carries its own `evals[]` — there is no separate "golden eval" file format; a golden eval **is** a template's `evals[]` entry, run against the mock provider, executed through the real engine.

### 3.1 The CI job

`evals/golden/runTemplateEvals.test.ts`, run under `node:test`, as a required check on every commit (per CLAUDE.md: "every shipped template runs as a golden eval on each commit"):

1. Glob every file in `templates/*.json`.
2. For each template, parse it as a `WorkflowVersion.definition_json` document and run it through `packages/core/src/engine/validator.ts`'s eight save-time rules — a template that fails a blocking rule (1, 2, 4, or 7) fails the build immediately; a shipped template is required to be valid by construction, since it is the first thing a new user runs (F7.7, F11.3's onboarding wizard).
3. For each entry in the template's `evals[]` array, resolve its declared `provider` — per `docs/WORKFLOW_SCHEMA.md`, "evals run against the mock provider by default so CI costs nothing" — and instantiate `MockProvider` scripted so that every `agent`/`tool` node the template's graph can reach along the path the eval's `inputs` will drive resolves to a deterministic, template-author-authored response via `byFingerprint` (§2.2). Template authors ship the eval's mock script alongside the template, in a sibling file `templates/<template-id>.evals.mock.json`, loaded by the CI job and fed into `MockScript.byFingerprint`.
4. Invoke `dagExecutor.run(workflowVersion, eval.inputs)` — the real engine, the real Governor (budgets/limits apply exactly as they would in production; a golden eval that busts its own template's declared budget is itself a failure, since it means the template's budget numbers are wrong), the real validator having already passed.
5. Evaluate each of the eval's `assertions[]` (`{ path, op, value }`) against the run's final output/trace, using the same assertion evaluator `eval:run`'s IPC handler uses in the shipped app (one code path — see `docs/ARCHITECTURE.md`'s IPC channel table entry for `eval:run`), so a golden eval passing in CI is the same check a user's on-demand `eval:run` click performs.
6. Record a synthetic `eval_runs` row (or, DECISION: for CI, write to an in-memory/temp SQLite database via the same `packages/store` repository code the shipped app uses, rather than a bespoke CI-only result format — this keeps `evals.ts`'s repository the single place eval-result shape is defined, and lets a future "download CI's eval run as a trace" debugging feature reuse the same rows without a translation layer).

### 3.2 Failure conditions that block the build

- Any template fails `validator.ts`'s blocking rules.
- Any eval assertion fails.
- Any template whose `workflow_versions.tag` would be set to `production` (per `docs/WORKFLOW_SCHEMA.md`: "a workflow with failing evals cannot be tagged production") has a failing `eval_runs` result — enforced here as well as at the runtime tagging call site described in `docs/ARCHITECTURE.md`, so a template that is *shipped* as production-tagged can never reach that state with red evals, not even briefly between a bad commit and someone noticing.
- A template present in `templates/` with no corresponding `evals[]` entries at all — DECISION: this is a build failure, not a warning, because an untested shipped template is the exact failure mode F7.8 exists to prevent, and `templates/` is a small, curated, human-reviewed directory (10–15 templates per F7.7), not user content, so a hard requirement here costs nothing in false positives.

### 3.3 Template authoring requirement

Every new file added to `templates/` in a PR must add its sibling `<template-id>.evals.mock.json` and at least one `evals[]` entry in the same commit — this is enforced by the same CI job (§3.2's last bullet), not by a separate PR-template checklist, since a checklist is advisory and a failing build is not.

---

## 4. Chaos suite — `evals/chaos/*.test.ts`

The chaos suite drives the **built** Electron app (the same artifact E2E tests run against, §6) rather than in-process unit fixtures, because the four scenarios below are specifically about process boundaries, crash recovery, and I/O failure — properties that only exist once the app is actually multiple OS processes talking over the real IPC/worker boundaries `docs/ARCHITECTURE.md` describes. Each scenario is its own `node:test` file; each drives the built app via the same Playwright Electron driver E2E uses (§6), so "kill the app" means killing a real OS process, not mocking a function call.

| Scenario | Mechanics | Pass condition |
|---|---|---|
| **Kill mid-run** | Start a run of a multi-node template (fan-out or multi-step agent workflow) against `MockProvider` with a scripted multi-second delay between steps; once `node_states` shows at least one node past its first checkpoint, `SIGKILL` the main process (and, separately, a second variant that kills only the `utilityProcess` worker hosting the run, per `docs/ARCHITECTURE.md`'s worker-crash-isolation design). Relaunch the app. | On relaunch, `dagExecutor.ts` finds the run in `running` status, reads each node's `checkpoint_json` from `node_states`, and resumes from the last completed step — no node re-executes a step it had already checkpointed past, and any side-effectful tool call re-attempted during resume carries the same idempotency key `checkpoint.ts` issued before the kill (asserted by scripting `MockProvider`'s tool-call handler to fail the test if it ever sees the same idempotency key with different call content, which would indicate a non-idempotent retry). Run reaches `completed` status. |
| **Revoke key mid-run** | Start a run; after N successful calls, reconfigure the run's `MockProvider` script (via the queue mechanism, §2.2) so the next call returns `{ kind: 'error', error: 'auth' }`. | The adapter layer raises `ProviderAuthError` (per `docs/ARCHITECTURE.md`'s error taxonomy); the Governor/engine surface it as a `decision` trace event, the run transitions to a failed/halted state with `runs.error_summary` populated, and — critically — the run does **not** silently retry the same connection forever or crash the process; if the workflow has a configured fallback `ProviderConnection` (spillover chain, F1.6), the second variant of this test asserts the run's subsequent calls route to the fallback connection instead of hard-failing. No partial/corrupt `node_states` row results — the node that was mid-call when the key was revoked is left in a well-defined `failed` (or `retrying`, pre-fallback) state, never `running` with no checkpoint. |
| **Rate-limit mid-run** | Configure `MockProvider` to return `{ kind: 'error', error: 'rateLimit', retryAfterMs: <n> }` for a scripted subset of calls (e.g. every 3rd call to a given connection), simulating a provider-side 429. | `packages/core/src/governor/rateLimiter.ts` catches the `ProviderRateLimitError`, honours `retryAfterMs` as the floor for its backoff-with-jitter wait (asserted by timestamping trace `retry` events and checking the gap is ≥ `retryAfterMs`), retries the call, and — for a fan-out node with a configured connection chain — spills over to the next connection once a configured consecutive-429 threshold is hit rather than retrying the same connection indefinitely. The run completes without exceeding its declared wall-clock budget by more than the sum of the scripted retry delays (i.e. the Governor's wall-clock accounting includes time spent backing off, it does not "pause the clock" during a retry). |
| **Fill the disk** | A fixture SQLite database and workspace directory pre-sized (via a sparse file or an actual filled buffer file, machine-portable) to leave a fixed, small amount of free space on whatever filesystem the CI runner mounts for the test's temp directory, such that a run's trace/checkpoint writes exhaust it partway through. | `packages/store`'s write path (better-sqlite3 under WAL) surfaces the OS `ENOSPC`/SQLite `SQLITE_FULL` condition as a typed `ChimeraError` (a `VaultError`/store-layer equivalent per `docs/ARCHITECTURE.md`'s taxonomy — DECISION: this document requires the store layer to wrap `SQLITE_FULL` specifically rather than let it propagate as a raw better-sqlite3 exception, since CLAUDE.md forbids raw-string throws and every other I/O failure in the taxonomy is typed), the run transitions to a failed state with a clear `error_summary`, and — the actual pass condition — the SQLite database file is not left corrupt: WAL mode's rollback-journal semantics mean a failed write does not partially apply, and the test asserts the database re-opens cleanly and every `node_states`/`traces` row written before the disk filled is intact and readable after the test frees the disk space back up. No data corruption, no silent truncation, a clean typed failure the user can act on (free disk space, resume). |

DECISION: all four chaos scenarios are required CI checks, not manual/occasional runs, because they are exactly the four bullet points the master plan names explicitly in §7 as the chaos suite's contents and the risk register's "memory growth over long unattended runs" mitigation depends on the kill-mid-run scenario specifically being exercised continuously, not periodically. They run in a separate CI job from unit/integration/golden (longer-running, spins up a real Electron process per scenario) but block merge on the same terms.

---

## 5. Security corpus — `evals/injection/` (cross-reference: `docs/SECURITY.md` §8)

The full corpus design — directory layout (`evals/injection/<category>/<payload-id>.json`), the eight category directories, the per-payload JSON shape, and the `expectedOutcome` vocabulary — is specified in `docs/SECURITY.md` §8 and is not repeated here beyond what's needed to place it correctly in the CI topology. This document's concern is: it is a **separate CI job** from golden evals (§3), with a **different pass/fail axis**.

| | Golden evals (§3) | Injection corpus (this section) |
|---|---|---|
| Job file | `evals/golden/runTemplateEvals.test.ts` | `evals/injection/runInjectionCorpus.test.ts` |
| Mock persona | `cooperative` (§2.2) — the mock answers as scripted, because the point is testing the template's wiring, not the model's behaviour under adversarial input | `adversarial-compliant` (§2.2) — the mock actively tries to comply with injected instructions, because the point is proving the *architecture* stops it even when the model doesn't resist |
| Pass criterion | Assertions in a template's `evals[]` **must succeed** — the workflow must produce the right output | A payload's `expectedOutcome` **must hold** — the workflow must **not** exercise a capability the payload tries to provoke; per `docs/SECURITY.md` §8.3, graded at the capability-execution/trace layer (`tool_call`/`decision` events, Governor authorization log), never by grading the model's textual output |
| What a failure means | A template is broken — regression in engine, node runner, or the template itself | A capability boundary was crossed that shouldn't have been — a security regression, treated with the same or higher severity as a broken golden eval per `docs/SECURITY.md` §8.3 |
| Scope | Every shipped `templates/*.json` file | Every role in `roleRegistry.ts` with a non-empty `toolAllowlist`, run against every payload in the corpus (cartesian, not template-scoped — a payload isn't tied to any specific template) |
| Growth direction | Templates are added deliberately, in step with F7.7's 10–15 shipped set | Append-only and monotonically growing per CLAUDE.md — "this suite only grows"; the CI job itself asserts no payload file is ever deleted or modified after merge (a lightweight check: a payload's `id` once seen in `main` must remain present with byte-identical `payload`/`expectedOutcome` fields in any subsequent PR, a diff-based CI check rather than a runtime one) |

Both jobs run `MockProvider` (§2) — the injection corpus is not a separate mock implementation, it is `MockProvider` configured with `persona.mode: 'adversarial-compliant'` instead of the default, per §2.2. This keeps the "one mock, three consumers" property from §2 true even under the security corpus: the corpus tests the real engine, the real `allowlist.ts`, the real `Governor.authorizeToolCall`, and the real `promptAssembly.ts` envelope construction, with only the mock's response-generation policy swapped, never a parallel test-only engine.

---

## 6. End-to-end — Playwright against the built app

E2E specs (`apps/desktop/e2e/*.spec.ts`) run Playwright's Electron driver (`_electron.launch()`-equivalent) against the actual `electron-builder` output for the current platform (reusing the unsigned CI build matrix `docs/ROADMAP.md` M0 produces — DECISION: E2E does not build a separate debug binary, it runs against the same artifact the CI matrix already produces per-platform, so a passing E2E run is evidence about the thing that will actually ship, not a dev-mode approximation of it), driving real renderer windows through the real preload bridge and real IPC handlers, with `MockProvider` backing any `ProviderConnection` the test scenario touches (via the same `registerForTest`/dry-run resolution path described in §2 — E2E does not hit a real provider either, for the same CI-cost and determinism reasons as every other suite).

Per master plan §7, E2E scope is the critical paths, and only those — E2E is expensive to write and slow to run, so it is not where node-type or edge-case coverage lives (that's §1's integration tier):

- **Onboarding** (F11.3): fresh app state (empty SQLite, empty vault) through connect-a-provider, run-a-template, see-it-work. Asserts the flow that F11.3 names as the retention-predicting metric — time to first successful run — actually completes without a dead end.
- **Run** (F7.4): open a shipped template, start a run, observe the live run view update (per-node status, streaming output, token/cost counters) as `MockProvider` responds, run reaches `completed`.
- **Approve** (F7.3): a template containing a `humanApproval` node; assert the run pauses, the approval card surfaces the expected context and proposed action, and each of approve/reject/edit produces the correct downstream behaviour (approve resumes the node's onward edge, reject routes to the error/rejection path, edit substitutes the edited payload into the resumed node) — this is explicitly called out by the master plan as "what makes CHIMERA sellable into regulated environments," so it is not optional E2E coverage.
- **Cancel** (F7.4): start a run, issue `run:cancel` mid-flight, assert the engine honours it at the next checkpoint boundary (per `docs/ARCHITECTURE.md`'s IPC channel table) rather than killing mid-step, and the run's final status and `node_states` reflect a clean cancellation rather than an ambiguous half-executed node.

E2E does not cover swarm (F5), browser control (F6.2), or native control (F6.3) critical paths in this document's scope — those are M5/M6/M8 deliverables per `docs/ROADMAP.md` and get their own E2E specs added in the milestone that introduces them, following this same file-location and mock-backing convention; this document establishes the pattern, not an exhaustive spec list for milestones not yet built.

---

## 7. CI job summary

DECISION: the six categories map to five distinct CI jobs (unit and integration share a job, since both run under the same `node:test` invocation over the same package tree and splitting them buys nothing `node:test`'s own glob selection doesn't already give a developer locally) — named here so `docs/ROADMAP.md`'s milestone exit criteria and this document use identical job names:

| CI job | Runs | Required for merge from |
|---|---|---|
| `test:unit-integration` | Every `*.test.ts` / `*.integration.test.ts` under `packages/*/src` and `apps/*/src`, via `node:test` | M0 |
| `test:golden` | `evals/golden/runTemplateEvals.test.ts` (§3) | M4 (first milestone with shipped templates) |
| `test:injection` | `evals/injection/runInjectionCorpus.test.ts` (§5) | M2 (first milestone with a tool-enabled role) |
| `test:chaos` | `evals/chaos/*.test.ts` (§4) | M2 (checkpoint/resume exists from M2; rate-limit/spillover scenarios activate fully once M3's Governor lands, key-revoke and disk-full scenarios are meaningful from M2) |
| `test:e2e` | `apps/desktop/e2e/*.spec.ts` via Playwright (§6) | Onboarding/run specs from M4 (canvas + run view exist); approve spec from M4 (`humanApproval` node ships in M4); cancel spec from M4 |

All five are required checks on every pull request from the milestone noted onward — none is advisory-only or nightly-only, per the master plan's framing of golden evals and the injection corpus as blocking, and per this document's §4 decision that chaos is likewise blocking rather than periodic.

---

## Decisions made in this document

- Use Node's built-in `node:test`/`node:assert` for all unit and integration tests instead of Vitest or Jest, to avoid adding a new dependency without asking per CLAUDE.md; Playwright, already committed by the master plan for browser control, is reused as the E2E driver at no new cost.
- Tests are colocated as `*.test.ts` next to source; integration tests use a `*.integration.test.ts` suffix in the same tree rather than a separate directory, so glob-based CI selection works without splitting a module from its integration coverage; chaos (`evals/chaos/`), golden (`evals/golden/`), and injection (`evals/injection/`, per `docs/SECURITY.md`) tests live in dedicated top-level locations since they belong to no single package; E2E specs use Playwright's own `.spec.ts` convention to stay visually distinct from `node:test` files.
- Dry run (F7.9) is implemented as a `ProviderConnection`-resolution-time swap to `MockProvider`, not a separate `dryRunExecutor.ts` code path, to keep the single-code-path philosophy intact and avoid engine-level branching CLAUDE.md hard rule 7 rules out.
- `MockProvider`'s response-selection strategy is queue-first with fingerprint-fallback (`MockScript.queue` / `byFingerprint` / `default`), since the master plan specifies "scripted/canned responses" without a resolution algorithm; fingerprinting is defined as a hash of role/model/goal/toolAllowlist/iteration-index so repeated identical calls resolve identically.
- A second `MockPersona` configuration axis (`cooperative` vs `adversarial-compliant`) is added to `MockProvider` specifically so the injection corpus (`docs/SECURITY.md` §8) reuses the same mock implementation rather than requiring a second test double, keeping "one mock, three-plus consumers" true even under adversarial testing.
- `MockProvider` declares four synthetic capability-matrix entries (`mock-frontier`, `mock-standard`, `mock-cheap`, `mock-no-tools`) with a fixed documented cost table, so template/role `modelTier` bindings resolve sensibly under test and `validator.ts`'s tool-capability save-blocking check has a non-tool-calling mock model to test against.
- `registry.registerForTest()` is a distinct, test-only registry entry point for injecting `MockProvider`, kept separate from the production `getConnection(id)` path so test injection can never weaken production connection resolution.
- Golden-eval mock scripts for shipped templates are stored as a sibling file `templates/<template-id>.evals.mock.json`; a new template PR must add both this file and at least one `evals[]` entry in the same commit, enforced as a CI failure rather than a checklist item.
- A template shipped with zero `evals[]` entries fails the golden-eval CI job outright (not a warning), since `templates/` is small and curated and an untested shipped template is exactly the failure mode F7.8 exists to catch.
- Golden-eval CI results are written through the same `packages/store` `evals.ts` repository the shipped app's `eval:run` handler uses (against an in-memory/temp database), rather than a bespoke CI-only result format, so eval-result shape has one definition.
- All four chaos scenarios (kill mid-run, revoke key mid-run, rate-limit mid-run, fill disk) are required blocking CI checks from the milestone each becomes meaningful (M2 for the first three, fully activated at M3 for rate-limit/spillover), not periodic/nightly jobs, matching how the master plan treats golden evals and the injection corpus.
- The disk-full chaos scenario requires the store layer to wrap SQLite's `SQLITE_FULL`/OS `ENOSPC` condition as a typed `ChimeraError` rather than let a raw better-sqlite3 exception propagate, consistent with CLAUDE.md's ban on raw-string throws and the existing typed-error taxonomy in `docs/ARCHITECTURE.md`.
- E2E runs against the same unsigned per-platform build `docs/ROADMAP.md` M0's CI matrix already produces, rather than a separate debug build, so a passing E2E run is evidence about the artifact that will actually ship.
- The six master-plan test categories map to five CI jobs (`test:unit-integration`, `test:golden`, `test:injection`, `test:chaos`, `test:e2e`), with unit and integration sharing one job since both run under the same `node:test` invocation; each job's earliest-required milestone is stated explicitly so `docs/ROADMAP.md` exit criteria can reference these job names directly.
