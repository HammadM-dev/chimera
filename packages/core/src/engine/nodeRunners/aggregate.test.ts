import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateWithoutModel,
  chunk,
  fillTemplate,
  itemsOf,
  jsonMerge,
  vote,
} from './aggregate.ts';
import type { AggregateConfig } from '../nodeTypes.ts';

// M5-5, one test per strategy.

function config(over: Partial<AggregateConfig> = {}): AggregateConfig {
  return {
    source: '',
    strategy: 'concat',
    separator: '',
    template: '',
    roleId: '',
    chunkSize: 10,
    instruction: '',
    ...over,
  };
}

const ITEMS = ['first answer', 'second answer', 'third answer'];

test('concat joins the answers, with a separator when one is given', () => {
  assert.equal(aggregateWithoutModel(config(), ITEMS), ITEMS.join('\n\n'));
  assert.equal(aggregateWithoutModel(config({ separator: ' | ' }), ITEMS), ITEMS.join(' | '));
});

test('json_merge folds objects and concatenates arrays', () => {
  const merged = jsonMerge(['{"a":1}', '{"b":2}', '{"a":3}', '[10,11]']);
  const parsed = JSON.parse(merged) as Record<string, unknown>;

  // Later writes win on a shared key; arrays end up in `items`.
  assert.equal(parsed['a'], 3);
  assert.equal(parsed['b'], 2);
  assert.deepEqual(parsed['items'], [10, 11]);
});

test('json_merge keeps what it could not parse rather than dropping it', () => {
  // A worker's answer discarded for being the wrong shape is a report that is
  // quietly incomplete, which is worse than one that is visibly messy.
  const parsed = JSON.parse(jsonMerge(['{"a":1}', 'sorry, I could not do this one'])) as Record<
    string,
    unknown
  >;
  assert.deepEqual(parsed['unparsed'], ['sorry, I could not do this one']);
});

test('vote takes the most common answer, ignoring case and spacing', () => {
  const result = vote(['Yes', 'no', 'yes.', ' YES ', 'no']);
  // "Yes", " YES " — one answer, two votes; "yes." is a different string.
  assert.equal(result.winner.toLowerCase(), 'yes');
  assert.equal(result.votes, 2);
});

test('a tied vote breaks to whichever was seen first', () => {
  const result = vote(['b', 'a', 'a', 'b']);
  assert.equal(result.winner, 'b');
  assert.deepEqual(
    result.tally.map((entry) => entry.votes),
    [2, 2],
  );
});

test('template fills from the items rather than evaluating anything', () => {
  const filled = fillTemplate('{{count}} answers. First: {{item.0}}. All:\n{{items}}', ITEMS);
  assert.match(filled, /^3 answers\. First: first answer\./);
  assert.match(filled, /third answer$/);
  // An unknown placeholder renders empty rather than throwing or executing.
  assert.equal(fillTemplate('{{process.exit()}}', ITEMS), '');
});

test('reduce_with_agent is not done here — it is the one that spends money', () => {
  // Returning null is how this module says "this needs the agent loop and the
  // Governor". A strategy that quietly did a model call from inside a helper
  // would be the bypass path CLAUDE.md forbids.
  assert.equal(aggregateWithoutModel(config({ strategy: 'reduce_with_agent' }), ITEMS), null);
});

test('items come back out of what a fan-out wrote', () => {
  assert.deepEqual(itemsOf('["a","b"]'), ['a', 'b']);
  assert.deepEqual(itemsOf('just one answer'), ['just one answer']);
  assert.deepEqual(itemsOf(''), []);
  // Non-string items are kept as their JSON rather than as "[object Object]".
  assert.deepEqual(itemsOf('[{"id":1}]'), ['{"id":1}']);
});

test('chunking is in order, and a chunk size below one is still one', () => {
  assert.deepEqual(chunk(['a', 'b', 'c'], 2), [['a', 'b'], ['c']]);
  assert.deepEqual(chunk(['a', 'b'], 0), [['a'], ['b']]);
});
