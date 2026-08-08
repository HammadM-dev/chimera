# CHIMERA

Desktop application for businesses to build, run, and govern teams of AI agents across any model provider, with a visual workflow builder and supervised machine control.

Start with `CLAUDE.md` — it's the standing contract for this repo: stack, hard rules, conventions, and working style. Read it before anything else.

## Docs

- `docs/MASTER_PLAN.md` — product definition, features, business plan. Source of truth for what CHIMERA is.
- `docs/ARCHITECTURE.md` — layer model, process model, package boundaries, IPC design, SQLite schema.
- `docs/WORKFLOW_SCHEMA.md` — the workflow document contract. Changing it bumps `schemaVersion`.
- `docs/SECURITY.md` — threat model, prompt-injection defence, credential handling, sandbox boundaries.
- `docs/DESIGN.md` — design tokens and layout as an implementable spec.
- `docs/ROADMAP.md` — M0–M10 broken into numbered tickets. Work one milestone at a time.
- `docs/TESTING.md` — test strategy, the mock provider, chaos suite, CI wiring.
- `docs/LICENSING.md` — BUSL 1.1 terms and the public/private repo boundary.

## Development

Requires Node 20+ (Node 22 recommended — run `bash chimera-preflight.sh` to check your machine).

```
npm install
npm run lint
npm run typecheck
npm test
```

`npm run check:layout` verifies the top-level directory list matches `docs/ARCHITECTURE.md`; `npm run docs:check-links` verifies intra-repo doc cross-references resolve.

## License

BUSL 1.1. See `docs/LICENSING.md` — engineering guidance, not legal advice.
