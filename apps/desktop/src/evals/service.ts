import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  Governor,
  checkCase,
  createRoleRegistry,
  runAutomation,
  type EvalCase,
  type EvalOutcome,
  type RunBrief,
} from '@chimera/core';
import type {
  AdapterCallOptions,
  ConnectionTestResult,
  ModelDescriptor,
  NormalisedRequest,
  NormalisedResponse,
  ProviderAdapter,
  StreamEvent,
} from '@chimera/providers';
import { evalsRepository, runsRepository, workflowsRepository } from '@chimera/store';
import {
  connectInProcess,
  createFilesystemServer,
  createMemoryServer,
  createSandbox,
  createShellServer,
  createToolRegistry,
} from '@chimera/tools';
import { getStore } from '../store/lifecycle.ts';
import { localBackend } from '../memory/backend.ts';

// M9-2. Golden cases, run against the mock provider.
//
// Against the mock by default and not as an option: CLAUDE.md forbids CI
// touching a real provider, and an eval suite that cost money every time it ran
// is an eval suite that stops being run. What these cases test is the
// automation — its shape, its branches, its output contract — with the model
// held still.

export interface EvalReport {
  workflowId: string;
  outcomes: EvalOutcome[];
  passed: boolean;
  /** True when this workflow declares no cases at all. */
  untested: boolean;
}

/**
 * The stand-in model a case runs against.
 *
 * It answers two different questions differently, and it has to: the agent loop
 * asks the model to do the work, and then asks it whether the work was done.
 * A stand-in that gave the same answer to both would fail every case on the
 * verification rather than on the assertion — which is what the first version
 * of this did, and the case reported "incomplete" instead of what it found.
 *
 * Verification passes by default so that a case tests the automation's output.
 * A case that wants to test a *failing* verification scripts an answer that
 * cannot satisfy its own contract.
 */
function standInFor(answer: string): ProviderAdapter {
  const text = answer === '' ? 'The step answered.' : answer;

  const reply = (request: NormalisedRequest): NormalisedResponse => {
    const asked = JSON.stringify(request.messages);
    const asksForVerdict = asked.includes('Has the task been achieved');
    const content = asksForVerdict
      ? '{"verified": true, "evidence": "the stand-in model answered"}'
      : text;

    return {
      id: 'stand-in',
      model: request.model,
      content: [{ type: 'text', text: content }],
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 50, outputTokens: 20 },
    };
  };

  return {
    // Not a real provider kind, and it does not need to be: nothing routes on
    // this — the eval runner hands the adapter straight to the engine.
    kind: 'openai-compatible',
    chat: (request: NormalisedRequest) => Promise.resolve(reply(request)),
    async *streamChat(request: NormalisedRequest): AsyncIterable<StreamEvent> {
      const response = reply(request);
      yield { type: 'start', id: 'stand-in', model: response.model };
      yield { type: 'textDelta', text };
      yield { type: 'finish', finishReason: 'stop', usage: response.usage };
    },
    listModels: (_options: AdapterCallOptions): Promise<ModelDescriptor[]> =>
      Promise.resolve([{ id: 'stand-in', displayName: 'Stand-in model' }]),
    testConnection: (_options: AdapterCallOptions): Promise<ConnectionTestResult> =>
      Promise.resolve({ ok: true, latencyMs: 0 }),
  };
}

function briefFor(definition: RunBrief, evalCase: EvalCase): RunBrief {
  return {
    ...definition,
    // The case's input replaces the brief's instruction, which is what makes a
    // case a case: the same automation, told a different thing.
    instruction: evalCase.input,
    // Attachments and triggers are left behind on purpose. A golden test that
    // read yesterday's files, or armed a watcher, would be a test with a
    // different result every day and a side effect nobody asked for.
    attachments: [],
    triggers: [],
  };
}

/**
 * Runs every case a workflow declares, and records how each went.
 *
 * Each case is a real run through the real engine — same executor, same
 * Governor, same tool servers — with only the provider replaced. A harness that
 * shortcut the engine would pass while the product failed, which is the exact
 * failure mode three defects in this repository already had.
 */
