// packages/providers — registry, adapters, capability matrix, mock provider.
// Populated starting M1. See docs/ARCHITECTURE.md and docs/MASTER_PLAN.md F1.
export { createConnectionRegistry, PROVIDER_KINDS, HEALTH_STATES } from './registry.ts';
export type {
  ConnectionRegistry,
  ProviderConnection,
  ProviderKind,
  ProviderLimits,
  HealthState,
  UnusableConnection,
} from './registry.ts';
export type { ProviderAdapter, AdapterCallOptions } from './adapter.ts';
export { toContentParts, textOf } from './normalised.ts';
export type {
  JsonSchema,
  MessageRole,
  TextContent,
  ImageContent,
  ContentPart,
  ToolCall,
  Message,
  ToolDefinition,
  ToolChoice,
  ResponseFormat,
  NormalisedRequest,
  FinishReason,
  Usage,
  NormalisedResponse,
  StreamEvent,
  ModelDescriptor,
  ConnectionTestResult,
} from './normalised.ts';
export * as capabilityMatrix from './capabilityMatrix.ts';
export { FALLBACK_CAPABILITIES, MODEL_CAPABILITIES } from './capabilityMatrix.ts';
export type { ModelCapabilities, Pricing, Support } from './capabilityMatrix.ts';
