// F2.7's first memory tier: the agent's own notes during one run.
//
// In memory and run-scoped by construction. A scratchpad that quietly survived
// its run would leak one task's context into the next, which is both a
// correctness problem (stale facts asserted confidently) and a privacy one
// (a run reading notes from a task it had nothing to do with).

export interface ScratchpadEntry {
  key: string;
  value: string;
  writtenAt: number;
}

export interface Scratchpad {
  readonly runId: string;
  set: (key: string, value: string) => void;
  get: (key: string) => string | undefined;
  entries: () => ScratchpadEntry[];
  /** Rendered for the prompt. Empty string when nothing has been written. */
  render: () => string;
  clear: () => void;
}

const pads = new Map<string, Map<string, ScratchpadEntry>>();

export function createScratchpad(runId: string): Scratchpad {
  let pad = pads.get(runId);
  if (!pad) {
    pad = new Map<string, ScratchpadEntry>();
    pads.set(runId, pad);
  }
  const entries = pad;

  return {
    runId,
    set(key, value) {
      entries.set(key, { key, value, writtenAt: Date.now() });
    },
    get: (key) => entries.get(key)?.value,
    entries: () => [...entries.values()].sort((a, b) => a.key.localeCompare(b.key)),
    render() {
      if (entries.size === 0) return '';
      return [...entries.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((entry) => `${entry.key}: ${entry.value}`)
        .join('\n');
    },
    clear() {
      entries.clear();
      pads.delete(runId);
    },
  };
}

/**
 * Drops a run's scratchpad.
 *
 * Called at run end. Separate from `clear()` so a caller that never held the
 * scratchpad object — a run supervisor cleaning up after a crash, say — can
 * still release it.
 */
export function discardScratchpad(runId: string): void {
  pads.delete(runId);
}

/** Test seam. Never called in production: a run's pad is dropped when it ends. */
export function discardAllScratchpads(): void {
  pads.clear();
}
