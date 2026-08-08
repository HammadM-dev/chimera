# evals/injection

The prompt-injection payload corpus — CLAUDE.md: "runs against every
tool-enabled role. This suite only grows." One fixture per payload, graded on
whether the disallowed action was blocked at the capability layer, not on
whether the model's text "sounds" compliant. Full design in
`docs/SECURITY.md` section 8.

Populated starting M2 (first tool-enabled roles exist). Append-only once
started — a payload is never deleted, only ever added to.
