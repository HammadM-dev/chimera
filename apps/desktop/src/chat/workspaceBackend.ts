import { createRoleRegistry, type Role } from '@chimera/core';
import {
  memoriesRepository,
  nodeStatesRepository,
  pluginsRepository,
  runsRepository,
  workflowsRepository,
  workspaceFactsRepository,
} from '@chimera/store';
import type { WorkspaceBackend } from '@chimera/tools';
import { getStore } from '../store/lifecycle.ts';
import { listConnections } from '../providers/service.ts';
import { listGrants } from '../files/grants.ts';
import { listTemplates } from '../templates/service.ts';
import { listFailures } from '../runs/history.ts';

// The assistant's window onto this workspace.
//
// Everything here is a read. There is no method on `WorkspaceBackend` that
// writes, and `planAutomation` returns a design rather than applying one — so
// the assistant can describe, explain and propose, and cannot change anything
// while doing it.
//
// Two things are deliberately absent and would be easy to add by accident.
// Credentials: `listConnections` returns labels, kinds and model lists, and the
// vault handle never comes with them. And run *prompts*: a run's trace holds
// every system message and every page an agent read, which is both enormous and
// full of other people's content — the assistant gets each step's answer, which
// is what somebody asking "why did this fail" actually wants.

function iso(value: string | null | undefined): string {
  return value ?? '';
}

export function workspaceBackend(input: {
  /** Designs an automation. Injected so the model binding is the caller's choice. */
  plan: (description: string) => Promise<{ name: string; summary: string; steps: unknown }>;
}): WorkspaceBackend {
  return {
    automations() {
      const db = getStore();
      const roles = createRoleRegistry(db).list();

      return workflowsRepository.list(db).map((workflow) => {
        const version = workflowsRepository.get(db, workflow.id);

        let steps: { nodeId: string; kind: string; agent: string; instruction: string }[] = [];
        let trigger = 'When you press Run';
        try {
          const definition = JSON.parse(version?.definitionJson ?? '{}') as {
            steps?: { nodeId: string; type?: string; roleId: string; instruction: string }[];
            triggers?: { kind?: string }[];
          };
          steps = (definition.steps ?? []).map((step) => ({
            nodeId: step.nodeId,
            kind: step.type ?? 'agent',
            agent: roles.find((role: Role) => role.id === step.roleId)?.name ?? step.roleId,
            instruction: step.instruction,
          }));
          const kind = definition.triggers?.[0]?.kind;
          if (kind !== undefined && kind !== 'manual') trigger = kind;
        } catch {
          // A definition that will not parse costs its steps and not the row —
          // the user still gets told the automation exists.
        }

        return {
          id: workflow.id,
          name: workflow.name,
          updatedAt: iso(workflow.updatedAt),
          steps,
          trigger,
        };
      });
    },

    agents() {
      return createRoleRegistry(getStore())
        .list()
        .map((role: Role) => ({
          id: role.id,
          name: role.name,
          systemPrompt: role.systemPrompt,
          tools: [...role.toolAllowlist],
          maxIterations: role.maxIterations,
          isBuiltin: role.isBuiltin,
        }));
    },

    runs(limit) {
      const db = getStore();
      const names = new Map(workflowsRepository.list(db).map((row) => [row.id, row.name]));

      return runsRepository.listRecent(db, limit).map((run) => ({
        id: run.id,
        automation: names.get(run.workflowId) ?? 'an unsaved automation',
        status: run.status,
        startedAt: iso(run.startedAt),
        endedAt: iso(run.endedAt),
        costUsd: run.costUsd,
        tokens: run.tokensUsed,
        error: iso(run.errorSummary),
      }));
    },

    run(runId) {
      const db = getStore();
      const record = runsRepository.get(db, runId);
      if (!record) return null;
      // Spend lives on the summary rather than the record, so it comes from the
      // recent list when the run is in it and reads as zero when it is not.
      const spend = runsRepository.listRecent(db, 200).find((row) => row.id === runId);

      const names = new Map(workflowsRepository.list(db).map((row) => [row.id, row.name]));
      const roles = createRoleRegistry(db).list();

      return {
        id: record.id,
        automation: names.get(record.workflowId) ?? 'an unsaved automation',
        status: record.status,
        startedAt: iso(record.startedAt),
        endedAt: iso(record.endedAt),
        costUsd: spend?.costUsd ?? 0,
        tokens: spend?.tokensUsed ?? 0,
        error: iso(record.errorSummary),
        output: record.output,
        steps: nodeStatesRepository.listForRun(db, runId).map((state) => ({
          nodeId: state.nodeId,
          // The node id carries the role at its front — `researcher-1` — which
          // is the only name available here, node states not recording one.
          label: roles.find((role: Role) => state.nodeId.startsWith(role.id))?.name ?? state.nodeId,
          status: state.status,
          output: '',
        })),
        failures: listFailures(runId).failures.map(
          (failure) => `${failure.itemJson.slice(0, 120)}: ${failure.error}`,
        ),
      };
    },

    notes(query, limit) {
      const db = getStore();

      const memories = memoriesRepository.search(db, query, limit).map((memory) => ({
        kind: memory.kind,
        subject: memory.subject,
        body: memory.body,
        source: memory.source,
        updatedAt: iso(memory.updatedAt),
      }));

      // Facts a person typed, kept apart from what an agent inferred, because
      // they are not equally trustworthy and the assistant should say which is
      // which when it repeats one.
      const facts = workspaceFactsRepository
        .list(db)
        .filter(
          (fact) =>
            query === '' ||
            fact.key.toLowerCase().includes(query.toLowerCase()) ||
            fact.value.toLowerCase().includes(query.toLowerCase()),
        )
        .slice(0, limit)
        .map((fact) => ({
          kind: 'fact',
          subject: fact.key,
          body: fact.value,
          source: fact.source,
          updatedAt: iso(fact.updatedAt),
        }));

      return [...facts, ...memories].slice(0, limit);
    },

    plugins() {
      return pluginsRepository.list(getStore()).map((plugin) => ({
        name: plugin.name,
        kind: plugin.kind,
        enabled: plugin.enabled,
        tools: plugin.tools.map((tool) => tool.name),
      }));
    },

    providers() {
      // Labels, kinds, models and health. The vault handle is on the record and
      // is not copied here — there is nothing in this shape that could hold one.
      return listConnections().connections.map((connection) => ({
        label: connection.label,
        kind: connection.kind,
        models: connection.models,
        health: connection.healthState,
      }));
    },

    templates() {
      return listTemplates().templates.map((template) => ({
        id: template.id,
        name: template.name,
        audience: template.audience,
        summary: template.summary,
      }));
    },

    folders() {
      return listGrants().grants.map((grant) => grant.path);
    },

    planAutomation: input.plan,
  };
}
