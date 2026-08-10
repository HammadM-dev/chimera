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
export { MockProvider, MOCK_MODELS, fingerprintOf, mockTokenCount } from './mock.ts';
export type {
  MockScript,
  MockResponse,
  MockPersona,
  MockProviderOptions,
  MockErrorKind,
} from './mock.ts';
export { AnthropicAdapter } from './adapters/anthropic.ts';
export { OpenAiAdapter } from './adapters/openai.ts';
export { GoogleAdapter } from './adapters/google.ts';
export { defaultDependencies, defaultTransport, scrub } from './adapters/http.ts';
export type { AdapterDependencies, AdapterTransport } from './adapters/http.ts';
export { OpenAiCompatibleAdapter } from './adapters/openaiCompatible.ts';
export type { OpenAiCompatibleConfig } from './adapters/openaiCompatible.ts';
export { OpenRouterAdapter } from './adapters/openrouter.ts';
export { OmniRouteAdapter, OMNIROUTE_DEFAULT_BASE_URL } from './adapters/omniroute.ts';
export { OllamaAdapter } from './adapters/ollama.ts';
export { LmStudioAdapter } from './adapters/lmstudio.ts';
