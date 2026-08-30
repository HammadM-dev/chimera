import os from 'node:os';
import path from 'node:path';
import { Governor, createRoleRegistry, createTraceSink, runAgentLoop } from '@chimera/core';
import { adapterFor } from '@chimera/providers';
import {
  connectInProcess,
  createFilesystemServer,
  createHttpServer,
  createSandbox,
  createSearchServer,
  createToolRegistry,
} from '@chimera/tools';
import { getSecret, runsRepository, settingsRepository, type AuthRef } from '@chimera/store';
import { getStore } from '../store/lifecycle.ts';
import { connectionFor } from '../providers/service.ts';
import { readableFolders } from '../files/grants.ts';

// What the crowd is told before it reacts.
//
// A swarm without this can only react to the sentence it was given. Ask three
// hundred people what they make of a pricing change and they will make
// something up, because nothing in the run has seen the prices — and the answer
// will read exactly as well as one that had. That is the failure worth caring
// about here: a swarm's output is prose about a population's reasoning, and
// prose about reasoning from nothing is indistinguishable from prose about
// reasoning from evidence.
//
// So one agent reads first. It is the shipped Researcher, run through the same
// agent loop, the same Governor and the same trace as any other agent in this
// product — this is not a private path to a model. It can read the folders the
// user has granted and nothing else, search the web, and fetch pages, all under
// the same limits a Researcher has anywhere else. What it writes becomes the
// background every persona is given.
//
// One call's worth of work for a run that is about to make a hundred. The cost
// argument is not close.

const BRIEFING_TASK = [
  'A simulated population is about to be asked to react to something. Your job is to find out',
  'what is actually true about it first, so they are reacting to the thing rather than to a',
  'guess at it.',
  '',
  'What they are being asked:',
].join('\n');

const BRIEFING_SHAPE = [
  '',
  'Read what you need. If the question names a file or a folder, open it. If it turns on',
  'something you can look up — a price, a competitor, a rule, what a company actually does —',
  'look it up and read the most promising sources. If it is entirely about the person’s own',
  'situation and there is nothing to check, say so in one line rather than padding it.',
  '',
  'Then write the briefing itself: the facts, the numbers, and the quotes that matter, with',
  'where each came from. Plain statements. Do not summarise opinions, do not predict how anyone',
  'will react, and do not advise — several hundred simulated people are about to do all of that,',
  'and a briefing that has already reached the conclusion is one that decides the answer before',
  'they open their mouths. Say plainly what you could not find out.',
].join('\n');

export interface Briefing {
  /** What the population is told. Empty when there was nothing to find. */
  background: string;
  /** What it cost, so the swarm can report it honestly. */
  costUsd: number;
}

/**
 * Reads around a question, and writes what the population should know.
 *
 * Returns an empty briefing rather than throwing when it cannot run. A swarm
 * that refused to start because a web search was rate-limited would be a worse
 * product than one that asks its crowd a slightly less informed question, and
 * the run says which of the two happened.
 */
export async function briefFor(input: {
  connectionId: string;
  model: string;
  question: string;
  /** Told as the research happens, so a window can say what it is reading. */
  onStep?: (what: string) => void;
}): Promise<Briefing> {
  const db = getStore();

  const role = createRoleRegistry(db).get('researcher');
  if (!role) return { background: '', costUsd: 0 };

  const connection = connectionFor(input.connectionId);
  const adapter = adapterFor(connection.kind);
  const options = {
    authRef: connection.authRef,
    ...(connection.baseUrl === null ? {} : { baseUrl: connection.baseUrl }),
  };

  // The granted folders, read fresh, so a revoke takes effect on the next run
  // rather than the next restart. Nothing else on this machine is reachable.
  const sandbox = createSandbox(
    path.join(os.tmpdir(), 'chimera-swarm'),
    `brief-${Date.now().toString(36)}`,
    readableFolders(),
  );

  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));

  // `browse` rather than an allowlist. A swarm is a thing a person asked for
  // just now, about a subject only they know, so there is no automation whose
  // declared allowlist this could inherit — and an empty allowlist would mean
  // the researcher could reach nothing at all, which is the state that made
  // `http.request` useless for a year.
  await tools.registerServer(
    'http',
    await connectInProcess(createHttpServer({ egressAllowlist: [], egressMode: 'browse' })),
  );

  const search = settingsRepository.read(db).search;
  let searchKey = '';
  if (search.provider !== 'none' && search.authRef !== '') {
    try {
      searchKey = getSecret(search.authRef as AuthRef) ?? '';
    } catch {
      // A key the keychain will not give back is a key this briefing does not
      // have. The keyless engines still answer.
      searchKey = '';
    }
  }
  await tools.registerServer(
    'search',
    await connectInProcess(
      createSearchServer({
        egressMode: 'browse',
        provider: search.provider,
        ...(searchKey === '' ? {} : { apiKey: searchKey }),
        ...(search.region === '' ? {} : { region: search.region }),
      }),
    ),
  );

  const run = runsRepository.create(db, { triggerType: 'swarm' });
  const governor = new Governor('enforcing', {
    budget: {
      perRole: {
        [role.id]: { maxTokens: role.budget.maxTokens, maxCostUsd: role.budget.maxCostUsd },
      },
    },
  });

  try {
    const result = await runAgentLoop(
      {
        runId: run.id,
        nodeId: 'swarm-briefing',
        role,
        task: `${BRIEFING_TASK}\n${input.question}\n${BRIEFING_SHAPE}`,
        connectionId: input.connectionId,
        model: input.model,
        // Nothing this agent holds can be taken back: it reads files, searches,
        // and fetches pages. There is nothing here for a gate to stand in front
        // of, and `http.request` is classified per call anyway — a POST from
        // this role would be refused rather than quietly allowed.
        gated: false,
      },
      {
        governor,
        provider: adapter,
        tools,
        callOptions: options,
        trace: createTraceSink(db, run.id),
      },
    );

    const spend = runsRepository.listRecent(db, 50).find((row) => row.id === run.id);
    runsRepository.finish(db, run.id, result.status === 'succeeded' ? 'succeeded' : 'failed', '');
    runsRepository.setOutput(db, run.id, result.output);
    input.onStep?.(result.output === '' ? 'nothing to add' : 'read up on it');

    return {
      background: result.status === 'succeeded' ? result.output.trim() : '',
      costUsd: spend?.costUsd ?? 0,
    };
  } catch {
    // A briefing that failed is a swarm that goes ahead less informed, which is
    // the right trade: the alternative is refusing to answer at all because a
    // search engine was busy.
    runsRepository.finish(db, run.id, 'failed', '');
    return { background: '', costUsd: 0 };
  }
}
