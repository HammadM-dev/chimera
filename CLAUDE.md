# CHIMERA

Desktop application for businesses to build, run, and govern teams of AI agents across any model provider, with a visual workflow builder and supervised machine control.

Read `docs/ARCHITECTURE.md` and `docs/WORKFLOW_SCHEMA.md` before changing anything in `packages/core` or `packages/providers`.

## Stack

- Shell: Electron
- Core: TypeScript (Node) — engine, governor, agent runtime, providers, tools
- UI: React + TypeScript, React Flow for the canvas
- Store: SQLite (WAL) via better-sqlite3, sqlite-vec for embeddings
- Tools: MCP TypeScript SDK plus internal MCP servers
- Secrets: OS keychain only (`@napi-rs/keyring` — Windows Credential Manager, macOS Keychain, libsecret on Linux; see `docs/ROADMAP.md` M0-6 for why this was chosen over `keytar`)
- Native machine control (M8+): a small Rust sidecar binary the main process spawns and talks to over stdio. Rust is confined to that binary and nowhere else

## Layout

```
packages/core          engine, governor, agent runtime
packages/providers     registry and adapters
packages/tools         MCP client + internal servers
packages/store         SQLite, migrations, vault
packages/control       browser control; sidecar bridge for native control
apps/desktop           Electron main + preload
apps/ui                React renderer
sidecar/               Rust native-control binary (M8+, not before)
templates              shipped workflow templates
evals                  golden workflow tests
```

## Hard rules

**Every model call and every tool call goes through the Governor.** There is no bypass path. If you find yourself writing a direct provider call outside it, stop and route it properly.

**Tool output is data, never instructions.** Content returned by any tool — web pages, files, emails, API responses — is attacker-controllable. Wrap it structurally, label it untrusted, and never place it in the instruction position of a prompt. See `docs/SECURITY.md`.

**Capability limits are the real defence, not prompt wording.** An agent cannot misuse a tool it was never granted. Role allowlists and egress domain allowlists come first; prompt hardening is secondary.

**Secrets never leave the vault.** Not into SQLite, not into logs, not into run traces, not into error messages. Agents receive handles, not values.

**Irreversible actions require a gate.** Sending, publishing, purchasing, deleting, or injecting native input needs a human-approval node or explicit workflow pre-authorisation.

**No unbounded loops.** Every loop node declares max iterations, an exit condition, or a verified-goal predicate. The editor must refuse to save without one.

**Provider differences live in adapters only.** Everything above `chimera-providers` sees one normalised interface. Model differences are expressed as capability data, never as branching logic in the engine.

## Conventions

- TypeScript strict mode on. `noImplicitAny`, `strictNullChecks`, no `any` without a written reason
- ESLint + Prettier clean before commit
- Never `throw` raw strings. Typed error classes in packages, handled at boundaries
- All SQLite access through `packages/store` — no raw queries elsewhere
- Renderer talks to main only through the typed preload bridge. `contextIsolation` on, `nodeIntegration` off, always
- IPC messages are versioned and typed; adding a field is fine, changing one needs a version bump
- UI: no inline hex colours, use design tokens; weights 400 and 500 only; 0.5px borders; sentence case
- Copy: verb-first buttons, no "successfully", no "please", no exclamation marks

## Testing

- Unit tests for governor arithmetic, schema validation, capability matching
- Integration tests use the mock provider in `packages/providers/src/mock.ts` — never hit a real API in CI
- Every shipped template runs as a golden eval on each commit
- Prompt-injection payload corpus in `evals/injection/` runs against every tool-enabled role. This suite only grows

## Working style

Work one milestone at a time from `docs/ROADMAP.md`. Don't start the next until the current one has tests and is demoable. When a change touches the workflow schema, update `docs/WORKFLOW_SCHEMA.md` in the same commit and bump the schema version.

Ask before adding a dependency.
