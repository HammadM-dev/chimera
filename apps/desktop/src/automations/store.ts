import type { RunBrief } from '@chimera/core';
import { workflowsRepository } from '@chimera/store';
import { getStore } from '../store/lifecycle.ts';

// Saving and loading automations. A brief is the definition; each save is a new
// version, so a run in flight keeps the graph it started with.

export function saveAutomation(input: { id?: string; name: string; definition: RunBrief }) {
  const saved = workflowsRepository.save(getStore(), {
    ...(input.id === undefined ? {} : { workflowId: input.id }),
    name: input.name,
    definitionJson: JSON.stringify(input.definition),
  });
  return { id: saved.workflowId, versionId: saved.versionId, version: saved.versionNumber };
}

export function listAutomations() {
  return {
    workflows: workflowsRepository
      .list(getStore())
      .map((row) => ({ id: row.id, name: row.name, updatedAt: row.updatedAt })),
  };
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
