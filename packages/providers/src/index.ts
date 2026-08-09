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
