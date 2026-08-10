// The Governor's request and result shapes. Frozen for M3: M3-1 replaces the
// stub's internals, not this file, and no call site outside Governor.ts changes.
//
// Every field here exists because one of the checks docs/ARCHITECTURE.md §7
// lists needs it. Nothing is here "for later" — a field the Governor cannot
// yet use is a field whose meaning nobody has had to commit to.

/**
 * A capability the calling node genuinely requires of the model.
 *
 * Matches the tri-state capability flags in
 * `packages/providers/src/capabilityMatrix.ts`: the Governor's check is
 * "the matrix must say `supported`", so `unknown` fails closed rather than
 * being read as yes.
 */
export type RequiredCapability = 'toolCalling' | 'vision' | 'streaming' | 'structuredOutput';

/** Which step of the agent loop wants the call. Carried for traces and per-step caps. */
export type CallPurpose = 'plan' | 'act' | 'observe' | 'verify' | 'decide';

/** Fields every authorizable call shares, whatever it is calling. */
export interface CallContext {
  runId: string;
  nodeId: string;
  /** The role whose allowlists and caps apply. */
  roleId: string;
  /** Iteration index within the calling node's loop, from zero. Step-count and stall checks. */
  iteration: number;
  /** Nesting depth: subworkflows and agent-in-agent calls. Recursion limit. */
  depth: number;
}

export interface ModelCallRequest extends CallContext {
  purpose: CallPurpose;
  /** The connection the call would go to — rate-limit bucket and spillover chain. */
  connectionId: string;
  model: string;
  /**
   * What this call is expected to consume.
   *
   * An estimate by definition: output length is not knowable in advance. The
   * budget check is therefore "would the estimate breach the cap", and the real
   * figure is reconciled after the call — M3-4's live meter, not this ticket.
   */
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  requiredCapabilities: readonly RequiredCapability[];
}

export interface ToolCallRequest extends CallContext {
  /** Registry id, e.g. `filesystem.readFile`. Checked against the role's allowlist. */
  toolId: string;
  /**
   * Hosts this call would contact, for the egress allowlist check.
   *
   * Empty for tools that touch no network. Supplied by the caller because only
   * the caller has resolved the arguments into concrete targets; `http.ts` and
   * `browser.ts` check the same list again themselves, which is the redundancy
   * docs/SECURITY.md's egress row asks for.
   */
  egressTargets: readonly string[];
  /**
   * Whether this call has an effect that cannot be undone — sending,
   * publishing, purchasing, deleting, injecting native input.
   *
   * Declared by the tool server, not inferred from the tool id: a name-matching
   * rule would be one rename away from silently un-gating an irreversible tool.
   */
  irreversible: boolean;
}

export type DenialCode =
  | 'GOVERNOR_BUDGET_EXCEEDED'
  | 'GOVERNOR_DEPTH_EXCEEDED'
  | 'GOVERNOR_STEP_LIMIT_EXCEEDED'
  | 'GOVERNOR_STALLED'
  | 'GOVERNOR_RATE_LIMITED'
  | 'GOVERNOR_CAPABILITY_MISMATCH'
  | 'GOVERNOR_TOOL_NOT_ALLOWED'
  | 'GOVERNOR_EGRESS_NOT_ALLOWED'
  | 'GOVERNOR_APPROVAL_REQUIRED';

/**
 * An authorized call, carrying the request the caller must actually dispatch.
 *
 * The Governor may return a *modified* request — §7's example is downgrading to
 * a cheaper model under `budget.onExceed: degrade_to_cheaper_model`. Callers
 * therefore dispatch `result.request`, never the request they submitted. That
 * is why this carries the request back rather than being a bare boolean: a
 * boolean would make the modification path impossible to express, and adding it
 * later would change every call site.
 */
export interface Authorized<TRequest> {
  decision: 'allow';
  request: TRequest;
  /** Human-readable notes for the run trace, e.g. "downgraded to claude-haiku-4-5". */
  notes: readonly string[];
}

export interface Denied {
  decision: 'deny';
  code: DenialCode;
  message: string;
  details: Record<string, unknown>;
}

/**
 * Generic in the request type so `authorizeModelCall` cannot return a tool
 * request and vice versa. docs/ARCHITECTURE.md §7 writes the return type
 * unparameterised; the parameter is the same type expressed precisely.
 */
export type AuthorizationResult<TRequest> = Authorized<TRequest> | Denied;

export type ModelCallAuthorization = AuthorizationResult<ModelCallRequest>;
export type ToolCallAuthorization = AuthorizationResult<ToolCallRequest>;
