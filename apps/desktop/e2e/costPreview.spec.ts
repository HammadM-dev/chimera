import { test, expect } from '@playwright/test';
import { freshProfile, launchApp, removeProfile } from './support/app.ts';

// M3-3's third criterion: the preview is available before `run:start` is
// called. Driven through the real preload bridge, on a fresh profile with no
// run in progress and nothing else set up — which is exactly the situation a
// user is in when they want to know what something will cost.

interface Bridge {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
}

interface Preview {
  totalTokens: number;
  totalCostUsd: number | null;
  unpricedModels: string[];
  summary: string;
  perNode: { nodeId: string; costUsd: number | null }[];
}

test('a cost preview is available before any run has started', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="app-shell"]');

    const { cheap, expensive } = await page.evaluate(async () => {
      const chimera = (window as unknown as { chimera: Bridge }).chimera;
      const nodes = (model: string) => [
        {
          id: 'extract',
          model,
          maxIterations: 4,
          expectedInputTokensPerIteration: 2_000,
          expectedOutputTokensPerIteration: 500,
        },
      ];
      return {
        cheap: (await chimera.invoke('run:costPreview', {
          itemCount: 1_000,
          nodes: nodes('claude-haiku-4-5'),
        })) as Preview,
        expensive: (await chimera.invoke('run:costPreview', {
          itemCount: 1_000,
          nodes: nodes('claude-opus-5'),
        })) as Preview,
      };
    });

    // Real figures from the shipped capability matrix, not a placeholder.
    expect(cheap.totalTokens).toBe(10_000_000);
    expect(cheap.totalCostUsd).not.toBeNull();
    expect(cheap.unpricedModels).toEqual([]);
    expect(cheap.summary).toMatch(/^1000 items, 10\.0M tokens est, \$\d+\.\d\d est, \d+ min est$/);

    // Opus is five times Haiku's rate on both input and output in the matrix,
    // so the preview moves with the binding rather than staying still.
    expect(expensive.totalCostUsd ?? 0).toBeGreaterThan(cheap.totalCostUsd ?? 0);
    expect((expensive.totalCostUsd ?? 0) / (cheap.totalCostUsd ?? 1)).toBeCloseTo(5, 5);

    // A model the matrix has no verified price for is reported as unknown, not
    // as free — the same rule the chat meter follows.
    const unpriced = await page.evaluate(async () => {
      const chimera = (window as unknown as { chimera: Bridge }).chimera;
      return (await chimera.invoke('run:costPreview', {
        nodes: [
          {
            id: 'extract',
            model: 'some-model-nobody-has-priced',
            maxIterations: 1,
            expectedInputTokensPerIteration: 1_000,
            expectedOutputTokensPerIteration: 100,
          },
        ],
      })) as Preview;
    });

    expect(unpriced.totalCostUsd).toBeNull();
    expect(unpriced.unpricedModels).toEqual(['some-model-nobody-has-priced']);
    expect(unpriced.summary).toContain('cost unknown');
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
