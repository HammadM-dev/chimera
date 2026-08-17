import type Database from 'better-sqlite3';
import { blackboardRepository } from '@chimera/store';
import { evaluateCondition } from '../nodeTypes.ts';
import type { SwarmConfig } from '../nodeTypes.ts';

// F5.2's collaborative swarm: an orchestrator and a set of specialists working
// on one goal through the blackboard.
//
// The shape is deliberately not "agents talking to each other". Message-passing
// between models multiplies context — every agent pays for every other agent's
// output on every turn — and it makes what happened impossible to reconstruct
// afterwards. A shared, append-only, attributed board costs one read each and
// leaves a record.

/** The engine's own ceiling, above whatever a workflow asks for. */
export const MAX_CONCURRENT_AGENTS = 20;

/** Where each kind of participant may write. Fixed by position, not by role. */
export const ORCHESTRATOR_SCOPE = 'orchestrator';
export const WORKER_SCOPE = 'workers';

export interface SwarmRoundResult {
  round: number;
  orchestrator: string;
  workers: { roleId: string; output: string; ok: boolean }[];
}

export interface SwarmOutcome {
  rounds: SwarmRoundResult[];
  /** Why it stopped, in words a person reads in the trace. */
  stopped: 'goal' | 'max-rounds' | 'stalled' | 'failed';
  reason: string;
  output: string;
  peakConcurrentAgents: number;
}

export interface SwarmDeps {
  db: Database.Database;
  runId: string;
  nodeId: string;
  config: SwarmConfig;
  /** Runs one participant and returns what it said. */
  runAgent: (input: {
    roleId: string;
    nodeId: string;
    instruction: string;
    context: string;
  }) => Promise<{ ok: boolean; output: string }>;
  cancellation?: { readonly cancelled: boolean };
}

/** What a participant is shown: the current value of every key it may read. */
export function boardContext(
  db: Database.Database,
  runId: string,
  readScopes: readonly string[],
): string {
  const entries = blackboardRepository.snapshot(db, runId, readScopes);
  if (entries.length === 0) return '';
  return entries.map((entry) => `${entry.key} (${entry.roleId}): ${entry.valueJson}`).join('\n');
}

/**
 * Runs the swarm until it finishes, gives up, or runs out of rounds.
 *
 * Every one of those three is a bound. CLAUDE.md's no-unbounded-loops rule is
 * about anything that repeats, and a swarm is the most expensive way there is
 * to repeat something.
 */
export async function runSwarm(deps: SwarmDeps): Promise<SwarmOutcome> {
  const { db, runId, nodeId, config } = deps;
  const concurrency = Math.max(1, Math.min(config.maxConcurrentAgents, MAX_CONCURRENT_AGENTS));

  const rounds: SwarmRoundResult[] = [];
  let peakConcurrentAgents = 0;
  let stalledFor = 0;
  let previousBoard = '';

  for (let round = 0; round < Math.max(1, config.maxRounds); round += 1) {
    if (deps.cancellation?.cancelled === true) {
      return {
        rounds,
        stopped: 'failed',
        reason: 'The run was cancelled.',
        output: rounds.at(-1)?.orchestrator ?? '',
        peakConcurrentAgents,
      };
    }

    // 1. The orchestrator reads the board and says what to do next.
    const orchestratorContext = boardContext(db, runId, ['*']);
    const orchestrated = await deps.runAgent({
      roleId: config.orchestratorRoleId,
      nodeId: `${nodeId}/round-${String(round)}/orchestrator`,
      instruction: `${config.goal}\n\nSay what each specialist should do next, and what is still missing.`,
      context: orchestratorContext,
    });

    if (!orchestrated.ok) {
      return {
        rounds,
        stopped: 'failed',
        reason: `The orchestrator stopped: ${orchestrated.output}`,
        output: orchestrated.output,
        peakConcurrentAgents,
      };
    }

    blackboardRepository.write(db, {
      runId,
      roleId: config.orchestratorRoleId,
      key: 'plan',
      valueJson: JSON.stringify(orchestrated.output),
      scope: ORCHESTRATOR_SCOPE,
      writeScopes: [ORCHESTRATOR_SCOPE],
    });

    // 2. The specialists work, several at a time, each reading the same board.
    const workerContext = boardContext(db, runId, ['*']);
    const results: SwarmRoundResult['workers'] = [];
    let cursor = 0;
    let inFlight = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        if (index >= config.agents.length) return;
        cursor += 1;
        const agent = config.agents[index];
        if (!agent) return;

        inFlight += 1;
        peakConcurrentAgents = Math.max(peakConcurrentAgents, inFlight);
        try {
          const answer = await deps.runAgent({
            roleId: agent.roleId,
            nodeId: `${nodeId}/round-${String(round)}/${agent.roleId}-${String(index)}`,
            instruction: agent.instruction,
            context: workerContext,
          });
          results.push({ roleId: agent.roleId, output: answer.output, ok: answer.ok });

          if (answer.ok) {
            blackboardRepository.write(db, {
              runId,
              roleId: agent.roleId,
              // Keyed by the agent, not by the agent and the round. Append-only
              // keeps every round either way, and a key per round would make
              // the board grow on every pass — which would make "nothing
              // changed" impossible to detect, because the keys always change
              // even when the answers do not.
              key: agent.roleId,
              valueJson: JSON.stringify(answer.output),
              scope: WORKER_SCOPE,
              writeScopes: [WORKER_SCOPE],
            });
          }
        } finally {
          inFlight -= 1;
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    rounds.push({ round, orchestrator: orchestrated.output, workers: results });

    // 3. Three ways to stop, checked in the order that costs least.
    if (config.goalPredicate && evaluateCondition(config.goalPredicate, orchestrated.output)) {
      return {
        rounds,
        stopped: 'goal',
        reason: 'The orchestrator said the goal was met.',
        output: orchestrated.output,
        peakConcurrentAgents,
      };
    }

    const board = boardContext(db, runId, ['*']);
    // A round that added nothing to the board is a round that changed nothing.
    // Counting rounds rather than measuring similarity: a cheap, explainable
    // rule beats a clever one nobody can predict.
    stalledFor = board === previousBoard ? stalledFor + 1 : 0;
    previousBoard = board;

    if (config.stallRounds > 0 && stalledFor >= config.stallRounds) {
      return {
        rounds,
        stopped: 'stalled',
        reason: `Nothing changed for ${String(stalledFor)} rounds, so it stopped rather than paying for more of the same.`,
        output: orchestrated.output,
        peakConcurrentAgents,
      };
    }
  }

  return {
    rounds,
    stopped: 'max-rounds',
    reason: `It used all ${String(Math.max(1, config.maxRounds))} rounds.`,
    output: rounds.at(-1)?.orchestrator ?? '',
    peakConcurrentAgents,
  };
}
