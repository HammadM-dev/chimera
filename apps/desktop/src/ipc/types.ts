import type { z } from 'zod';

export interface InvokeEnvelope<TPayload = unknown> {
  v: number;
  channel: string;
  requestId: string;
  payload: TPayload;
}

export interface EventEnvelope<TPayload = unknown> {
  v: number;
  channel: string;
  payload: TPayload;
}

export interface InvokeChannelDefinition<TReq = unknown, TRes = unknown> {
  kind: 'invoke';
  channel: string;
  v: number;
  sensitive: boolean;
  requestSchema: z.ZodType<TReq>;
  responseSchema: z.ZodType<TRes>;
  // Stub throughout M0 — real business logic arrives with the milestone
  // that owns each domain (M1 providers, M2 runtime, M4 workflow engine...).
  handler: (payload: TReq) => Promise<TRes> | TRes;
}

export interface EventChannelDefinition<TPayload = unknown> {
  kind: 'event';
  channel: string;
  v: number;
  sensitive: boolean;
  payloadSchema: z.ZodType<TPayload>;
}

export type ChannelDefinition = InvokeChannelDefinition | EventChannelDefinition;

// Generic-inference helpers. A bare `const x: InvokeChannelDefinition = {...}`
// annotation defaults TReq/TRes to `unknown` (the interface's own defaults)
// instead of inferring them from the assigned requestSchema/responseSchema —
// silently losing the one thing that makes a schema version bump without a
// matching handler update fail to compile. Defining each channel through
// this function instead forces TReq/TRes to be inferred from the *input*,
// so `handler`'s parameter and return types are checked against them for
// real at the point of definition. The *return* type is deliberately
// widened to the erased ChannelDefinition union (not InvokeChannelDefinition
// <TReq, TRes>) — a registry holding differently-typed channels side by
// side needs one common storage type, and TypeScript is correctly unwilling
// to widen a concretely-typed handler to `(payload: unknown) => unknown` on
// its own (a narrower handler isn't safely callable with an arbitrary
// unknown). The cast here is the one deliberate, contained erasure point;
// runtime safety holds because dispatch always looks up one entry by name
// and calls that same entry's handler with that same entry's parsed
// payload — the two never come from different entries. See registry.ts and
// ipc/typeSafety.fixture.ts.
export function defineInvokeChannel<TReq, TRes>(
  def: Omit<InvokeChannelDefinition<TReq, TRes>, 'kind'>,
): ChannelDefinition {
  return { kind: 'invoke', ...def } as ChannelDefinition;
}

export function defineEventChannel<TPayload>(
  def: Omit<EventChannelDefinition<TPayload>, 'kind'>,
): ChannelDefinition {
  return { kind: 'event', ...def } as ChannelDefinition;
}

export interface WireError {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

// ipcMain.handle/ipcRenderer.invoke does not reliably carry custom Error
// properties (code, details) across the process boundary when you throw —
// only `message` survives Electron's serialization. The handler always
// resolves with one of these instead; preload's invoke() wrapper is what
// actually throws, reconstructed from the wire data, so renderer code still
// gets a normal rejected promise to catch.
export type WireResult<T> = { ok: true; data: T } | { ok: false; error: WireError };
