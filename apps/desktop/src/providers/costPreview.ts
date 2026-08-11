import { describePreview, estimate, type PreviewNode } from '@chimera/core';

// The main-process side of M3-3. Thin: the arithmetic lives in
// packages/core/src/governor/costPreview.ts, because the engine (M4) and the
// swarm planner (M5) need the same figures and two implementations of one
// estimate would drift into two different answers to the same question.

export interface PreviewRequest {
  itemCount?: number;
  concurrency?: number;
  nodes: PreviewNode[];
}

export function previewCost(request: PreviewRequest) {
  const preview = estimate(
    { nodes: request.nodes },
    {
      ...(request.itemCount === undefined ? {} : { itemCount: request.itemCount }),
      ...(request.concurrency === undefined ? {} : { concurrency: request.concurrency }),
    },
  );

  return { ...preview, summary: describePreview(preview) };
}
