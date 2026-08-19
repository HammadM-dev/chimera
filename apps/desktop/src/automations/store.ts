import { ValidationError } from '@chimera/errors';
import {
  validateForSave,
  type BriefProblem,
  type RunBrief,
  type StepCapabilities,
} from '@chimera/core';
import { capabilityMatrix } from '@chimera/providers';
import { workflowsRepository } from '@chimera/store';
import { getStore } from '../store/lifecycle.ts';
import { allRoles } from '../roles/service.ts';
import { reloadTriggers } from '../triggers/service.ts';

// Saving and loading automations. A brief is the definition; each save is a new
// version, so a run in flight keeps the graph it started with.

/**
 * Everything wrong with an automation, in the words a user should see.
 *
 * Run before a save and before a run. Before a save because a refusal while
 * somebody is still editing costs them a minute, and the same refusal after
 * they have shared the automation costs somebody else their afternoon.
 */
export function checkAutomation(brief: RunBrief): { problems: BriefProblem[] } {
  const capabilities: Record<string, StepCapabilities> = {};
  for (const step of brief.steps) {
    if (step.model === '') continue;
    const facts = capabilityMatrix.get(step.model);
    capabilities[step.nodeId] = {
      toolCalling: facts.toolCalling,
      vision: facts.vision,
      structuredOutput: facts.structuredOutput,
    };
  }

  return {
    problems: validateForSave(brief, {
      roles: allRoles(),
      capabilities,
      ...(brief.preauthorised ? { preauthorised: brief.preauthorised } : {}),
    }),
  };
}

function refuse(problems: BriefProblem[]): never {
  throw new ValidationError(
    'AUTOMATION_INVALID',
    problems.map((problem) => problem.message).join(' '),
    { problems },
  );
}

/**
 * Throws if the automation must not exist as a file.
 *
 * A narrower bar than `assertRunnable`: a half-finished draft saves fine, and
 * an editor that refused to keep unfinished work would be an editor people
 * stopped trusting with it. What it will not keep is a file that is unsafe on
 * its own — an unbounded loop, or a step that could act irreversibly with
 * nothing gating it.
 */
export function assertSavable(brief: RunBrief): void {
  const problems = checkAutomation(brief).problems.filter((problem) => problem.stops === 'save');
  if (problems.length > 0) refuse(problems);
}

/** Throws if the automation may not be started. */
export function assertRunnable(brief: RunBrief): void {
  const { problems } = checkAutomation(brief);
  if (problems.length > 0) refuse(problems);
}

export function saveAutomation(input: { id?: string; name: string; definition: RunBrief }) {
  assertSavable(input.definition);
  const saved = workflowsRepository.save(getStore(), {
    ...(input.id === undefined ? {} : { workflowId: input.id }),
    name: input.name,
    definitionJson: JSON.stringify(input.definition),
  });
  // A trigger the user just added should be armed now, not at the next launch.
  reloadTriggers();
  return { id: saved.workflowId, versionId: saved.versionId, version: saved.versionNumber };
}

export function listAutomations() {
  return {
    workflows: workflowsRepository
      .list(getStore())
      .map((row) => ({ id: row.id, name: row.name, updatedAt: row.updatedAt })),
  };
}

/**
 * Removes a saved automation.
 *
 * There was no way to. Every draft anybody saved stayed in the sidebar for
 * good, so the list of things you work on became a list of everything you had
 * ever tried. Its runs are left where they are: a run is a record of something
 * that actually happened and of what it cost, and deleting the automation is
 * not a reason to lose the history of it.
 */
export function removeAutomation(id: string): { removed: boolean } {
  const db = getStore();
  if (!workflowsRepository.get(db, id)) return { removed: false };
  workflowsRepository.remove(db, id);
  return { removed: true };
}

export function getAutomation(id: string) {
  const version = workflowsRepository.get(getStore(), id);
  if (!version) throw new Error(`No automation with id "${id}".`);
  const summary = workflowsRepository.list(getStore()).find((row) => row.id === id);

  return {
    id,
    name: summary?.name ?? 'Automation',
    version: version.versionNumber,
    definition: JSON.parse(version.definitionJson) as RunBrief,
  };
}
