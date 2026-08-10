import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  MODEL_CAPABILITIES,
  FALLBACK_CAPABILITIES,
  get,
  isKnown,
  canEstimateCost,
  supports,
  listModelIds,
  type ModelCapabilities,
} from './capabilityMatrix.ts';

// One of the three CLAUDE.md unit-test targets ("governor arithmetic, schema
// validation, capability matching"), so it is a table, not a spot check: every
// seeded model is asserted field by field. A test that sampled two models would
// pass with the other seven corrupted.
const EXPECTED: ReadonlyArray<
  Pick<ModelCapabilities, 'modelId' | 'contextWindowTokens' | 'maxOutputTokens'> & {
    inputPerMillion: number | null;
    outputPerMillion: number | null;
  }
> = [
  {
    modelId: 'claude-opus-5',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMillion: 5,
    outputPerMillion: 25,
  },
  {
    modelId: 'claude-fable-5',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMillion: 10,
    outputPerMillion: 50,
  },
  {
    modelId: 'claude-opus-4-8',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMillion: 5,
    outputPerMillion: 25,
  },
  {
    modelId: 'claude-sonnet-5',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMillion: 3,
    outputPerMillion: 15,
  },
  {
    modelId: 'claude-sonnet-4-6',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMillion: 3,
    outputPerMillion: 15,
  },
  {
    modelId: 'claude-haiku-4-5',
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    inputPerMillion: 1,
    outputPerMillion: 5,
  },
  {
    modelId: 'gpt-5',
    contextWindowTokens: null,
    maxOutputTokens: null,
    inputPerMillion: null,
    outputPerMillion: null,
  },
  {
    modelId: 'gpt-5-mini',
    contextWindowTokens: null,
    maxOutputTokens: null,
    inputPerMillion: null,
    outputPerMillion: null,
  },
  {
    modelId: 'gpt-4.1',
    contextWindowTokens: null,
    maxOutputTokens: null,
    inputPerMillion: null,
    outputPerMillion: null,
  },
  {
    modelId: 'gemini-2.5-pro',
    contextWindowTokens: null,
    maxOutputTokens: null,
    inputPerMillion: null,
    outputPerMillion: null,
  },
  {
    modelId: 'gemini-2.5-flash',
    contextWindowTokens: null,
    maxOutputTokens: null,
    inputPerMillion: null,
    outputPerMillion: null,
  },
];

