import type { AuthRef } from '@chimera/store';
import type { ProviderKind } from './registry.ts';
import type {
  ConnectionTestResult,
  ModelDescriptor,
  NormalisedRequest,
  NormalisedResponse,
  StreamEvent,
} from './normalised.ts';

/**
 * What an adapter needs to make one call, beyond the request itself.
 *
 * Carries the vault *handle*, not the secret. The adapter resolves it with
 * `getSecret()` at the moment of the call and lets the value go out of scope
 * immediately after. That is why this field is an `AuthRef` and not a string:
 * a raw credential never has to cross a call boundary above this package, never
 * sits in a long-lived options object, and never appears in a heap snapshot
 * taken between calls. `packages/providers` is the lowest layer that legitimately
 * touches a plaintext key, and it holds one for the duration of a fetch.
 */
export interface AdapterCallOptions {
  authRef: AuthRef;
  /** Overrides the adapter's default endpoint. Required for self-hosted and OpenAI-compatible kinds. */
  baseUrl?: string;
  /** Cancellation. The Governor's kill switch (M3-6) aborts in-flight calls through this. */
  signal?: AbortSignal;
}

/**
 * The single surface every provider is reached through, and the only part of
 * `packages/providers` that `packages/core` is allowed to depend on
 * (docs/ARCHITECTURE.md §3).
 *
 * Implementations translate to and from one provider's wire format and do
 * nothing else. An adapter cannot see a role, a budget, a workflow, or the
 * Governor, because this package cannot import `packages/core` — so "provider
 * differences live in adapters only" holds structurally rather than by
 * convention.
 *
 * Failures surface as the `ProviderError` family from the shared error
 * taxonomy — never a raw string, never an untyped object, never a rejected
 * fetch promise passed straight through. M1-4 implements that for the real
 * adapters.
 */
export interface ProviderAdapter {
  readonly kind: ProviderKind;

  /** One non-streaming completion. */
  chat(request: NormalisedRequest, options: AdapterCallOptions): Promise<NormalisedResponse>;

  /**
   * The same call, streamed. Always yields exactly one `start` first and one
   * `finish` last, so consumers can rely on the envelope even when a provider's
   * own stream is shaped differently — normalising that is the adapter's job.
   */
  streamChat(request: NormalisedRequest, options: AdapterCallOptions): AsyncIterable<StreamEvent>;

  /** Models this connection can reach. Used by the capability matrix (M1-3) and the model picker. */
  listModels(options: AdapterCallOptions): Promise<ModelDescriptor[]>;

  /** A cheap round trip proving the credential and endpoint work. Never throws for an expected failure. */
  testConnection(options: AdapterCallOptions): Promise<ConnectionTestResult>;
}
