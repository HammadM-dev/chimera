// The node types an automation is built from, beyond an agent.
//
// Each one exists because a real automation needs a shape a straight line
// cannot express: a branch, a repetition, a reshape, a pause for a person,
// another automation, or the same work over a thousand items at once.
// Each also declares its own bound — CLAUDE.md's "no unbounded loops" is not a
// rule about the loop node alone, it is a rule about anything that can repeat.

export type NodeType =
  | 'agent'
  | 'condition'
  | 'loop'
  | 'transform'
  | 'approval'
  | 'subworkflow'
  | 'fanout'
  | 'aggregate'
  | 'team';

/**
 * Branches on what a previous step produced.
 *
 * The test is a declared comparison, not an expression to evaluate. A workflow
 * that could run arbitrary code in its condition would be a code-execution
 * surface reachable from a saved file, and the saved file is the thing users
 * will send each other.
 */
export interface ConditionConfig {
  /** Which step's output to look at. Empty means the immediately previous one. */
  source: string;
  test: 'contains' | 'equals' | 'matches' | 'isEmpty' | 'notEmpty';
  /** The value to compare against. Unused by `isEmpty`/`notEmpty`. */
  value: string;
  /** Node ids to run when the test passes. Everything else downstream is skipped. */
  whenTrue: string[];
  whenFalse: string[];
}

/**
 * Repeats the steps it contains.
 *
 * `maxIterations` is required and has no default. A loop whose bound is
 * implicit is a loop somebody will forget to set, and the failure mode is a
 * bill rather than an error.
 */
export interface LoopConfig {
  body: string[];
  maxIterations: number;
  /** Stops early when this holds. Optional — the bound is what makes it safe. */
  until?: ConditionConfig;
}

/**
 * Reshapes data between steps without a model call.
 *
 * A template with `{{step-id}}` placeholders, filled from earlier outputs.
 * Deliberately not a scripting language: the same reasoning as the condition,
 * and because most of what people need here is "join these two answers".
 */
export interface TransformConfig {
  template: string;
}

/**
 * Runs the same steps over many items, several at a time.
 *
 * `concurrency` is how many items are in flight, not how many exist — the rest
 * queue. Sized to the provider's rate-limit headroom rather than to ambition:
 * a thousand simultaneous calls is a thousand rate-limit errors.
 */
export interface FanoutConfig {
  /** Which step's output holds the items. Empty means the step before. */
  source: string;
  /** How to read that output as a list. Declared, never evaluated. */
  parse: 'json' | 'lines';
  /** Node ids run once per item. */
  body: string[];
  concurrency: number;
  /** The bound on the work, the way a loop declares one. */
  maxItems: number;
  /** `continue` collects failures and carries on; `halt` stops at the first. */
  onItemError: 'continue' | 'halt';
  /**
   * How many items may fail before the whole node stops.
   *
   * A systematic failure — a bad prompt, a provider outage — should not burn
   * the entire budget proving itself a thousand times.
   */
  deadLetterLimit: number;
}

/**
 * An orchestrator and a set of specialists on one goal.
 *
 * Every field that can make it repeat declares a bound. A swarm is the most
 * expensive way there is to repeat something, so it gets three ways to stop:
 * the goal being met, the rounds running out, and nothing changing.
 */
export interface TeamConfig {
  goal: string;
  orchestratorRoleId: string;
  agents: { roleId: string; instruction: string }[];
  maxRounds: number;
  /** Hard-capped at 20 by the engine — past that, coordination costs more than it produces. */
  maxConcurrentAgents: number;
  /** Stop after this many rounds that changed nothing. 0 disables it. */
  stallRounds: number;
  /** Tested against the orchestrator's answer each round. */
  goalPredicate?: ConditionConfig;
}

/**
 * Turns many answers into one.
 *
 * The counterpart to a fan-out. Four of its five strategies need no model at
 * all, which is the point: paying a frontier model to concatenate a thousand
 * answers is the commonest way an agent system becomes expensive for nothing.
 */
export interface AggregateConfig {
  /** Which step's output holds the items. Empty means the step before. */
  source: string;
  strategy: 'concat' | 'json_merge' | 'reduce_with_agent' | 'vote' | 'template';
  /** `concat` only. Empty means a blank line between items. */
  separator: string;
  /** `template` only. `{{items}}`, `{{count}}`, `{{item.0}}`. */
  template: string;
  /** `reduce_with_agent` only: who folds, how many at a time, and told what. */
  roleId: string;
  chunkSize: number;
  instruction: string;
}

/**
 * Runs another saved automation inside this one.
 *
 * Pinned to a version, not to "whatever that automation is now". A child that
 * changes under a running parent is a parent that stops meaning what its author
 * read when they wrote it.
 */
export interface SubworkflowConfig {
  workflowId: string;
  /** The version to run. Empty means the latest at the time of the run. */
  version: string;
}

/** Pauses for a person. The runtime half of the irreversible-action gate. */
export interface ApprovalConfig {
  prompt: string;
  /** Shown to the approver so they can see what they are approving. */
  showSource: string;
}

export type NodeConfig =
  | { type: 'agent' }
  | { type: 'condition'; condition: ConditionConfig }
  | { type: 'loop'; loop: LoopConfig }
  | { type: 'transform'; transform: TransformConfig }
  | { type: 'approval'; approval: ApprovalConfig }
  | { type: 'subworkflow'; subworkflow: SubworkflowConfig }
  | { type: 'fanout'; fanout: FanoutConfig }
  | { type: 'aggregate'; aggregate: AggregateConfig }
  | { type: 'team'; team: TeamConfig };

/** Runs a declared comparison against a value. No evaluation, no code. */
export function evaluateCondition(config: ConditionConfig, actual: string): boolean {
  switch (config.test) {
    case 'isEmpty':
      return actual.trim() === '';
    case 'notEmpty':
      return actual.trim() !== '';
    case 'equals':
      return actual.trim() === config.value.trim();
    case 'contains':
      return actual.toLowerCase().includes(config.value.toLowerCase());
    case 'matches':
      try {
        return new RegExp(config.value).test(actual);
      } catch {
        // A malformed pattern is false rather than an exception: the condition
        // is data from a saved file, and a bad one should fail the branch, not
        // the run.
        return false;
      }
  }
}

/** Fills `{{step-id}}` from earlier outputs. An unknown id renders empty. */
export function applyTransform(config: TransformConfig, outputs: Map<string, string>): string {
  return config.template.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    return outputs.get(key.trim()) ?? '';
  });
}
