import { alwaysIrreversibleTools } from '@chimera/tools';
import type { Role } from '../runtime/roleRegistry.ts';
import { validateBrief, type BriefProblem, type RunBrief } from './runBrief.ts';

// M4-6. The rules that decide whether an automation may be saved or started at
// all, as opposed to the shape rules `validateBrief` checks.
//
// Save-time rather than run-time on purpose: a refusal while somebody is still
// editing costs them a minute; the same refusal after they have shipped the
// automation to a colleague costs them the colleague's afternoon.

/** What a step's bound model can do, as the capability matrix reports it. */
export interface StepCapabilities {
  toolCalling: 'supported' | 'unsupported' | 'unknown';
  vision: 'supported' | 'unsupported' | 'unknown';
  structuredOutput: 'supported' | 'unsupported' | 'unknown';
}

export interface SaveContext {
  roles: readonly Role[];
  /**
   * Per-node capability facts, where they are known.
   *
   * A node with no entry is not a refusal. Live catalogues report `unknown` for
   * almost every model — a validator that refused on absent knowledge would
   * refuse most real automations, and users would learn to work around it.
   */
  capabilities?: Record<string, StepCapabilities>;
  /**
   * Nodes the author has explicitly pre-authorised for irreversible tools.
   *
   * The escape hatch CLAUDE.md allows: "a human-approval node or explicit
   * workflow pre-authorisation". Explicit, per node, and recorded in the saved
   * file, so it is visible to whoever opens the automation next.
   */
  preauthorised?: readonly string[];
}

/** Every node that can reach `target` by following edges backwards. */
function upstreamOf(brief: RunBrief, target: string): Set<string> {
  const sources = new Map<string, string[]>();
  for (const [from, to] of brief.edges) {
    sources.set(to, [...(sources.get(to) ?? []), from]);
  }

  const seen = new Set<string>();
  const queue = [...(sources.get(target) ?? [])];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === undefined || seen.has(nodeId)) continue;
    seen.add(nodeId);
    queue.push(...(sources.get(nodeId) ?? []));
  }
  return seen;
}

/**
 * Everything that would stop this automation being saved.
 *
 * Includes `validateBrief`'s shape problems, so a caller has one thing to ask
 * and one list to show. Every problem names its node — a refusal that does not
 * say where is a refusal the user has to hunt for.
 */
export function validateForSave(brief: RunBrief, context: SaveContext): BriefProblem[] {
  const problems = validateBrief(
    brief,
    context.roles.map((role) => role.id),
  );

  const preauthorised = new Set(context.preauthorised ?? []);
  const approvalNodes = new Set(
    brief.steps.filter((step) => (step.type ?? 'agent') === 'approval').map((step) => step.nodeId),
  );
  const needsVision = brief.attachments.some((attachment) => attachment.kind === 'image');

  for (const step of brief.steps) {
    if ((step.type ?? 'agent') !== 'agent') continue;
    const role = context.roles.find((candidate) => candidate.id === step.roleId);
    if (!role) continue;

    const caps = context.capabilities?.[step.nodeId];

    // 1. The model cannot do what the node needs. Only `unsupported` refuses;
    //    `unknown` proceeds, because a catalogue that knows nothing about a
    //    model is the normal case and not evidence against it.
    if (caps?.toolCalling === 'unsupported' && role.toolAllowlist.length > 0) {
      problems.push({
        nodeId: step.nodeId,
        message: `"${step.model}" cannot call tools, and ${role.name} needs them. Choose another model, or an agent with no tools.`,
      });
    }
    if (caps?.vision === 'unsupported' && needsVision) {
      problems.push({
        nodeId: step.nodeId,
        message: `"${step.model}" cannot read images, and this automation attaches one.`,
      });
    }

    // 2. An irreversible tool with nothing between it and the world.
    //
    // Only grants no set of arguments could make safe. The argument-dependent
    // ones — an HTTP POST, say — are caught by the Governor at call time,
    // which is the only place their arguments exist. Refusing them here would
    // mean refusing every automation that can look something up.
    const risky = alwaysIrreversibleTools(role.toolAllowlist);
    if (risky.length === 0) continue;
    if (preauthorised.has(step.nodeId)) continue;

    const upstream = upstreamOf(brief, step.nodeId);
    const gated = [...approvalNodes].some((nodeId) => upstream.has(nodeId));
    if (!gated) {
      problems.push({
        nodeId: step.nodeId,
        message: `${role.name} may use ${risky.join(', ')}, which cannot be undone. Put an approval step before it, or pre-authorise this step.`,
        // Refused at save, not only at run: the saved file is what one person
        // sends another, and it has to be safe in their hands too.
        stops: 'save',
      });
    }
  }

  return problems;
}
