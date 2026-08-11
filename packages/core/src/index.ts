// packages/core — engine, Governor, and agent runtime.
// Rest of the surface (Governor, engine, runtime) populated starting M2.
// See docs/ARCHITECTURE.md.
//
// The error taxonomy deliberately does NOT live here and is NOT re-exported.
// It is `@chimera/errors`, a leaf package, so that packages/providers and
// packages/tools can raise typed errors without importing packages/core — an
// edge docs/ARCHITECTURE.md section 3 forbids and
// scripts/check-package-boundaries.mjs enforces. Re-exporting it here would
// quietly recreate the second import path this move exists to close.
export { Governor, createGovernor, deny } from './governor/Governor.ts';
export type { GovernorMode } from './governor/Governor.ts';
export type {
  Authorized,
  AuthorizationResult,
  CallContext,
  CallPurpose,
  Denied,
  DenialCode,
  ModelCallAuthorization,
  ModelCallRequest,
  RequiredCapability,
  ToolCallAuthorization,
  ToolCallRequest,
} from './governor/types.ts';

export { createRoleRegistry, STARTER_ROLES } from './runtime/roleRegistry.ts';
export type {
  ModelBinding,
  ModelTier,
  OutputContract,
  Role,
  RoleBudget,
  RoleRegistry,
} from './runtime/roleRegistry.ts';
