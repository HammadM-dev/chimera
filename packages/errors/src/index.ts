// packages/errors — the one error taxonomy, and the floor of the dependency
// graph. Imports nothing (not even from the Node standard library), so every
// layer above can depend on it without creating a cycle.
//
// It lives in its own package rather than in packages/core because
// docs/ARCHITECTURE.md section 3 forbids packages/providers and packages/tools
// from importing packages/core, while every package needs to raise typed
// errors. Those two constraints are both correct and cannot both hold with the
// taxonomy inside core — see docs/ROADMAP.md M1-2.
export * from './errors.ts';
export { redact } from './redact.ts';
