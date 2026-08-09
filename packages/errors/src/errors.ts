// The one error taxonomy every other package imports from — no imports
// beyond the Node standard library here (in this case, none at all). See
// docs/ARCHITECTURE.md section 6.
//
// Deliberately NOT unified with apps/desktop/src/ipc/errors.ts's IpcError
// hierarchy in this ticket — that hierarchy already exists, already has
// passing tests, and already does something ChimeraError doesn't need to
// (wire-format serialization tailored to the ipcMain/contextBridge
// boundaries, see docs/ARCHITECTURE.md section 6's "second boundary" note).
// Unifying them would mean apps/desktop taking a new workspace dependency
// on packages/core for something this ticket doesn't ask for. Not done here.

export class ChimeraError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }

  // Errors do not survive IPC as Error instances — see
  // docs/ARCHITECTURE.md section 6. Every IPC handler boundary calls this
  // before returning to the renderer.
  toWireFormat(): { code: string; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

// F4 — multiple distinct limit kinds (budget, depth, step count, wall-clock,
// stall detection) share this one class, distinguished by `code`, e.g.
// "GOVERNOR_BUDGET_EXCEEDED", "GOVERNOR_DEPTH_EXCEEDED", "GOVERNOR_STALLED".
export class GovernorLimitError extends ChimeraError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}

// Base for provider-layer failures not covered by the two named subclasses
// below — also code-flexible, e.g. "PROVIDER_UNREACHABLE",
// "PROVIDER_INVALID_RESPONSE".
export class ProviderError extends ChimeraError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PROVIDER_AUTH_FAILED', message, details);
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PROVIDER_RATE_LIMITED', message, details);
  }
}

// Base for tool-layer failures not covered by the two named subclasses.
export class ToolError extends ChimeraError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}

export class ToolAllowlistError extends ToolError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('TOOL_NOT_ALLOWLISTED', message, details);
  }
}

export class ToolExecutionError extends ToolError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('TOOL_EXECUTION_FAILED', message, details);
  }
}

// Workflow-schema validation (docs/WORKFLOW_SCHEMA.md's numbered rules),
// IPC payload validation, and any other schema-shaped rejection share this
// class — code-flexible, e.g. "SCHEMA_RULE_7_VIOLATION", "IPC_INVALID_PAYLOAD".
export class ValidationError extends ChimeraError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}

// packages/store/src/vault.ts — keychain read/write/delete failure, or a
// malformed handle. Code-flexible: "VAULT_WRITE_FAILED", "VAULT_READ_FAILED",
// "VAULT_DELETE_FAILED", "VAULT_INVALID_HANDLE". A VaultError's `details`
// must never include the secret value itself — only shape/metadata about
// it (e.g. length), same rule as everywhere else secrets are handled.
export class VaultError extends ChimeraError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}

// packages/control/src/sidecar — M8+, process crash, protocol violation, or
// timeout talking to the Rust native-control binary.
export class SidecarError extends ChimeraError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}
