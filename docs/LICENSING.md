# CHIMERA — Licensing & Repository Strategy

Status: implementable spec. Companion documents: `docs/MASTER_PLAN.md` (source, §6.1–6.2), `docs/ARCHITECTURE.md` (package layout, `packages/licensing` structural placement), `docs/SECURITY.md` (vault handle format shared with `licence.activation_token_ref`), `docs/ROADMAP.md` (M7 exit criteria).

This document is binding on implementation for everything it covers that is *engineering* fact: which files live in which repository, what `packages/licensing` does, how tier gating is checked in code, what the CLA gate does mechanically. Where the master plan was silent and a concrete choice was required to make the system buildable, the choice is marked inline as `DECISION:` and collected in the closing section.

> **This document is engineering guidance, not legal advice.** BUSL 1.1's exact text, the wording of CHIMERA's Additional Use Grant, the CLA's legal terms, and any judgment about what counts as a "Competing Offering" or "production use" under the license are legal questions with real financial consequences, and `docs/MASTER_PLAN.md` §6.1 says so explicitly: *"Spend the money on a lawyer here. This is your moat and BUSL has sharp edges around what counts as production use."* Nothing below should be treated as a substitute for that review. Where this document states how the license text is *structured* (the Change Date, the Change License, the Additional Use Grant as named sections of the BUSL 1.1 template), that is a description of the license's public mechanics, not a legal opinion about CHIMERA's specific grant language — that language is drafted by counsel, not by this document.

---

## 1. BUSL 1.1, plainly

### 1.1 What it is

The Business Source License 1.1 is a **source-available** license, not an OSI-approved open-source license. The public `chimera` repository is published under it from the first commit. It is not "no license" and it is not "closed source" — it sits deliberately between those two: the source is public and forkable, but commercial redistribution is restricted for a fixed period, after which the restriction lapses automatically.

A BUSL 1.1 `LICENSE` file is a template with four project-specific fields that must be filled in:

    Licensor:              [entity that owns CHIMERA]
    Licensed Work:         CHIMERA, version-dated per release
    Additional Use Grant:  [what uses beyond bare "view and modify" are permitted]
    Change Date:           [date this specific release converts]
    Change License:        Apache License, Version 2.0

The **Additional Use Grant** is the field that does the real work day-to-day: it is where the license states, in plain terms, that running CHIMERA for your own business's internal operations — including in production, including a business paying its own team to operate it — is permitted, while standing up CHIMERA (or a work substantially derived from it) as a hosted or managed service sold to third parties is not, absent a commercial agreement with CHIMERA. **The exact wording of this grant is not decided in this document** — it is the single most consequential sentence in the repository and is drafted by the lawyer referenced in §1.6, not invented here. Everything else in this document assumes that grant follows the conventional BUSL shape (permit internal and production use, restrict competing-hosted-service use) because that is the shape every named precedent in §1.5 uses, but the literal text is out of scope for an engineering document.

### 1.2 What it permits

- Read the full source of the public repository.
- Fork it, on GitHub or anywhere else.
- Modify it, for any purpose, including maintaining a private fork with local patches.
- Use it — including running production workloads on it — internally, within the licensee's own organization, for the licensee's own business.
- Redistribute copies of the source (including modified copies) as long as the BUSL 1.1 license text travels with them.

### 1.3 What it restricts

- Offering CHIMERA, or a work that is substantially the Licensed Work, **as a hosted or managed service to third parties** — i.e., standing up a competing "CHIMERA Cloud" and selling access to it — without a separate commercial license from CHIMERA.
- Selling the Licensed Work itself as a product.

This is a restriction on **competing commercial distribution**, not a restriction on internal use, modification, or even running it as unattended infrastructure for the licensee's own business (F8's whole pitch — "infrastructure that runs the business" — is squarely inside the Additional Use Grant's intended shape, not outside it). A design partner or Business-tier customer running CHIMERA workflows against their own customers' data, on their own machines, is doing exactly what BUSL is meant to allow.

### 1.4 The Change Date and Apache 2.0 conversion

Each dated release of the Licensed Work carries its own Change Date, conventionally four years from that release's publication. On that release's Change Date, that specific version's license automatically converts from BUSL 1.1 to the Change License — Apache 2.0 per the master plan. Because each release has its own clock, this is a **rolling** conversion: the oldest published code becomes Apache 2.0 first, while the current head of the repository remains under BUSL until its own four years elapse. There is no single day the whole project "goes Apache" — it is a continuously trailing window, four years wide, always advancing.

