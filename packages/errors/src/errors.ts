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

/**
 * Whether retrying this failure could plausibly work.
 *
 * One definition, used by every retry loop in the product, because the answer
 * is a property of the error and not of the caller. It was three definitions:
 * the agent loop retried rate limits and unreachable connections, the swarm
 * copied that list, and neither retried a 5xx — so a provider having a bad
 * thirty seconds failed a run outright. OpenRouter returning a 503 mid-swarm
 * is exactly that, and it ended the whole thing.
 *
 * What is *not* here matters as much. A rejected credential, a model the plan
 * will not run, a malformed request: retrying those produces the same answer
 * more slowly, and hides a fixable problem behind a delay.
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;

  return (
    error.code === 'PROVIDER_RATE_LIMITED' ||
    // The connection never landed: DNS, a dropped socket, a refused port.
    error.code === 'PROVIDER_UNREACHABLE' ||
    // 5xx. The provider is having a moment; that is what backoff is for.
    error.code === 'PROVIDER_SERVER_ERROR' ||
    // A gateway that answered with something unreadable is usually an error
    // page from in front of the provider rather than the provider itself,
    // which is the same transient condition wearing a different hat.
    error.code === 'PROVIDER_INVALID_RESPONSE'
  );
}
