# Contributing

CHIMERA is early access and maintained by one person. Issues, reproductions and
pull requests are all welcome — this file is about what makes them land quickly.

## Before anything else

Read [`CLAUDE.md`](CLAUDE.md). It is the standing contract for this repository:
the stack, the hard rules, the conventions and the working style. It is short,
and it explains most of what a review would otherwise ask you to change.

Then, depending on what you are touching:

| Changing | Read first |
| --- | --- |
| `packages/core` or `packages/providers` | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Anything about tools, prompts or credentials | [`docs/SECURITY.md`](docs/SECURITY.md) |
| The workflow document shape | [`docs/WORKFLOW_SCHEMA.md`](docs/WORKFLOW_SCHEMA.md) — and bump `schemaVersion` in the same commit |
| Tests | [`docs/TESTING.md`](docs/TESTING.md) |

## Getting it running

Node 22 is recommended. Node 20 is the floor.

```sh
npm install
npm run lint && npm run typecheck && npm test
npm start --workspace @chimera/desktop
```

`npm run dev:fresh` launches against a throwaway profile, which is how to see
first-run — the setup guide and the tour — without wiping your own workspace.

## Before you open a pull request

All of these run in CI, so running them first saves a round trip:

```sh
npm run format        # prettier --check . — CI fails on formatting
npm run lint          # eslint, including the architectural boundary rules
npm run typecheck     # strict, across every workspace
npm test              # unit tests and the injection corpus
npm run test:e2e --workspace @chimera/desktop   # drives a real Electron build
```

The e2e suite takes a while and launches a real window. It is worth running if
you touched the renderer, the canvas, or anything a person clicks.

## What a good change looks like

**Say why in the code.** This codebase explains its reasoning in comments, and
that is deliberate: most of the non-obvious lines here exist because something
failed once. A comment saying what a line does is noise; one saying why it is
that way is the thing that stops it being undone later.

**Tests that could fail.** A test that passes against the broken code is worse
than no test. If you are fixing a bug, check the test fails before your fix and
passes after — and say so in the commit message.

**One change per commit**, with a message that explains the reasoning rather
than restating the diff.

**Do not weaken a guard to make something pass.** If a check is in the way, it
is either wrong — in which case change it deliberately, in its own commit, with
the reason — or it is right and the code needs to change instead. The
architectural rules in this repository are checks that fail the build precisely
so that they are a decision rather than a drift.

## Reporting a bug

Use the issue templates. What helps most:

- Which version, from the title bar or `chimera --version`
- Your operating system
- The **run trace**, if an automation was involved — read it first, it may hold
  your own data
- What you expected, and what happened

## Security

Do not open a public issue. See [`SECURITY.md`](SECURITY.md) for private
reporting and for what counts as a vulnerability in a product that deliberately
runs untrusted content through a model.
