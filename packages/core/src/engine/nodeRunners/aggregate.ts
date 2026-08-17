import type { AggregateConfig } from '../nodeTypes.ts';

// F5.1's final step: many answers, one answer.
//
// Four of the five strategies are arithmetic on text and need no model at all,
// which matters more than it sounds — a fan-out over a thousand items produces
// a thousand answers, and paying a frontier model to concatenate them is the
// commonest way an agent system becomes expensive for no reason.

/** Splits the source output back into the items a fan-out produced. */
export function itemsOf(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
    }
  } catch {
    // Not a list. One answer is a list of one.
  }
  return text.trim() === '' ? [] : [text];
}

/**
 * Merges JSON items into one document.
 *
 * Objects merge key by key with the later write winning; arrays concatenate.
 * Anything that is not JSON is kept under `unparsed`, rather than dropped —
 * silently discarding a worker's answer because it was not the shape the
 * aggregate expected is how a report ends up quietly incomplete.
 */
export function jsonMerge(items: readonly string[]): string {
  const merged: Record<string, unknown> = {};
  const list: unknown[] = [];
  const unparsed: string[] = [];

  for (const item of items) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(item);
    } catch {
      unparsed.push(item);
      continue;
    }

    if (Array.isArray(parsed)) {
      list.push(...parsed);
    } else if (parsed !== null && typeof parsed === 'object') {
      Object.assign(merged, parsed);
    } else {
      list.push(parsed);
    }
  }

  const document: Record<string, unknown> = { ...merged };
  if (list.length > 0) document['items'] = list;
  if (unparsed.length > 0) document['unparsed'] = unparsed;
  return JSON.stringify(document, null, 2);
}

export interface VoteResult {
  winner: string;
  votes: number;
  tally: { value: string; votes: number }[];
}

/**
 * The most common answer.
 *
 * Compared on trimmed, case-folded text, because "Yes." and "yes" are one
 * answer in every case anybody runs a vote for. Ties break to whichever value
 * was seen first — a mechanical default, stated so a reader does not have to
 * guess whether it is stable.
 */
export function vote(items: readonly string[]): VoteResult {
  const counts = new Map<string, { value: string; votes: number; firstSeen: number }>();

  items.forEach((item, index) => {
    const key = item.trim().toLowerCase();
    const existing = counts.get(key);
    if (existing) {
      existing.votes += 1;
    } else {
      counts.set(key, { value: item.trim(), votes: 1, firstSeen: index });
    }
  });

  const tally = [...counts.values()].sort((a, b) =>
    b.votes === a.votes ? a.firstSeen - b.firstSeen : b.votes - a.votes,
  );

  return {
    winner: tally[0]?.value ?? '',
    votes: tally[0]?.votes ?? 0,
    tally: tally.map((entry) => ({ value: entry.value, votes: entry.votes })),
  };
}

/**
 * Fills a template from the items.
 *
 * `{{items}}` is every item joined by newlines, `{{count}}` how many there
 * were, `{{item.0}}` a specific one. A template rather than the schema's
 * `custom_expression`: the same reasoning as a condition's test — this is data
 * in a file people send each other, and an expression is a code-execution
 * surface reachable from a saved file.
 */
export function fillTemplate(template: string, items: readonly string[]): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, raw: string) => {
    const key = raw.trim();
    if (key === 'items') return items.join('\n');
    if (key === 'count') return String(items.length);
    const indexed = /^item\.(\d+)$/.exec(key);
    if (indexed) return items[Number(indexed[1])] ?? '';
    return '';
  });
}

/** Splits items into the chunks a reducing agent is asked to fold, in order. */
export function chunk(items: readonly string[], size: number): string[][] {
  const bounded = Math.max(1, size);
  const chunks: string[][] = [];
  for (let index = 0; index < items.length; index += bounded) {
    chunks.push([...items.slice(index, index + bounded)]);
  }
  return chunks;
}

/**
 * Everything that needs no model call.
 *
 * `reduce_with_agent` is absent by design: it is the one strategy that spends
 * money, so it runs where every other model call runs — through the agent loop
 * and the Governor — rather than here.
 */
export function aggregateWithoutModel(
  config: AggregateConfig,
  items: readonly string[],
): string | null {
  switch (config.strategy) {
    case 'concat':
      return items.join(config.separator === '' ? '\n\n' : config.separator);
    case 'json_merge':
      return jsonMerge(items);
    case 'vote': {
      const result = vote(items);
      return result.winner;
    }
    case 'template':
      return fillTemplate(config.template, items);
    default:
      return null;
  }
}
