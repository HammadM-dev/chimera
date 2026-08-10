import { GovernorLimitError } from '@chimera/errors';
import type {
  Authorized,
  Denied,
  DenialCode,
  ModelCallAuthorization,
  ModelCallRequest,
  ToolCallAuthorization,
  ToolCallRequest,
} from './types.ts';

// The one door. CLAUDE.md: "Every model call and every tool call goes through
// the Governor. There is no bypass path."
//
// This is M2-1's permissive stub: the call path, the signatures and the result
// shape are final, and the checks are not yet implemented. M3 replaces the
// bodies of `authorizeModelCall` and `authorizeToolCall` with real budget,
// limit, stall, rate and allowlist logic. No call site changes when it does —
// that is the whole point of landing this before the runtime rather than after.
//
// Why a stub at all, rather than building the runtime first and the Governor in
// M3 as the roadmap's ordering implies: an agent runtime built against a
// direct adapter reference would spend a milestone violating the hard rule, and
// "we will route it properly later" is exactly the retrofit that never fully
// happens. Permissive internals behind a final interface keeps the rule true
// from the runtime's first commit.

/**
 * How this Governor was constructed.
 *
 * `permissive` is the M2 stub. `enforcing` is M3. Exposed because a run trace
 * that cannot tell the two apart would let a permissive Governor look like an
 * enforcing one in an audit — the one place this stub could do real damage.
 */
export type GovernorMode = 'permissive' | 'enforcing';

function allow<TRequest>(request: TRequest, notes: readonly string[] = []): Authorized<TRequest> {
  return { decision: 'allow', request, notes };
}

export function deny(
  code: DenialCode,
  message: string,
  details: Record<string, unknown> = {},
): Denied {
  return { decision: 'deny', code, message, details };
}

export class Governor {
  readonly mode: GovernorMode;

  constructor(mode: GovernorMode = 'permissive') {
    this.mode = mode;
  }

  /**
   * Authorizes one provider call.
   *
   * M3 implements, in this order: budget at run/node/role level, recursion
   * depth and step count, stall condition, rate-limit headroom on the target
   * connection, and capability match against the matrix. See
   * docs/ARCHITECTURE.md §7.
   *
   * The stub authorizes everything, and says so in the notes rather than
   * returning a bare allow: a trace reader looking at an approved call needs to
   * be able to tell "checked and permitted" from "not checked".
   */
  authorizeModelCall(request: ModelCallRequest): ModelCallAuthorization {
    if (this.mode === 'enforcing') {
      // Unreachable until M3 fills this in. Throwing rather than falling
      // through to the permissive branch: an enforcing Governor that silently
      // authorized everything would be the worst possible failure of this
      // interface, and a mode that does not exist yet must not be usable.
      throw new GovernorLimitError(
        'GOVERNOR_NOT_IMPLEMENTED',
        'Enforcing mode arrives in M3-1. This build has only the permissive call-path stub.',
        { mode: this.mode, runId: request.runId },
      );
    }
    return allow(request, ['governor: permissive stub, no limits enforced']);
  }

  /**
   * Authorizes one tool call.
   *
   * M3 implements: allowlist membership (via `packages/tools/src/allowlist.ts`,
   * checked here *and* independently inside the registry — defence in depth),
   * egress allowlist for network-capable tools, approval-gate requirement for
   * irreversible calls, and budget/rate accounting where the tool has a cost.
   */
  authorizeToolCall(request: ToolCallRequest): ToolCallAuthorization {
    if (this.mode === 'enforcing') {
      throw new GovernorLimitError(
        'GOVERNOR_NOT_IMPLEMENTED',
        'Enforcing mode arrives in M3-1. This build has only the permissive call-path stub.',
        { mode: this.mode, runId: request.runId },
      );
    }
    return allow(request, ['governor: permissive stub, no limits enforced']);
  }
}

/** The Governor every caller in this milestone uses. */
export function createGovernor(mode: GovernorMode = 'permissive'): Governor {
  return new Governor(mode);
}
