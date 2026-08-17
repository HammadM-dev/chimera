// The node types an automation is built from, beyond an agent.
//
// Each one exists because a real automation needs a shape a straight line
// cannot express: a branch, a repetition, a reshape, or a pause for a person.
// Each also declares its own bound — CLAUDE.md's "no unbounded loops" is not a
// rule about the loop node alone, it is a rule about anything that can repeat.

export type NodeType = 'agent' | 'condition' | 'loop' | 'transform' | 'approval' | 'subworkflow';

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
  | { type: 'subworkflow'; subworkflow: SubworkflowConfig };

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
