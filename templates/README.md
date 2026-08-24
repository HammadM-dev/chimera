# templates

The automations somebody can start from instead of a blank canvas. One JSON
file each, read at runtime by `apps/desktop/src/templates/service.ts` and shown
in the gallery on the home screen.

Data, deliberately — not TypeScript. Somebody should be able to read one, copy
it, and write their own without opening an editor that understands types.

## What a template is for

The eleven here were chosen from what people actually automate rather than from
what is easy to demonstrate: inbox triage, invoice data entry, lead research,
competitor pricing, contract review, meeting follow-ups, support routing, page
monitoring, weekly reporting, a morning brief, and code review. Between them
they cover office work, finance, sales, marketing, support, management and
engineering, because a library of ten templates for developers is a library for
developers.

## The shape

```jsonc
{
  "id": "inbox-triage",          // unique; matches the file name
  "name": "Triage the inbox…",   // what it is
  "audience": "Anyone whose…",   // who it is for, in a phrase
  "summary": "Read today's…",    // what it does; becomes the brief
  "needs": ["An email account…"],// said before they pick it, not after it fails
  "egressMode": "browse",        // allowlist | browse | open
  "steps": [
    { "id": "read", "roleId": "researcher", "instruction": "…" },
    { "id": "gate", "kind": "approval", "roleId": "", "instruction": "Send these?" },
    { "id": "each", "kind": "fanout", "roleId": "", "instruction": "",
      "settings": { "concurrency": 4, "maxItems": 500, "parse": "json" } }
  ],
  "edges": [["read", "gate"]]    // omit for a straight line
}
```

`kind` defaults to `agent`. Any node the canvas can build is allowed —
`condition`, `loop`, `transform`, `approval`, `fanout`, `aggregate`,
`subworkflow`, `swarm` — and `settings` carries whatever that kind needs.

## The rules, and where they are enforced

`apps/desktop/src/templates/templates.test.ts` is the golden eval CLAUDE.md
asks for, and it runs on every commit. It refuses a template that:

- names an agent this build does not ship — the canvas skips such a step
  silently, so the automation arrives with a hole in it and runs anyway;
- uses a node kind the canvas cannot build, or gives a non-agent step a role;
- has an edge to or from a step that does not exist, or a step joined to itself;
- leaves a step joined to nothing, or has no first step, or no last one;
- declares a loop or fan-out without its bound (CLAUDE.md: no unbounded loops);
- **sends, replies, publishes or posts without an approval node** — a shipped
  template is the one place a user has not read the instructions, so one that
  emails strangers on their behalf unprompted is our mistake, on their account;
- does not say who it is for, or reads a folder or a mailbox without saying so
  in `needs`.

`apps/desktop/e2e/templates.spec.ts` then checks the path rather than the JSON:
that the gallery loads, that a template builds into joined nodes with its
instructions written, and that the automation runs.

## Adding one

Write the file, run `npm test --workspace @chimera/desktop`, and fix what it
tells you. Then raise the expected count in `templates.spec.ts` — it asserts an
exact number so that a template which stops being loaded is noticed.