test('get returns the correct record for every seeded model', () => {
  for (const expected of EXPECTED) {
    const actual = get(expected.modelId);
    assert.equal(actual.modelId, expected.modelId);
    assert.equal(
      actual.contextWindowTokens,
      expected.contextWindowTokens,
      `${expected.modelId} context window`,
    );
    assert.equal(
      actual.maxOutputTokens,
      expected.maxOutputTokens,
      `${expected.modelId} max output`,
    );

    if (expected.inputPerMillion === null) {
      assert.equal(actual.pricing.kind, 'unknown', `${expected.modelId} should be unpriced`);
    } else {
      assert.equal(actual.pricing.kind, 'metered', `${expected.modelId} should be priced`);
      if (actual.pricing.kind !== 'metered') throw new Error('unreachable');
      assert.equal(actual.pricing.inputPerMillion, expected.inputPerMillion);
      assert.equal(actual.pricing.outputPerMillion, expected.outputPerMillion);
      assert.equal(actual.pricing.currency, 'USD');
      assert.match(actual.pricing.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test('the table above covers every seeded model — no model escapes assertion', () => {
  // Without this, adding a model to the matrix and forgetting to add it to
  // EXPECTED would leave it completely untested while the suite stayed green.
  assert.deepEqual([...listModelIds()].sort(), EXPECTED.map((e) => e.modelId).sort());
});

test('an unseeded model returns the fallback record — not undefined, not a throw', () => {
  const result = get('some-model-that-does-not-exist');
  assert.equal(result, FALLBACK_CAPABILITIES);
  assert.equal(result.contextWindowTokens, null);
  assert.equal(result.toolCalling, 'unknown');
  assert.equal(result.pricing.kind, 'unknown');
});

test('the fallback is returned for a locally served model, and claims nothing about it', () => {
  const local = get('llama-3.3-70b-instruct');
  assert.equal(local, FALLBACK_CAPABILITIES);
  // Deliberately NOT 'local' pricing: this same record answers for unrecognised
  // *cloud* models too, and assuming free is the one wrong answer that costs money.
  assert.equal(local.pricing.kind, 'unknown');
});

test('a router-prefixed model id resolves to the underlying model', () => {
  // OpenRouter and similar address models as vendor/model.
  assert.equal(get('anthropic/claude-opus-5').modelId, 'claude-opus-5');
  assert.equal(get('openai/gpt-5').modelId, 'gpt-5');
  // ...and an unknown model behind a prefix still falls back rather than throwing.
  assert.equal(get('someone/unknown-model'), FALLBACK_CAPABILITIES);
});

test('isKnown distinguishes a seeded model from one that fell back', () => {
  assert.equal(isKnown('claude-opus-5'), true);
  assert.equal(isKnown('anthropic/claude-opus-5'), true);
  assert.equal(isKnown('not-a-real-model'), false);
});

test('canEstimateCost is false exactly when the price is unverified', () => {
  assert.equal(canEstimateCost('claude-opus-5'), true);
  // The Governor must refuse to enforce a spend cap on these rather than guess.
  assert.equal(canEstimateCost('gpt-5'), false);
  assert.equal(canEstimateCost('not-a-real-model'), false);
});

test('supports reports the tri-state, never collapsing unknown to false', () => {
  assert.equal(supports('claude-opus-5', 'toolCalling'), 'supported');
  assert.equal(supports('claude-opus-5', 'vision'), 'supported');
  // The distinction that matters: an unseeded model is 'unknown', not
  // 'unsupported'. Collapsing the two would silently disable tools on a model
  // that handles them fine.
  assert.equal(supports('not-a-real-model', 'toolCalling'), 'unknown');
  assert.notEqual(supports('not-a-real-model', 'toolCalling'), 'unsupported');
});

test('every record is internally consistent', () => {
  for (const record of Object.values(MODEL_CAPABILITIES)) {
    assert.ok(record.modelId.length > 0);
    assert.ok(record.displayName.length > 0);
    // A context window without a max output (or vice versa) means someone
    // verified half a model.
    assert.equal(
      record.contextWindowTokens === null,
      record.maxOutputTokens === null,
      `${record.modelId}: context window and max output must both be known or both unknown`,
    );
    if (record.maxOutputTokens !== null && record.contextWindowTokens !== null) {
      assert.ok(
        record.maxOutputTokens <= record.contextWindowTokens,
        `${record.modelId}: max output exceeds its own context window`,
      );
    }
    if (record.pricing.kind === 'metered') {
      assert.ok(record.pricing.outputPerMillion >= record.pricing.inputPerMillion);
      assert.ok(record.pricing.inputPerMillion > 0);
    }
  }
});

test('the matrix is data, not behaviour', () => {
  // The literal acceptance criterion: the export is a plain object, and nothing
  // in it is a function that could branch.
  assert.equal(typeof MODEL_CAPABILITIES, 'object');
  assert.ok(Object.isFrozen(MODEL_CAPABILITIES));
  for (const record of Object.values(MODEL_CAPABILITIES)) {
    for (const value of Object.values(record)) {
      assert.notEqual(typeof value, 'function');
    }
  }
});

test('no lookup function branches on a provider or model family name', () => {
  // The structural half of the criterion, and the one that actually holds the
  // line: asserting the exported object is data proves nothing about the
  // functions beside it. This reads the module's own source and fails if any
  // conditional mentions a provider or model family — which is exactly how
  // "provider differences live in adapters only" would erode, one reasonable
  // -looking special case at a time.
  const source = readFileSync(path.join(import.meta.dirname, 'capabilityMatrix.ts'), 'utf8');

  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  const familyNames = [
    'anthropic',
    'openai',
    'google',
    'openrouter',
    'omniroute',
    'ollama',
    'lmstudio',
    'claude',
    'gpt',
    'gemini',
  ];

  // Any conditional construct whose test mentions a family name. Covers `if`,
  // ternaries, and switch cases alike.
  const conditionals = withoutComments.match(/(?:if\s*\([^)]*\)|case\s+[^:]*:|\?[^:\n]*:)/g) ?? [];
  for (const conditional of conditionals) {
    for (const family of familyNames) {
      assert.ok(
        !conditional.toLowerCase().includes(family),
        `capabilityMatrix.ts branches on "${family}" in: ${conditional.trim()}`,
      );
    }
  }
});
