// F4.3's stall detector: N consecutive iterations that produce no new
// information halt the agent.
//
// "No new information" is measured against two things, not one. Output
// similarity alone would flag a careful agent that phrases its reasoning the
// same way each turn while genuinely working through different files; tool-call
// novelty alone would miss an agent that repeats the identical call forever.
// A stall is both at once: it said the same thing *and* did nothing new.

export interface StallPolicy {
  /** Consecutive uninformative iterations before the run is halted. */
  windowSize: number;
  /**
   * Similarity above which two outputs count as the same thing said twice.
   *
   * 0.9 rather than 1.0 because a model restating its position rarely restates
   * it byte-for-byte — a timestamp, a re-ordered clause or a changed adjective
   * would defeat an equality check while telling the reader nothing new.
   */
  similarityThreshold: number;
}

export const DEFAULT_STALL_POLICY: StallPolicy = { windowSize: 3, similarityThreshold: 0.9 };

export interface IterationOutcome {
  nodeId: string;
  iteration: number;
  text: string;
  /** Tool calls this iteration made, as `toolId(canonical arguments)`. */
  toolSignatures: readonly string[];
  /**
   * How many of those calls came back an error.
   *
   * Repeating yourself is one way to make no progress; the other is trying
   * something different every time and having all of it fail. A browsing agent
   * asked for something its tools could not do worked through selector after
   * selector, tool after tool — never repeating, so never stalling — and spent
   * two hundred thousand tokens before its budget stopped it.
   */
  failedTools?: number;
}

/** Words, lowercased, punctuation dropped. Enough to compare what was said. */
function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 0),
  );
}

/**
 * Jaccard similarity of two texts' word sets.
 *
 * Chosen over an edit distance because the question is "did it say the same
 * thing", not "did it type the same characters": a reordered sentence is the
 * same information, and Levenshtein would score it as a large change.
 */
export function similarity(a: string, b: string): number {
  const left = tokenise(a);
  const right = tokenise(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export interface StallVerdict {
  stalled: boolean;
  /** How many consecutive uninformative iterations have been seen. */
  repeats: number;
  /** The similarity of the most recent pair, for the denial message. */
  lastSimilarity: number;
}

/**
 * Tracks per-node iteration history and answers "is this node going in circles".
 *
 * Per node rather than per run: two nodes repeating each other is a workflow
 * design problem, not a stall, and one node's careful repetition should not be
 * charged against another's.
 */
export class StallDetector {
  private readonly policy: StallPolicy;
  private readonly history = new Map<string, IterationOutcome[]>();
  private readonly seenTools = new Map<string, Set<string>>();

  constructor(policy: StallPolicy = DEFAULT_STALL_POLICY) {
    this.policy = policy;
  }

  record(outcome: IterationOutcome): void {
    const previous = this.history.get(outcome.nodeId) ?? [];
    // Only the window is kept: a stall is about the recent past, and an
    // unbounded history would grow with the run for no benefit.
    this.history.set(outcome.nodeId, [...previous, outcome].slice(-(this.policy.windowSize + 1)));

    const seen = this.seenTools.get(outcome.nodeId) ?? new Set<string>();
    for (const signature of outcome.toolSignatures) seen.add(signature);
    this.seenTools.set(outcome.nodeId, seen);
  }

  /** Whether this node's last `windowSize` iterations told us anything new. */
  verdict(nodeId: string): StallVerdict {
    const entries = this.history.get(nodeId) ?? [];
    if (entries.length < this.policy.windowSize) {
      return { stalled: false, repeats: entries.length, lastSimilarity: 0 };
    }

    const window = entries.slice(-this.policy.windowSize);
    let repeats = 0;
    let lastSimilarity = 0;

    for (let index = 1; index < window.length; index += 1) {
      const previous = window[index - 1];
      const current = window[index];
      if (!previous || !current) continue;

      const score = similarity(previous.text, current.text);
      lastSimilarity = score;

      // A new tool call is new information whatever the prose says — the agent
      // did something it had not done before, and its next turn has a result it
      // has not seen.
      const introducedNewTool = current.toolSignatures.some(
        (signature) => !previous.toolSignatures.includes(signature),
      );

      if (score >= this.policy.similarityThreshold && !introducedNewTool) repeats += 1;
    }

    // Every call in the window tried something and every one of them failed.
    // Variety is not progress: an agent that has been refused three different
    // ways is not about to be granted a fourth.
    const allFailing =
      window.length >= this.policy.windowSize &&
      window.every(
        (entry) =>
          entry.toolSignatures.length > 0 &&
          (entry.failedTools ?? 0) >= entry.toolSignatures.length,
      );

    return {
      stalled: allFailing || repeats >= this.policy.windowSize - 1,
      repeats,
      lastSimilarity,
    };
  }

  /** Forgets a node's history. Called when a node completes. */
  forget(nodeId: string): void {
    this.history.delete(nodeId);
    this.seenTools.delete(nodeId);
  }
}

/** The canonical form a tool call is compared by. */
export function toolSignature(toolId: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(args)
      .sort()
      .map((key) => [key, args[key]]),
  );
  return `${toolId}(${canonical})`;
}
