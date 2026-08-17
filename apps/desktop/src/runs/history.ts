import fs from 'node:fs/promises';
import path from 'node:path';
import {
  deadLetterRepository,
  runsRepository,
  tracesRepository,
  workflowsRepository,
} from '@chimera/store';
import { getStore } from '../store/lifecycle.ts';

// M4-7 and M4-8's main-process half: what has run, and what happened inside it.
// The trace has been written since M2-11; this is the first thing that reads it.

export interface RunListItem {
  id: string;
  name: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  tokensUsed: number;
  costUsd: number;
  errorSummary: string | null;
}

/**
 * Recent runs, newest first.
 *
 * The name comes from the brief the run was started with rather than from the
 * workflow row, because a run started from an unsaved canvas has no workflow —
 * and "Untitled" for every ad-hoc run would make the list useless exactly when
 * a user is experimenting, which is most of the time early on.
 */
export function listRuns(limit = 50): { runs: RunListItem[] } {
  const db = getStore();
  const runs = runsRepository.listRecent(db, limit).map((run) => {
    let name = '';
    try {
      name = (JSON.parse(run.inputJson) as { name?: string }).name ?? '';
    } catch {
      name = '';
    }
    return {
      id: run.id,
      name: name === '' ? 'Untitled run' : name,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      tokensUsed: run.tokensUsed,
      costUsd: run.costUsd,
      errorSummary: run.errorSummary,
    };
  });
  return { runs };
}

export interface TraceEvent {
  seq: number;
  ts: string;
  nodeId: string;
  eventType: string;
  payloadJson: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

export function listTrace(runId: string): { events: TraceEvent[] } {
  const db = getStore();
  const events = tracesRepository.listForRun(db, runId).map((event) => ({
    seq: event.seq,
    ts: event.ts,
    nodeId: event.nodeId,
    eventType: event.eventType as string,
    payloadJson: event.payloadJson,
    tokensIn: event.tokensIn,
    tokensOut: event.tokensOut,
    costUsd: event.costUsd,
  }));
  return { events };
}

/**
 * What a run could not process.
 *
 * Separate from the trace: the trace is what happened, and this is the list a
 * person has to do something about. A run over a thousand items that reports
 * "973 succeeded" and nothing else is a run whose failures nobody can act on.
 */
export function listFailures(runId: string): {
  failures: { nodeId: string; itemIndex: number; itemJson: string; error: string; ts: string }[];
} {
  const failures = deadLetterRepository.listForRun(getStore(), runId).map((row) => ({
    nodeId: row.nodeId,
    itemIndex: row.itemIndex,
    itemJson: row.itemJson,
    error: row.error,
    ts: row.ts,
  }));
  return { failures };
}

/**
 * Writes a run's whole trace to a file the user chooses.
 *
 * Exported as it is stored, with no redaction pass, because there is nothing to
 * redact: CLAUDE.md keeps secrets out of the trace at the point of writing, not
 * at the point of reading. A filter here would imply the stored trace is unsafe,
 * and an export people trust is one whose safety does not depend on this step.
 */
export async function exportTrace(runId: string): Promise<{ path: string; events: number }> {
  // Imported here rather than at module scope: a top-level `electron` import
  // pulls the whole module into anything that loads this file, including the
  // IPC registry's own test.
  const { dialog } = await import('electron');
  const db = getStore();

  const run = runsRepository.get(db, runId);
  if (!run) return { path: '', events: 0 };

  const events = listTrace(runId).events;
  // The saved automation this run belongs to, if it belongs to one. Ad-hoc
  // runs from an unsaved canvas attach to the reserved workflow row and are
  // named from their brief instead.
  const workflow = workflowsRepository.list(db).find((row) => row.id === run.workflowId);

  const result = await dialog.showSaveDialog({
    title: 'Export run trace',
    defaultPath: path.join('chimera-trace', `${runId}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || result.filePath === '') return { path: '', events: 0 };

  const document = {
    schema: 'chimera.trace.v1',
    exportedAt: new Date().toISOString(),
    run: {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      workflow: workflow?.name ?? null,
      errorSummary: run.errorSummary,
    },
    // The brief is included: a trace without what was asked for is a list of
    // answers to a question nobody wrote down.
    brief: JSON.parse(run.inputJson) as unknown,
    failures: listFailures(runId).failures,
    events: events.map((event) => ({
      ...event,
      payload: JSON.parse(event.payloadJson) as unknown,
    })),
  };

  await fs.writeFile(result.filePath, JSON.stringify(document, null, 2), 'utf8');
  return { path: result.filePath, events: events.length };
}
