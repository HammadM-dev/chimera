import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCapabilitiesLookup } from './service.ts';

// What a provider publishes, over what this build happens to know.
//
// The field that matters here is price. The static matrix holds models somebody
// checked by hand; it cannot hold the four hundred OpenRouter routes to, and
// everything it misses prices as `unknown`. The Governor will not enforce a
// spend cap on a price nobody verified — correctly — so an unpriced model is an
// unbudgeted one, and "we support OpenRouter" quietly meant "budgets do not
// apply to any of it".

function catalogue(models: Record<string, unknown>): string {
  return JSON.stringify({
    capabilities: Object.fromEntries(
      Object.entries(models).map(([id, capabilities]) => [id, { displayName: id, capabilities }]),
    ),
    limits: {},
  });
}

test('a published price makes a model budgetable that the matrix cannot price', () => {
  const lookup = buildCapabilitiesLookup([
    catalogue({
      'meta/muse-spark-1.2': {
        pricing: {
          kind: 'metered',
          inputPerMillion: 0.1,
          outputPerMillion: 0.2,
          currency: 'USD',
          verifiedAt: '2026-08-25',
        },
      },
    }),
  ]);

  const found = lookup('meta/muse-spark-1.2').pricing;
  assert.equal(found.kind, 'metered');
  assert.equal(found.kind === 'metered' ? found.inputPerMillion : null, 0.1);
});

test('what the provider did not mention keeps whatever the matrix knew', () => {
  // A catalogue carrying only a price must not blank out a hand-checked
  // context window or a known tool-calling answer.
  const lookup = buildCapabilitiesLookup([
    catalogue({ 'claude-opus-5': { pricing: { kind: 'unknown' } } }),
  ]);

  const merged = lookup('claude-opus-5');
  assert.equal(merged.pricing.kind, 'unknown');
  assert.equal(merged.toolCalling, 'supported');
  assert.equal(merged.contextWindowTokens, 1_000_000);
});

test('a model nobody published is answered by the matrix, unchanged', () => {
  const lookup = buildCapabilitiesLookup([
    catalogue({ 'something/else': { vision: 'supported' } }),
  ]);

  const untouched = lookup('claude-opus-5');
  assert.equal(untouched.displayName, 'Claude Opus 5');
  assert.equal(untouched.pricing.kind, 'metered');
});

test('a catalogue that will not parse is skipped, not fatal', () => {
  // A run failing because one connection cached a broken blob would be a much
  // worse outcome than falling back to what this build already knew.
  const lookup = buildCapabilitiesLookup([
    '{not json',
    null,
    catalogue({ 'a/b': { vision: 'supported' } }),
  ]);

  assert.equal(lookup('a/b').vision, 'supported');
  assert.equal(lookup('claude-opus-5').displayName, 'Claude Opus 5');
});

test('the first connection to publish a model wins, rather than the last', () => {
  // Two connections can serve the same id. Order has to be decided rather than
  // left to whichever row came back last.
  const lookup = buildCapabilitiesLookup([
    catalogue({ 'x/y': { contextWindowTokens: 111 } }),
    catalogue({ 'x/y': { contextWindowTokens: 222 } }),
  ]);

  assert.equal(lookup('x/y').contextWindowTokens, 111);
});
