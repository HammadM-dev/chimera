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

// Deliberately carries no handler. Channel definitions are imported by
// preload.ts, which runs sandboxed with no Node integration; a handler defined
// alongside its schema would drag that handler's imports into the preload
// bundle with it. The first real handler (vault:setSecret, M0-11) reaches
// packages/store and therefore better-sqlite3 and @napi-rs/keyring — native
// modules that cannot load in a sandboxed preload at all. Handlers live in
// handlers.ts, which only the main process imports, and are attached through
// registerHandler() below so the schema-to-handler type checking survives the
// split.
export interface InvokeChannelDefinition<TReq = unknown, TRes = unknown> {
  kind: 'invoke';
  channel: string;
  v: number;
  sensitive: boolean;
  requestSchema: z.ZodType<TReq>;
  responseSchema: z.ZodType<TRes>;
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
// silently losing the one thing that makes a schema change without a matching
// handler update fail to compile. Defining each channel through this function
// forces TReq/TRes to be inferred from the *input*, and the definition keeps
// those types, so registerHandler() can check a handler against them.
export function defineInvokeChannel<TReq, TRes>(
  def: Omit<InvokeChannelDefinition<TReq, TRes>, 'kind'>,
): InvokeChannelDefinition<TReq, TRes> {
  return { kind: 'invoke', ...def };
}

export function defineEventChannel<TPayload>(
  def: Omit<EventChannelDefinition<TPayload>, 'kind'>,
): EventChannelDefinition<TPayload> {
  return { kind: 'event', ...def };
}

export type ChannelHandler<TReq = unknown, TRes = unknown> = (
  payload: TReq,
) => Promise<TRes> | TRes;

// Main-process only. Populated by handlers.ts at import time; read by
// mainDispatch.ts. Erased to `unknown` for storage because a map holding
// differently-typed handlers side by side needs one common type, and
// TypeScript is correctly unwilling to widen a concretely-typed handler to
// `(payload: unknown) => unknown` on its own (a narrower handler is not safely
// callable with an arbitrary unknown).
const HANDLERS = new Map<string, ChannelHandler>();

// The one deliberate, contained erasure point. Runtime safety holds because
// dispatch looks up a handler by the same channel name whose schema produced
// the parsed payload it passes in — the two can never come from different
// entries.
export function registerHandler<TReq, TRes>(
  def: InvokeChannelDefinition<TReq, TRes>,
  handler: ChannelHandler<TReq, TRes>,
): void {
  HANDLERS.set(def.channel, handler as ChannelHandler);
}

export function getHandler(channel: string): ChannelHandler | undefined {
  return HANDLERS.get(channel);
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