export async function runEvals(workflowId: string): Promise<EvalReport> {
  const db = getStore();
  const version = workflowsRepository.get(db, workflowId);
  if (!version) return { workflowId, outcomes: [], passed: false, untested: true };

  const definition = JSON.parse(version.definitionJson) as RunBrief;
  const cases = definition.evals ?? [];
  evalsRepository.register(
    db,
    workflowId,
    cases.map((evalCase) => evalCase.id),
  );

  if (cases.length === 0) return { workflowId, outcomes: [], passed: false, untested: true };

  const roles = createRoleRegistry(db).list();
  const outcomes: EvalOutcome[] = [];

  for (const evalCase of cases) {
    const runId = randomUUID();
    runsRepository.create(db, {
      id: runId,
      inputJson: JSON.stringify(briefFor(definition, evalCase)),
      triggerType: 'eval',
    });

    const sandbox = createSandbox(path.join(os.tmpdir(), 'chimera-evals'), runId);
    const tools = createToolRegistry();
    await tools.registerServer(
      'filesystem',
      await connectInProcess(createFilesystemServer(sandbox)),
    );
    await tools.registerServer('shell', await connectInProcess(createShellServer(sandbox)));
    await tools.registerServer(
      'memory',
      await connectInProcess(createMemoryServer(localBackend(runId, 'agent'))),
    );

    const provider = standInFor(evalCase.scriptedAnswer);

    let runProblem = '';
    let output = '';
    try {
      const outcome = await runAutomation({
        db,
        runId,
        brief: briefFor(definition, evalCase),
        roles,
        // The mock answers every step, whatever the step is bound to: a case
        // must not fail because the machine it runs on has no key for the
        // model the automation names.
        providerFor: () => ({
          adapter: provider,
          options: { authRef: `vault:connection:${'0'.repeat(36)}` as never },
        }),
        tools,
        governor: new Governor('enforcing'),
        // An approval node in an eval is answered "no": a golden test that
        // waited for a person would hang the suite, and one that answered
        // "yes" would be testing a gate that never gates.
        requestApproval: () =>
          Promise.resolve({ approved: false, note: 'Evals do not approve anything.' }),
      });
      output = outcome.output;
      if (outcome.status !== 'succeeded') {
        runProblem = outcome.summary ?? `The run ended as ${outcome.status}.`;
      }
    } catch (err) {
      runProblem = err instanceof Error ? err.message : String(err);
    } finally {
      await tools.close();
    }

    const result = checkCase(evalCase, output, runProblem);
    outcomes.push(result);

    evalsRepository.recordRun(db, {
      workflowId,
      workflowVersionId: version.id,
      evalId: evalCase.id,
      passFail: result.passed ? 'pass' : 'fail',
      assertionsJson: JSON.stringify(result),
      provider: 'mock',
    });
  }

  return {
    workflowId,
    outcomes,
    passed: outcomes.every((outcome) => outcome.passed),
    untested: false,
  };
}

export interface TagResult {
  tagged: boolean;
  reason: string;
}

/**
 * Marks the current version as the one this workspace trusts.
 *
 * Refused unless every declared case passed on this exact version. A workflow
 * tagged production on the strength of tests that passed two versions ago is a
 * workflow whose tag means nothing — which is the whole reason the tag exists.
 */
export function tagProduction(workflowId: string): TagResult {
  const db = getStore();
  const version = workflowsRepository.get(db, workflowId);
  if (!version) return { tagged: false, reason: 'That automation is not in this workspace.' };

  const definition = JSON.parse(version.definitionJson) as RunBrief;
  const cases = definition.evals ?? [];
  if (cases.length === 0) {
    return {
      tagged: false,
      reason: 'Add at least one check first. Nothing is production because nobody tested it.',
    };
  }

  const passing = evalsRepository.allPassingOnVersion(
    db,
    workflowId,
    version.id,
    cases.map((evalCase) => evalCase.id),
  );
  if (!passing) {
    return {
      tagged: false,
      reason: 'Its checks have not all passed on this version. Run them, and fix whatever fails.',
    };
  }

  workflowsRepository.setProductionVersion(db, workflowId, version.id);
  return {
    tagged: true,
    reason: `Version ${String(version.versionNumber)} is now the trusted one.`,
  };
}