Practical consequence for CI/release tooling: the version-dated `LICENSE` (or a per-release `LICENSE-Change-Date` note, mechanics TBD with counsel) must be able to state a concrete date per tagged release, not one static date for the whole repository — DECISION: `docs/ROADMAP.md`'s M7 ticket for "public BUSL repo" includes a release-tagging convention where each GitHub release carries its own computed Change Date (release date + 4 years) recorded in that release's notes, since the master plan specifies the four-year rule but not how a monorepo with continuous releases tracks a rolling window per version — rationale: without a recorded per-release date, "four years after what" becomes ambiguous the moment there is more than one release, and this is cheap to get right early and expensive to reconstruct later.

### 1.5 Precedent

The master plan names three specific precedents for this exact pattern — public source-available repo, commercial-hosting restriction, timed conversion to a permissive license: **Sentry**, **HashiCorp**, and **CockroachDB**. All three ship (or shipped, in HashiCorp's case, for several products) a primary public repository under a BUSL-family license, with a small separate proprietary layer for the commercial product built on top. §2 below adopts that same two-repository shape for CHIMERA.

### 1.6 The sharp edge: "production use" and why a lawyer is required

The master plan is explicit and this document repeats it verbatim as a standing instruction, not a suggestion: **"Spend the money on a lawyer here. This is your moat and BUSL has sharp edges around what counts as production use."** The specific edges an engineering reader should know exist (without this document attempting to resolve them):

- Where the line falls between "a business runs CHIMERA internally, including for revenue-generating work" (permitted) and "a business offers CHIMERA-as-a-service to others" (restricted) when the licensee is, say, an agency using CHIMERA to deliver services *to clients* — this is close to CHIMERA's own target market (agencies are named explicitly as a primary user segment in `docs/MASTER_PLAN.md` §1) and is exactly the kind of boundary case the Additional Use Grant's wording needs to survive contact with.
- Whether a design partner or early customer modifying and redistributing a patched fork internally across a multi-entity corporate group counts as one licensee or several.
- How the CLA (§5) and the BUSL grant interact for a contributor who is also a commercial competitor.

None of these are answered here. They are flagged so that whoever is scoping the legal engagement in `docs/ROADMAP.md`'s M7 milestone knows what to ask.

---

## 2. Repository split

### 2.1 The boundary decision

The master plan's own §9 lists *"Public/private repo split boundary — exactly which modules are proprietary"* as an open decision to make before writing code, and its §6.1 gives only a coarse first answer ("Private repo holds the licensing server, activation logic, orchestrator scheduling internals, and enterprise features"). This document resolves it precisely, and every other companion document treats the resolution below as final:

> DECISION: the private repository holds exactly three things — (1) `packages/licensing` (activation and validation logic, introduced as a new package around M7, see §3), (2) the future F10 enterprise RBAC/SSO sync backend (not built before M10, data model designed for it now per the master plan's explicit instruction), and (3) any swarm-orchestrator scheduling internals that turn out, once built, to be genuinely proprietary competitive advantage rather than ordinary engine code. **Everything else is public under BUSL 1.1 from day one** — the complete agent runtime, the workflow engine, every provider adapter, every internal MCP tool server, the whole of `packages/store`, `packages/control`, the Rust sidecar, and the entire `apps/ui` and `apps/desktop` UI/shell. Rationale: BUSL 1.1 already provides the commercial protection for the *entire* public repository — it is illegal to sell or host any of it commercially regardless of which specific files a competitor copies. Given that, hiding implementation details in a private repo buys no additional legal protection and only costs velocity (a fork-and-diverge tax on every change that touches the boundary) and credibility (a "public" repo that is mostly stubs undermines the go-to-market §6.3 explicitly wants — "ship the public repo early for the credibility signal," "build in public"). The private repo should therefore be **small and mechanical**: a license check plus, later, an enterprise-only sync backend — not an attempt to obscure how the product works.

This directly narrows the master plan's coarser §6.1 list. "Orchestrator scheduling internals" in the master plan's original sentence is *not* a blanket statement that `packages/core/src/engine`'s fan-out/swarm scheduling code is private — the vast majority of that code (queue management, concurrency dialing, blackboard writes, the map-reduce aggregation node) is ordinary engine logic and ships public under item "everything else" above. Only a specific, identified, genuinely differentiated algorithm inside that area — if one is ever built and judged to be a real moat, not just competent engineering — would be a candidate for extraction into the private repo under item (3).

DECISION: because item (3) is explicitly open-ended ("that turn out to be"), this document does not pre-select any specific swarm-orchestrator code for extraction. The decision of whether a given piece of scheduling logic qualifies is deferred to a concrete review at the end of M5 (when F5 ships and there is real code to evaluate), made by whoever owns the private repo at that time, using this test: does this code represent a meaningful, hard-to-reproduce competitive advantage on its own (not just "the swarm feature works"), and would extracting it break the public repo's standalone buildability (§2.4)? If either answer is no, it stays public. Rationale: inventing a specific extraction target now, against code that does not exist yet, would be exactly the kind of unsupported invention this document's brief asks to avoid — the master plan itself leaves this open, and this document should not manufacture false precision where none exists yet.

### 2.2 Rationale for the two-repository shape

DECISION: CHIMERA follows the same two-repository shape as the named precedents (§1.5): the **public repo** (`chimera`, this repository, BUSL 1.1, public on GitHub no later than the M7 milestone per `docs/ROADMAP.md`) is where the overwhelming majority of development happens and is where external contributors send pull requests. A separate, small **private repo** (`chimera-licensing` — name illustrative, not load-bearing) is created around M7 to hold the three items from §2.1, and it depends on the public repo as an upstream (a pinned npm package resolved from a private registry scope, or a git submodule pinned to a tagged public commit — exact mechanism is a build-tooling decision for M7, not fixed here) rather than the other way around. Rationale: this keeps the high-traffic repository — the one contributors fork, the one that carries the credibility signal §6.3 wants shipped early — fully self-contained and buildable standalone from commit one, with the private repo as a thin additive layer bolted on top for CHIMERA's own official releases, mirroring exactly how Sentry's public `getsentry/sentry` and private `getsentry/getsentry` relate.

### 2.3 What ships in which repo

| Component / path | Repository | Ships to a customer machine as |
|---|---|---|
| `packages/core` (governor, engine, runtime) | public | source, BUSL 1.1 |
| `packages/providers` (registry, capability matrix, adapters, mock) | public | source, BUSL 1.1 |
| `packages/tools` (MCP client, internal servers, allowlist) | public | source, BUSL 1.1 |
| `packages/store` (db, migrations, vault wrapper, all repositories **including** `repositories/licence.ts`) | public | source, BUSL 1.1 — see note below |
| `packages/control` (browser control, sidecar bridge client) | public | source, BUSL 1.1 |
| `apps/desktop`, `apps/ui` | public | source, BUSL 1.1; compiled into the Electron app |
| `sidecar/` (Rust, M8+) | public | source, BUSL 1.1; compiled into the native binary bundled with the app |
| `templates/`, `evals/` | public | source, BUSL 1.1 |
| `packages/licensing-stub` (new, public — see §2.4) | public | source, BUSL 1.1; ships in community/contributor builds only, never in an official release |
| `docs/`, `CLAUDE.md`, future `CONTRIBUTING.md` (§5) | public | source |
| `packages/licensing` (activation `activate()`/`validate()`, grace-period arithmetic, signature verification — see §3) | **private** | **not shipped as source anywhere** — compiled and bundled into official installers only, pulled into the official build as a private binary dependency at CI build time (§2.4) |
| F10 enterprise RBAC/SSO sync backend, client side (future, M10+) | private | same pattern as `packages/licensing`: never source, bundled compiled into official installers that unlock team workspaces |
| F10 enterprise RBAC/SSO sync backend, server side (future, M10+) | private | **never ships to any customer machine at all**, in source or compiled form — it is a hosted service CHIMERA operates |
| Licensing/activation server (issues and validates activation tokens, backs `licence:activate`) | private infra, its own deploy repo (not either chimera repo — see §6) | **never ships to any customer machine at all** — reached only over HTTPS from `packages/licensing` |
| Any extracted proprietary swarm-orchestrator internals (§2.1 item 3, open, not yet decided) | private, if/when extracted | same pattern as `packages/licensing` if the extracted code must run on the customer's machine; server-only if it can run as a CHIMERA-operated service instead |

Note on `packages/store/src/repositories/licence.ts`: this file is **public**. It is a mechanical CRUD repository over the singleton `licence` row — insert/read/update, plus the same raw-secret-rejection rule (an `AuthRef`-typed `activation_token_ref`, see `docs/SECURITY.md` §on vault handles) that every other repository in `packages/store` enforces. It contains no business logic about what a valid license looks like, what a grace period means, or how to talk to the licensing server. That logic — the part actually worth keeping private — lives entirely in `packages/licensing`, which *calls* `repositories/licence.ts` the same way any other package would, rather than reimplementing table access. This split is what makes the public/private boundary "mechanical" per §2.1's rationale: one whole package moves, not a scattering of `if (tier === ...)` conditionals through `packages/store`.

### 2.4 Build-time assembly: how the private package reaches an official build

DECISION: the public repo cannot have a broken or unbuildable dependency on `packages/licensing`, because a core BUSL 1.1 promise is that the public repo is genuinely forkable and buildable by anyone — a repo that fails `npm install` for outside contributors is not meeting that bar regardless of what the LICENSE file says. The public repo therefore ships a package at `packages/licensing-stub/` (public, BUSL 1.1, part of this repo from the moment `packages/licensing` is introduced at M7) implementing the same TypeScript interface `packages/licensing` will expose — `activate(token): Promise<LicenceState>`, `validate(): Promise<LicenceState>` — and always resolving to `{ tier: 'community', seat: null, gracePeriod: null }`. `apps/desktop/src/main.ts`'s startup sequence resolves whichever package is present at build time (the real `packages/licensing` if the build has access to the private registry, the stub otherwise) behind a single import site, so no call site anywhere else in the app needs to know or care which one is linked in.

Official, sellable CHIMERA installers are built by CI running in the **private** repo (§2.2), which has the public repo as a pinned dependency and its own `packages/licensing` alongside it, wired together through the same npm-workspaces mechanism (`docs/ARCHITECTURE.md` §8) used everywhere else in the project — no bespoke build tooling, just an extra workspace member present only in that repo's checkout. A contributor cloning the public repo alone gets a fully functional, single-user, Community-tier build: every feature's *code* is present and runs (BUSL already prevents anyone from reselling or rehosting it regardless of tier gating), only the commercial entitlement check resolves to the permissive stub. This is a deliberate choice, not an oversight: the thing worth gating for commercial reasons is the entitlement check itself, not the underlying feature code, which is public by §2.1's own rationale.

---

## 3. `packages/licensing` — scope and mechanics

`docs/ARCHITECTURE.md` places `packages/licensing` in the repository layout and states it "holds licence activation and validation logic only... Full rationale in `docs/LICENSING.md`." This section is that rationale.

### 3.1 Interface

    packages/licensing/src/
      activate(token: string): Promise<LicenceState>
      validate(): Promise<LicenceState>
      LicenceState = { tier, seatId, activatedAt, graceExpiresAt, status }

Both functions read and write through `packages/store/src/repositories/licence.ts` (public, §2.3) for persistence, and both — for `activate()` always, for `validate()` whenever the app has network reachability — call out over HTTPS to the CHIMERA-operated licensing server (§6). `activate()` exchanges a user-entered activation token for a signed licence receipt; `validate()` refreshes that receipt on a schedule.

DECISION: activation UX is **enter a licence key** — a short opaque string emailed to the customer after checkout — submitted through the existing `licence:activate` IPC channel (already named in `docs/ARCHITECTURE.md`'s channel registry as `invoke`, `sensitive: true`), rather than an OAuth-style device-code browser flow. Rationale: this is the simplest mechanism that satisfies F11.3's onboarding-wizard requirement without adding a browser-round-trip dependency to the M7 critical path, and it matches the channel that `docs/ARCHITECTURE.md` already committed to ("submit an activation token").

### 3.2 Is this a "model call" or "tool call" subject to the Governor?

No, and this is worth stating explicitly because CLAUDE.md's hard rule #1 ("every model call and every tool call goes through the Governor, no bypass path") could otherwise be misread as covering this. `activate()`/`validate()` are first-party application infrastructure — the same category as `apps/desktop/src/autoUpdater.ts` checking CHIMERA's own update feed — not a model call or an agent-initiated tool call made on a workflow's behalf. `Governor.authorizeModelCall()` and `Governor.authorizeToolCall()` exist to gate what a *workflow's agents* do; licence activation is something the *host application* does about itself, before or entirely outside of any run. It correspondingly does not consult a workflow's `policy.egressAllowlist` either — that allowlist governs network access an agent takes through the `http`/`browser` MCP servers, not the app's own housekeeping traffic to a domain the app itself, not a workflow author, controls.

### 3.3 Offline grace period

DECISION: the offline grace period is **14 days** from the last successful `validate()` call. `validate()` runs once at app startup and once every 24 hours while the app is running (not on a tighter loop — there is no product reason to check more often, and a tighter loop only adds load to the licensing server and a false sense of real-time enforcement neither buyer nor seller needs). Each successful validation advances `licence.grace_expires_at` to `now + 14 days`. Rationale for 14 days specifically and for graceful degradation over hard lockout at expiry (below): the master plan specifies "activation with offline grace" as an M7 requirement but not a duration or a failure behavior, and a business customer's trust in the product is directly at stake in getting this wrong — a hard lockout triggered by *CHIMERA's own* licensing-server outage, or by a customer's laptop being offline during a business trip, is a support incident and a churn risk, not a piracy prevention. Fourteen days is long enough to absorb a normal outage or an unconnected work trip and short enough that it is not, in practice, "activation is optional."

DECISION: on grace expiry, the app does **not** lock out. `licence.tier` reported by `licence:status` degrades to `community` until the next successful `validate()`, and the UI surfaces this as a persistent, non-modal status-bar notice — per CLAUDE.md's copy rules, stated as what happened and what to do next, no apology, no exclamation mark (e.g., "licence not verified for 14 days — reconnect to restore [tier] features," never "Oops! Your licence expired!"). Any run already in flight when grace expires is **not** interrupted mid-run; the degradation applies to what a *new* run or save is permitted to do, not to a run the Governor already authorized. This mirrors the same "fail toward safety and continuity, not toward a hard stop that damages trust" instinct the master plan applies to the panic hotkey and rollback features elsewhere (F6.0, F6.4), applied here to the commercial layer instead of the safety layer.

### 3.4 Seats and Enterprise

`licence.seat_id` identifies which purchased seat (Pro/Business are priced per-user/month) this installation is bound to. DECISION: seat assignment, transfer, and any concurrent-activation limits are entirely a licensing-server concern (§6) — the desktop client treats `seat_id` as an opaque, read-only value returned by `activate()`/`validate()` and makes no local decisions based on it beyond displaying it in `licence:status`. Rationale: seat policy is exactly the kind of thing that changes with pricing experiments; keeping it server-side means it never requires a client release to adjust.

DECISION: before F10 (RBAC/SSO, M10+) exists, an Enterprise-tier customer is provisioned by **manually inserting a `licence` row** with `tier = 'enterprise'` via a support-issued activation token — the same `activate()` code path as any other tier, just a token minted by CHIMERA staff rather than a self-serve checkout flow. Enterprise's actual differentiators (SSO, policy controls, air-gapped operation, audit export, SLA) are contractual and operational commitments before M10 ships the corresponding features in-product; this document does not pretend the product delivers them earlier than the roadmap does, but the licensing mechanism itself needs no special-casing to accept an Enterprise customer today.

### 3.5 Feature-additive tier checks

DECISION: `licence.tier` is checked at each gated call site against a **per-node/per-feature minimum-tier table shipped with the app release**, not a fixed matrix hand-written once. Rationale: the pricing table in §4 bundles features that ship on different milestones (swarm mode ships at M5, Tier 2 at M8, RBAC at M10 — all well after the Business tier itself is sold from M7 onward, see §4.2). A Business-tier customer who bought the seat at M7 must automatically gain Tier 2 and RBAC access the moment those milestones land in a release they update to, with no re-activation and no separate purchase. Versioning the gating table with the *release* rather than the *licence* row makes that automatic: `validate()` never needs to know about features that did not exist when the licence was issued.

Enforcement happens at two points, mirroring the defense-in-depth shape `docs/SECURITY.md` uses for the security control table (capability limits over prompt wording): a **soft** check in `apps/ui` greys out gated node types and settings in the canvas and inspector based on the cached `licence:status` result (a UX convenience, not a security boundary), and a **hard** check enforced twice server-side-of-the-renderer — once in `packages/core/src/engine/validator.ts` at save time (a workflow using a node type above the current tier cannot be saved, or, if imported, cannot be tagged `production`), and once in `packages/core/src/engine/dagExecutor.ts` at run time (a hand-edited or imported workflow JSON containing a gated node type is refused at the moment that node would execute, not earlier and not silently allowed). This is the same "capability limits are the real defence" instinct CLAUDE.md states for security, applied here to commercial gating: the UI hint is convenience, the validator/executor checks are the actual boundary.

DECISION: licence-tier enforcement failures reuse the existing `docs/ARCHITECTURE.md`/`docs/SECURITY.md` error taxonomy rather than adding a new `ChimeraError` subclass — the taxonomy is fixed across all six companion documents in this set and this document does not have license to extend it unilaterally. A save-time rejection surfaces as `ValidationError` with `code: 'LICENCE_TIER_REQUIRED_AT_SAVE'`; a run-time rejection surfaces as `GovernorLimitError` with `code: 'LICENCE_TIER_REQUIRED_AT_RUN'`, since structurally both are "this call is not authorized to proceed at the caller's current entitlement," the same shape a budget-limit rejection already has — just gated on tier rather than spend. Both codes carry `details.requiredTier` and `details.currentTier` so the UI can render "upgrade to continue" without string-matching the message.

---

## 4. Tier gating — what's sold, and what's actually enforceable when

### 4.1 Pricing (from `docs/MASTER_PLAN.md` §6.2, reproduced for reference — this document does not change pricing)

| Tier | Price | Contents |
|---|---|---|
| Community | Free | Single user, 3 workflows, Tier 0 + Tier 1, no scheduling |
| Pro | $29/user/mo | Unlimited workflows, scheduling, evals, full trace export |
| Business | $79/user/mo | Tier 2 machine control, swarm mode, team workspaces, RBAC, priority support |
| Enterprise | Contact | SSO, policy controls, air-gapped, audit export, SLA |

Users bring their own provider keys, so there is no inference-token margin in any tier — CHIMERA prices orchestration, reliability, and governance, not model access. This document does not repeat the go-to-market reasoning; see `docs/MASTER_PLAN.md` §6.3.

### 4.2 Minimum-tier table (implements §3.5's per-release gating table)

| Gated surface | Minimum tier | Ships (milestone) | Notes |
|---|---|---|---|
| Workflow count | Community: 3, Pro+: unlimited | M4 | Enforced by `workflow:save` counting non-archived rows in `workflows` against `licence.tier` |
| Trigger types other than `manual` (schedule/webhook/fileWatch/folderDrop/hotkey) | Pro | M9 | "No scheduling" in Community per §4.1 |
| `evals[]` execution (`eval:run`) | Pro | M9 | |
| Trace export (JSON, not in-app viewing) | Pro | M4 (viewing), M9 (the "full" export the pricing copy names — see caveat below) | In-app trace viewing (F7.5) ships free at M4 for every tier; the pricing table's "full trace export" is read as the exportable-file form |
| `fanout` and `swarm` node types (all of F5) | Business | M5 | DECISION (§2.1-adjacent): "swarm mode" in the pricing copy is read as covering both F5.1 fan-out and F5.2 collaborative swarm — the master plan ships them together as one milestone and prices them as one line item, and this document does not invent a finer split the master plan does not state |
| Tier 2 native-control node configs | Business | M8 (Windows), M10 (Linux X11, macOS) | Node type is `tool`, `config.toolId` pointing at a sidecar-backed tool; gating is per-toolId, not per-node-type, since Tier 0/1 tools also use the `tool` node type |
| Team workspaces / RBAC | Business | M10 | Not enforceable before F10's data model and sync backend exist; see §3.4 for how an early Business seat is honored in the interim |
| SSO/SAML, policy controls, air-gapped mode, audit export, SLA | Enterprise | M10 (policy/audit), local-only mode flag (F1.7) already available at any tier from M1 | Air-gapped operation and local-only mode are related but distinct: F1.7's local-only workspace flag is a Community-available connectivity restriction, not an Enterprise entitlement — Enterprise's "air-gapped" line item in §4.1 is about the *commercial and support* posture (audit export, SLA, offline licensing accommodations), not gating F1.7 itself behind a paywall |

**Caveat this table makes explicit, flagged for the roadmap owner:** several Business-tier line items (Tier 2, RBAC) do not exist in the product until well after Business itself goes on sale at M7. §3.4 and §3.5 describe how that gap is handled commercially (feature-additive entitlement, no re-purchase). This is a real sequencing consequence of the master plan's own milestone order and pricing table existing independently of each other, not an error in this document — flagged here rather than silently smoothed over.

---

## 5. Contributor licence agreement (CLA)

The master plan states the requirement directly: *"`CONTRIBUTING.md` needs a CLA so contributed code doesn't compromise your ability to relicense."* `CONTRIBUTING.md` is **not created in this session** — it is a pending deliverable, tracked against the M7 milestone in `docs/ROADMAP.md` alongside the public repo's first publication, since a CLA gate only matters once the repo is accepting outside pull requests, which per §2.2 is the point of publishing publicly at all.

DECISION: the CLA requirement is a **CLA**, not merely a **DCO** (Developer Certificate of Origin sign-off, the lighter mechanism projects like Linux and Docker use). Rationale: a DCO only certifies that the contributor has the right to submit the code *under the project's current license terms* — it does not grant the project the broader rights a future relicensing decision might need. CHIMERA already has one scheduled relicensing event baked into BUSL itself (the per-release Change Date conversion to Apache 2.0, §1.4), and may need to make further licensing decisions later that a DCO does not anticipate (adjusting the Additional Use Grant in a future release, entering a dual-license arrangement with a specific enterprise customer, or a wholesale relicense if the business itself changes shape). A CLA — an explicit grant of a broad license (and, depending on the drafted terms, assignment) from contributor to CHIMERA — is what preserves the Licensor's freedom of action on all of those fronts without needing to track down and re-clear every external contributor individually years later. This is a legal-drafting decision as much as an engineering one; the requirement is specified here, the CLA's actual legal terms are not (see the disclaimer at the top of this document and §1.6).

Mechanically, once `CONTRIBUTING.md` exists: every pull request to the public repo is gated by an automated CLA-signature check (a GitHub Action / CLA-bot pattern — exact tooling choice deferred to the M7 implementer, this document does not select a specific SaaS product) that blocks merge until the PR author has signed. This applies uniformly to individual and corporate contributors; a corporate CLA variant (for contributions made by an employee on their employer's behalf) is drafted alongside the individual one, both by counsel, both referenced from `CONTRIBUTING.md`, neither drafted in this document.

---

## 6. The licensing server

`docs/MASTER_PLAN.md`'s M7 exit criteria names "licensing server" as a concrete deliverable alongside activation and tier gating. This is the HTTPS backend `packages/licensing`'s `activate()`/`validate()` calls reach (§3.1) — it issues signed licence receipts against a token, and later confirms they're still valid.

DECISION: the licensing server's own source **does not live in either `chimera` repository** — not the public one (obviously; it is core commercial infrastructure) and not the private `packages/licensing`-holding one either. It lives in its own separate, private deployment repository, outside the scope this document's repo-boundary decision (§2.1) covers, because it is operational infrastructure CHIMERA runs as a service, not code that is ever built into, bundled with, or distributed alongside any customer-facing artifact. Rationale: conflating "the client library that talks to the licensing server" (`packages/licensing`, ships compiled inside every official installer) with "the licensing server itself" (never ships anywhere, deployed and operated like any other backend service CHIMERA runs) under one repository would blur exactly the "ships to a customer machine" distinction §2.3's table is built around, and the two have entirely different deployment lifecycles (one is versioned with desktop releases and installed on end-user machines; the other is deployed independently, whenever CHIMERA chooses, with no coupling to a specific app version beyond the wire protocol `packages/licensing` speaks to it).

The wire protocol between `packages/licensing` and this server, and the server's own implementation, are out of scope for this document (no application code is specified here per this document's brief) beyond the shape already fixed by §3: it accepts an activation token and returns a `LicenceState`-shaped, tier-and-grace-bearing response over HTTPS, and `packages/licensing` treats a network failure to reach it as "grace period continues counting down," not as an immediate downgrade (§3.3).

---

## 7. Summary: the whole boundary in one place

    PUBLIC repo (chimera, BUSL 1.1, from M0)
      packages/core, packages/providers, packages/tools, packages/store,
      packages/control, packages/licensing-stub
      apps/desktop, apps/ui
      sidecar/, templates/, evals/, docs/, CLAUDE.md, CONTRIBUTING.md (pending)
      -> buildable and runnable standalone, Community tier only

    PRIVATE repo (chimera-licensing, ~M7, depends on public repo)
      packages/licensing              -> compiled into official installers only
      [F10, M10+] enterprise sync backend, client half
      [open, deferred to end of M5] any extracted swarm-orchestrator internals
      -> never published as source; pulled into the public repo's build
         as a private binary dependency, only in CHIMERA's own release CI

    PRIVATE INFRASTRUCTURE (its own repo, outside both of the above)
      licensing/activation server
      [F10, M10+] enterprise sync backend, server half
      -> never ships to a customer machine in any form, source or binary;
         reached only over HTTPS

---

## Decisions made in this document

- **Public/private module boundary, stated precisely**: private = `packages/licensing` (activation/validation logic only, not the licence table repository, which stays public) + the future F10 enterprise RBAC/SSO sync backend + any swarm-orchestrator scheduling internals later judged genuinely proprietary; everything else — the entire engine, runtime, providers, tools, store, control, and UI — is public under BUSL 1.1 from day one, because BUSL already protects the whole public repo commercially and a large private repo would only cost velocity and credibility for no added legal protection.
- **Swarm-orchestrator private-extraction candidates are not pre-selected**: the master plan leaves this open ("that turn out to be" proprietary), so this document defers the concrete decision to a review at the end of M5 against real code, using a two-question test (genuine hard-to-reproduce advantage; does extraction break public standalone buildability), rather than inventing an unsupported example now.
- **Per-release Change Date tracking**: each GitHub release records its own computed Change Date (release date + 4 years) in its release notes, since BUSL's four-year conversion is per dated release and a continuously-released monorepo needs an explicit convention for "four years after what."
- **Two-repository topology mirroring the named precedents**: a high-traffic public repo (self-contained, buildable standalone) with a small private repo depending on it as an upstream, not the reverse — keeps the credibility-bearing public repo unencumbered and the private repo minimal and mechanical.
- **`packages/licensing-stub`, public**: a permissive always-Community-tier implementation of `packages/licensing`'s interface, shipped in the public repo so `npm install && npm run build` works end to end for any contributor, with official builds substituting the real private package via CI running in the private repo.
- **Activation UX is a pasted licence key**, not an OAuth device-code flow — simplest mechanism satisfying the existing `licence:activate` IPC channel and the onboarding-wizard requirement without a new browser-round-trip dependency.
- **Licence activation/validation calls are first-party app infrastructure, not Governor-gated model/tool calls and not subject to a workflow's `policy.egressAllowlist`** — same category as auto-update's own update-feed check, called out explicitly so it isn't misread as a hard-rule-1 bypass.
- **14-day offline grace period, refreshed by a validate() call at startup and every 24h**, with graceful degradation to Community tier (not hard lockout) on expiry, and in-flight runs left uninterrupted — chosen because a hard lockout triggered by CHIMERA's own outage or a customer's travel is a trust failure with no piracy-prevention upside proportional to the damage.
- **Seat and Enterprise policy are licensing-server concerns**; the desktop client treats `seat_id` as opaque, and pre-F10 Enterprise customers are provisioned via a manually-issued activation token through the same `activate()` path everyone else uses.
- **Feature-additive, per-release tier gating table** rather than a fixed matrix baked in once — a Business seat sold at M7 automatically gains Tier 2 (M8) and RBAC (M10) access the moment those releases land, with no re-activation, since the pricing bundle and the build milestones were sequenced independently by the master plan.
- **Licence-tier enforcement is dual-layer (soft UI hint, hard validator/executor check) and reuses the existing fixed error taxonomy** (`ValidationError` at save time, `GovernorLimitError` at run time, both with a `LICENCE_TIER_REQUIRED_*` code) rather than adding a new `ChimeraError` subclass, preserving consistency with the taxonomy fixed across all six companion documents.
- **The licensing server's source lives in its own separate private deployment repo**, outside both `chimera` repositories, because it is operated infrastructure that never ships to a customer machine in any form — distinct in kind from `packages/licensing`, which does ship, compiled, inside every official installer.
- **CLA required, not a DCO**, specifically because BUSL's scheduled Apache-2.0 conversion and CHIMERA's possible future licensing decisions need broader rights than a DCO's origin-certification alone provides; the CLA's actual legal text is deferred to counsel and to the not-yet-created `CONTRIBUTING.md`.

---

**This document is engineering guidance, not legal advice.** The BUSL 1.1 Additional Use Grant's exact wording, the CLA's legal terms, and any determination of what counts as "production use," a "Competing Offering," or a single "licensee" under CHIMERA's specific license text must be drafted and reviewed by a lawyer before the public repo is published — per `docs/MASTER_PLAN.md` §6.1's own instruction to budget for that review. Nothing in this document should be relied upon as that review.
