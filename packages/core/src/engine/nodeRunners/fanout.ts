import type Database from 'better-sqlite3';
import { deadLetterRepository } from '@chimera/store';
import type { FanoutConfig } from '../nodeTypes.ts';

// F5.1's fan-out: the same body, run over many items, several at a time.
//
// Two numbers do the work here and they are not the same number. `concurrency`
// is how many items are *in flight*; the rest wait in the queue. A pool sized
// to the work rather than to the machine is what keeps a thousand-item run from
// opening a thousand sockets and being rate-limited into failure by its own
// provider.

export interface FanoutItemResult {
  index: number;
  ok: boolean;
  output: string;
  error: string;
}

export interface FanoutOutcome {
  /** Items that finished, in input order. */
  results: FanoutItemResult[];
  succeeded: number;
  failed: number;
  /** True when the dead-letter limit stopped the whole node. */
  halted: boolean;
  haltReason: string;
  /** The most items in flight at once. Recorded, not assumed. */
  peakInFlight: number;
}

export interface FanoutDeps {
  db: Database.Database;
  runId: string;
  nodeId: string;
  config: FanoutConfig;
  items: unknown[];
  /** Runs the body once, for one item. Rejections are failures, not crashes. */
  runItem: (input: { index: number; item: unknown }) => Promise<{ ok: boolean; output: string }>;
  cancellation?: { readonly cancelled: boolean };
  onProgress?: (done: number, total: number) => void;
}

/**
 * Splits a step's output into items.
 *
 * Two declared shapes, not an expression. The same reasoning as a condition's
 * test: this is data in a file people send each other, and a fan-out that could
 * evaluate an expression to decide what to iterate would be a loop bound
 * nobody can read.
 */
export function itemsFrom(text: string, parse: FanoutConfig['parse']): unknown[] {
  if (parse === 'lines') {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    // A single object is one item rather than an error: a step that produced
    // one result where the graph expected many is a graph that should still
    // run, once.
    return [parsed];
  } catch {
    // Not JSON at all. Falling back to lines beats failing the node, because
    // the commonest thing a model returns when asked for a list is a list.
    return itemsFrom(text, 'lines');
  }
}

/**
 * Runs the body over every item, `concurrency` at a time.
 *
 * The pool is a fixed set of workers pulling from a shared cursor rather than a
 * chunked `Promise.all`: chunking stalls the whole batch on its slowest member,
 * and with model calls the slowest member is routinely ten times the median.
 */
export async function runFanout(deps: FanoutDeps): Promise<FanoutOutcome> {
  const { db, runId, nodeId, config, items } = deps;

  const capped = items.slice(0, Math.max(0, config.maxItems));
  const workers = Math.max(1, Math.min(config.concurrency, capped.length));

  const results: FanoutItemResult[] = [];
  let cursor = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let failed = 0;
  let halted = false;
  let haltReason = '';

  const worker = async (): Promise<void> => {
    for (;;) {
      if (halted || deps.cancellation?.cancelled === true) return;
      const index = cursor;
      if (index >= capped.length) return;
      cursor += 1;

      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        const item = capped[index];
        let outcome: { ok: boolean; output: string };
        try {
          outcome = await deps.runItem({ index, item });
        } catch (err) {
          // A body that threw is one failed item, not a failed run. The whole
          // point of a dead-letter list is that one bad row does not cost the
          // other nine hundred and ninety-nine.
          outcome = { ok: false, output: err instanceof Error ? err.message : String(err) };
        }

        if (outcome.ok) {
          results.push({ index, ok: true, output: outcome.output, error: '' });
        } else {
          failed += 1;
          results.push({ index, ok: false, output: '', error: outcome.output });
          deadLetterRepository.record(db, {
            runId,
            nodeId,
            itemIndex: index,
            itemJson: JSON.stringify(item ?? null),
            error: outcome.output,
          });

          if (config.onItemError === 'halt') {
            halted = true;
            haltReason = `Item ${String(index + 1)} failed, and this fan-out stops on the first failure.`;
          } else if (failed > config.deadLetterLimit) {
            // A systematic failure should not burn the whole budget proving
            // itself a thousand times.
            halted = true;
            haltReason = `${String(failed)} items failed, past the limit of ${String(config.deadLetterLimit)}. Something is wrong with the work, not with the items.`;
          }
        }
      } finally {
        inFlight -= 1;
        deps.onProgress?.(results.length, capped.length);
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => worker()));

  results.sort((a, b) => a.index - b.index);
  return {
    results,
    succeeded: results.filter((result) => result.ok).length,
    failed,
    halted,
    haltReason,
    peakInFlight,
  };
}
