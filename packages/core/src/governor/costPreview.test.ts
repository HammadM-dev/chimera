import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityMatrix, type ModelCapabilities } from '@chimera/providers';
import { describePreview, estimate, type PreviewNode } from './costPreview.ts';

// M3-3. The figures have to come from the models actually bound to the nodes —
// a preview computed from a constant would look authoritative and predict
// nothing.

function capabilities(inputPerMillion: number, outputPerMillion: number): ModelCapabilities {
  return {
    modelId: 'test',
    displayName: 'Test',
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    toolCalling: 'supported',
    vision: 'supported',
    streaming: 'supported',
    structuredOutput: 'supported',
    pricing: {
      kind: 'metered',
      inputPerMillion,
      outputPerMillion,
      currency: 'USD',
      verifiedAt: '2026-06-24',
    },
  };
}

const PRICES: Record<string, ModelCapabilities> = {
  cheap: capabilities(1, 5),
  expensive: capabilities(5, 25),
  unpriced: { ...capabilities(1, 5), pricing: { kind: 'unknown' } },
  local: { ...capabilities(1, 5), pricing: { kind: 'local' } },
};

const lookup = (model: string): ModelCapabilities => PRICES[model] ?? PRICES.cheap!;

function node(overrides: Partial<PreviewNode> = {}): PreviewNode {
  return {
    id: 'extract',
    model: 'cheap',
    maxIterations: 4,
    expectedInputTokensPerIteration: 2_000,
    expectedOutputTokensPerIteration: 500,
    ...overrides,
  };
}

test('the estimate comes from the bound model, not a placeholder', () => {
  // 4 iterations × (2,000 in + 500 out) = 8,000 in, 2,000 out.
  // At $1/$5 per million: 0.008 + 0.010 = $0.018.
  const preview = estimate({ nodes: [node()] }, { capabilitiesFor: lookup });

  assert.equal(preview.totalTokens, 10_000);
  assert.ok(Math.abs((preview.totalCostUsd ?? 0) - 0.018) < 1e-9);
  assert.equal(preview.unpricedModels.length, 0);
});

test('binding a node to a more expensive model raises the estimate in proportion', () => {
  const cheap = estimate({ nodes: [node({ model: 'cheap' })] }, { capabilitiesFor: lookup });
  const expensive = estimate(
    { nodes: [node({ model: 'expensive' })] },
    { capabilitiesFor: lookup },
  );

  // The expensive model is exactly 5× on both input and output, so the whole
  // estimate is 5× — which is what "proportional to the matrix's declared
  // per-million difference" means, and it only holds if the input/output split
  // is preserved rather than assumed 50/50.
  assert.ok(
    Math.abs((expensive.totalCostUsd ?? 0) - (cheap.totalCostUsd ?? 0) * 5) < 1e-9,
    `${String(expensive.totalCostUsd)} is not 5× ${String(cheap.totalCostUsd)}`,
  );
  assert.equal(expensive.totalTokens, cheap.totalTokens);
});

test("a node's declared budget caps the estimate", () => {
  const preview = estimate(
    { nodes: [node({ budget: { maxTokens: 4_000, maxCostUsd: null } })] },
    { capabilitiesFor: lookup },
  );

  // A node cannot spend more than it is allowed to, so an estimate above its
  // own cap is an estimate of something that cannot happen.
  assert.equal(preview.totalTokens, 4_000);
  assert.equal(preview.perNode[0]?.cappedByBudget, true);
});

test('item count and concurrency scale tokens, cost and time as expected', () => {
  const single = estimate({ nodes: [node()] }, { capabilitiesFor: lookup });
  const batch = estimate(
    { nodes: [node()] },
    { itemCount: 1_000, concurrency: 10, capabilitiesFor: lookup },
  );

  assert.equal(batch.totalTokens, single.totalTokens * 1_000);
  assert.ok(Math.abs((batch.totalCostUsd ?? 0) - (single.totalCostUsd ?? 0) * 1_000) < 1e-6);
  // Time divides by concurrency; money does not.
  assert.equal(batch.estimatedMs, (single.estimatedMs * 1_000) / 10);
});

test('an unpriced model makes the total null, not a partial figure dressed as the whole', () => {
  const preview = estimate(
    { nodes: [node({ id: 'a', model: 'cheap' }), node({ id: 'b', model: 'unpriced' })] },
    { capabilitiesFor: lookup },
  );

  // A total that silently omitted a node would be worse than no total, because
  // the user would budget against it.
  assert.equal(preview.totalCostUsd, null);
  assert.deepEqual(preview.unpricedModels, ['unpriced']);
  // The known part is still reported, separately and honestly labelled.
  assert.ok(preview.pricedCostUsd > 0);
  assert.equal(preview.perNode.find((entry) => entry.nodeId === 'b')?.costUsd, null);
});

test('a local model is free, which is a price rather than an absence', () => {
  const preview = estimate({ nodes: [node({ model: 'local' })] }, { capabilitiesFor: lookup });
  assert.equal(preview.totalCostUsd, 0);
  assert.deepEqual(preview.unpricedModels, []);
});

test('the summary reads the way the master plan illustrates it', () => {
  const preview = estimate(
    {
      nodes: [
        node({
          expectedInputTokensPerIteration: 3_000,
          expectedOutputTokensPerIteration: 550,
          maxIterations: 4,
          expectedMsPerIteration: 330,
        }),
      ],
    },
    { itemCount: 1_000, capabilitiesFor: lookup },
  );

  const summary = describePreview(preview);
  assert.match(summary, /^1000 items, 14\.2M tokens est, \$\d+\.\d\d est, \d+ min est$/);
});

test('the default lookup is the real capability matrix', () => {
  // No injected prices: the figure must come from the shipped matrix, so a
  // model whose price this repository has actually verified produces a real
  // number rather than a null.
  const preview = estimate({
    nodes: [
      node({
        model: 'claude-haiku-4-5',
        maxIterations: 1,
        expectedInputTokensPerIteration: 1_000_000,
        expectedOutputTokensPerIteration: 0,
      }),
    ],
  });

  const matrixPrice = capabilityMatrix.get('claude-haiku-4-5').pricing;
  assert.equal(matrixPrice.kind, 'metered');
  if (matrixPrice.kind !== 'metered') return;
  assert.ok(Math.abs((preview.totalCostUsd ?? 0) - matrixPrice.inputPerMillion) < 1e-9);
});
