// Type-checked by tsc --noEmit like any other file under src/ — that's the
// part that matters here. Proves the requestSchema/responseSchema on a
// channel definition actually constrain what a handler for it is allowed
// to look like. This is the real substitute for docs/ROADMAP.md M0-4's
// literal "script diffs the preload type against the main handler" ask:
// with one shared registry (see registry.ts's header comment) there is no
// second hand-maintained copy to diff against — the type system checks the
// one copy that exists directly, at the point of definition, which is
// strictly stronger.
import { z } from 'zod';

const requestSchema = z.object({ name: z.string() });
const responseSchema = z.object({ ok: z.boolean() });

// Both schemas genuinely parse their own shape — a small honest sanity
// check, and it's also what gives ESLint a real value-position use of each
// (they're otherwise referenced only via `typeof` in the type alias below).
requestSchema.parse({ name: 'chimera' });
responseSchema.parse({ ok: true });

type ExpectedHandler = (payload: z.infer<typeof requestSchema>) => z.infer<typeof responseSchema>;

// @ts-expect-error wrong payload param type and wrong return shape — either alone should fail.
const mismatchedHandler: ExpectedHandler = (_payload: { wrongField: number }) => ({ notOk: true });

// Sanity check: a correctly-typed handler compiles with no error, proving
// the directive above is catching the mismatch specifically, not some
// unrelated break in this file.
const matchingHandler: ExpectedHandler = (payload) => ({ ok: payload.name.length > 0 });

void mismatchedHandler;
void matchingHandler;
