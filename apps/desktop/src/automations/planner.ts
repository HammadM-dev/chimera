import { ProviderError } from '@chimera/errors';
import { adapterFor, textOf } from '@chimera/providers';
import { createGovernor, enforceOutputContract } from '@chimera/core';
import { listRoles } from '../roles/service.ts';
import { connectionFor } from '../providers/service.ts';

// Turns "what I want automated" into a draft automation.
//
// The model chooses *which agents* and *what each is told*, from the roster
// that actually exists — not from an invented vocabulary. A planner free to
// name agents CHIMERA does not have would produce a template that looks right
// and cannot be built.

export interface PlannedStep {
  roleId: string;
  instruction: string;
}

export interface PlannedAutomation {
  name: string;
  summary: string;
  steps: PlannedStep[];
}

const SCHEMA = {
  type: 'object',
  required: ['name', 'summary', 'steps'],
  properties: {
    name: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['roleId', 'instruction'],
        properties: {
          roleId: { type: 'string', minLength: 1 },
          instruction: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

export async function planAutomation(input: {
  connectionId: string;
  model: string;
  description: string;
}): Promise<PlannedAutomation> {
  const roster = listRoles().roles;
  if (roster.length === 0) throw new ProviderError('PLANNER_NO_ROLES', 'No agents are available.');

  const connection = connectionFor(input.connectionId);
  const adapter = adapterFor(connection.kind);
  const options = {
    authRef: connection.authRef,
    ...(connection.baseUrl === null ? {} : { baseUrl: connection.baseUrl }),
  };

  const catalogue = roster
    .map(
      (role) =>
        `- ${role.id}: ${role.name}. ${role.systemPrompt} Tools: ${
          role.toolAllowlist.length === 0 ? 'none' : role.toolAllowlist.join(', ')
        }.`,
    )
    .join('\n');

  const system = [
    'You design automations for CHIMERA by choosing agents from a fixed roster and saying what each one should do.',
    '',
    'The roster, and it is the whole roster — every roleId you use must appear here:',
    catalogue,
    '',
    'Rules. Use the fewest agents that do the job. Order them so each has what it needs from the one before.',
    'Give each a concrete instruction naming what it produces, not a restatement of its role.',
    'If the work needs checking, end with a reviewer or qa step — most useful automations do.',
    'Answer with JSON only: {"name": string, "summary": string, "steps": [{"roleId": string, "instruction": string}]}.',
    'The summary is one or two sentences a person reads to decide whether this is what they meant.',
  ].join('\n');

  // The Governor is on this path like every other model call. Permissive here:
  // planning is a single call the user explicitly asked for, and the enforcing
  // policy belongs to a run, which this is not.
  const governor = createGovernor();

  const result = await enforceOutputContract(
    { schema: SCHEMA, onInvalid: 'repair_once' },
    async (repair) => {
      const authorization = governor.authorizeModelCall({
        runId: 'planner',
        nodeId: 'planner',
        roleId: 'planner',
        iteration: 0,
        depth: 0,
        purpose: 'plan',
        connectionId: input.connectionId,
        model: input.model,
        estimatedInputTokens: Math.ceil((system.length + input.description.length) / 4),
        estimatedOutputTokens: 800,
        requiredCapabilities: [],
      });
      if (authorization.decision === 'deny') {
        throw new ProviderError('PLANNER_DENIED', authorization.message);
      }

      const response = await adapter.chat(
        {
          model: authorization.request.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: input.description },
            ...(repair === null ? [] : [{ role: 'user' as const, content: repair }]),
          ],
        },
        options,
      );
      return textOf(response);
    },
  );

  const planned = result.value as PlannedAutomation;

  // Any step naming an agent that does not exist is dropped rather than
  // rendered as a node that cannot be built. Dropping is visible — the plan is
  // shorter than described — where a broken node is not.
  const known = new Set(roster.map((role) => role.id));
  return {
    name: planned.name,
    summary: planned.summary,
    steps: planned.steps.filter((step) => known.has(step.roleId)),
  };
}
