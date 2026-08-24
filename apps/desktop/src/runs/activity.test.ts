import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityReader } from './activity.ts';
import type { TraceEvent } from '@chimera/core';

// What a person sees when they ask what the agent is doing.
//
// The trace is exact and unreadable; this is the translation. The tests are
// written against the payloads `agentLoop.ts` actually appends rather than
// against a shape invented here — the first version of the file read a `path`
// off `tool_result`, which no tool_result has ever carried, so the one line
// worth showing (a file was written) would never have appeared.

function call(toolId: string, args: Record<string, unknown>, callId = 'c1'): TraceEvent {
  return {
    nodeId: 'researcher-1',
    eventType: 'tool_call',
    payload: { toolId, callId, iteration: 1, arguments: args, idempotencyKey: 'k' },
  };
}

function result(
  toolId: string,
  output: string,
  options: { isError?: boolean; callId?: string } = {},
): TraceEvent {
  return {
    nodeId: 'researcher-1',
    eventType: 'tool_result',
    payload: {
      toolId,
      callId: options.callId ?? 'c1',
      output,
      isError: options.isError ?? false,
      replayedFromCheckpoint: false,
    },
  };
}

test('a page fetch says which site, not which tool', () => {
  const reader = createActivityReader();
  const activity = reader.read(call('http.request', { url: 'https://www.bankofengland.co.uk/x' }));

  assert.equal(activity?.text, 'Opening bankofengland.co.uk');
  assert.equal(activity?.kind, 'web');
  // A tool id tells somebody watching nothing they can check.
  assert.equal(activity?.text.includes('http.request'), false);
});

test('a search says what was searched for', () => {
  const reader = createActivityReader();
  const activity = reader.read(call('search.web', { query: 'UK base rate' }));

  assert.equal(activity?.text, 'Searching for “UK base rate”');
  assert.equal(activity?.kind, 'search');
});

test('a written file becomes something to save', () => {
  const reader = createActivityReader();
  // The path is on the call. The result carries only the tool id and output,
  // which is why the reader has to remember.
  reader.read(call('filesystem.writeFile', { path: 'out/report.csv', content: 'a,b\n1,2\n' }));
  const activity = reader.read(result('filesystem.writeFile', 'written'));

  assert.equal(activity?.text, 'Saved report.csv');
  assert.equal(activity?.artifact?.path, 'out/report.csv');
  assert.equal(activity?.artifact?.name, 'report.csv');
  assert.equal(activity?.artifact?.bytes, 8);
});

test('a folder is a folder, and says so', () => {
  const reader = createActivityReader();
  reader.read(call('filesystem.makeDirectory', { path: 'out/invoices' }));
  const activity = reader.read(result('filesystem.makeDirectory', 'made'));

  assert.equal(activity?.text, 'Made the folder invoices');
  assert.equal(activity?.artifact?.name, 'invoices');
});

test('a result that answers a different call does not borrow its path', () => {
  const reader = createActivityReader();
  reader.read(call('filesystem.writeFile', { path: 'out/a.csv' }, 'c1'));
  const activity = reader.read(result('filesystem.writeFile', 'written', { callId: 'c2' }));

  // No matching call, so no artifact — better than offering to save a file that
  // is not the one that was written.
  assert.equal(activity, null);
});

test('a failure is shown, and reads like one', () => {
  const reader = createActivityReader();
  const activity = reader.read(
    result('http.request', 'that host is not on the allowlist', { isError: true }),
  );

  assert.equal(activity?.kind, 'problem');
  assert.match(activity?.text ?? '', /did not work/);
  assert.match(activity?.text ?? '', /not on the allowlist/);
});

test('a successful read is not a line of its own', () => {
  const reader = createActivityReader();
  reader.read(call('http.request', { url: 'https://example.com' }));
  // The call already said what was being opened; saying it again on the way
  // back doubles the length of the feed and adds nothing.
  assert.equal(reader.read(result('http.request', 'status: 200\n\nhello')), null);
});

test('a screenshot comes back as something to look at', () => {
  const reader = createActivityReader();
  const png = `data:image/png;base64,${'A'.repeat(300)}`;
  const activity = reader.read(result('browser.screenshot', png));

  assert.equal(activity?.image, png);
  assert.equal(activity?.kind, 'web');
});

test('ordinary output is never mistaken for an image', () => {
  const reader = createActivityReader();
  reader.read(call('http.request', { url: 'https://example.com' }));
  const activity = reader.read(result('http.request', 'The rate is 3.75% as of June.'));

  assert.equal(activity, null);
});

test('the machinery of asking is not activity', () => {
  const reader = createActivityReader();
  for (const eventType of ['prompt', 'response', 'checkpoint'] as const) {
    assert.equal(
      reader.read({ nodeId: 'n', eventType, payload: { purpose: 'act' } }),
      null,
      `${eventType} should not appear in the feed`,
    );
  }
});

test('going round again says why', () => {
  const reader = createActivityReader();
  const activity = reader.read({
    nodeId: 'n',
    eventType: 'decision',
    payload: { decision: 'continue', iteration: 1, evidence: 'the totals are not in the output' },
  });

  assert.equal(activity?.kind, 'thinking');
  assert.match(activity?.text ?? '', /the totals are not in the output/);
});
