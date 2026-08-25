import test from 'node:test';
import assert from 'node:assert/strict';
import { narrowedToApps, serverIdForApp } from './appScope.ts';
import type { Role } from '../runtime/roleRegistry.ts';

function role(over: Partial<Role> = {}): Role {
  return {
    id: 'app-operator',
    name: 'App operator (Composio)',
    systemPrompt: 'You do things in apps.',
    toolAllowlist: ['composio.*'],
    modelBinding: { tier: 'balanced', preferredModel: null },
    budget: { maxTokens: 1000, maxCostUsd: 1, maxWallClockMs: 1000 },
    outputContract: { format: 'text', schemaId: null },
    maxIterations: 5,
    combinesMany: false,
    isBuiltin: true,
    ...over,
  };
}

test('choosing no apps leaves the agent exactly as it was', () => {
  // Every automation saved before this existed. It must run unchanged.
  const before = role();
  assert.deepEqual(narrowedToApps(before, undefined).toolAllowlist, ['composio.*']);
  assert.deepEqual(narrowedToApps(before, []).toolAllowlist, ['composio.*']);
});

test('choosing an app replaces the blanket grant with that app’s server', () => {
  const narrowed = narrowedToApps(role(), ['gmail']);
  assert.deepEqual(narrowed.toolAllowlist, ['composio-gmail.*']);
  // The point of the exercise: the blanket grant is gone, so the tools of
  // every other connected app are not merely deprioritised, they are absent.
  assert.ok(!narrowed.toolAllowlist.includes('composio.*'));
});

test('two apps grant two servers and nothing wider', () => {
  const narrowed = narrowedToApps(role(), ['gmail', 'Slack']);
  assert.deepEqual(narrowed.toolAllowlist, ['composio-gmail.*', 'composio-slack.*']);
});

test('the same app named twice is granted once', () => {
  assert.deepEqual(narrowedToApps(role(), ['gmail', 'GMAIL', ' gmail ']).toolAllowlist, [
    'composio-gmail.*',
  ]);
});

test('an agent’s other tools survive the narrowing', () => {
  // Narrowing Composio must not quietly take away a grant that has nothing to
  // do with Composio.
  const narrowed = narrowedToApps(
    role({ toolAllowlist: ['composio.*', 'memory.recall', 'search.web'] }),
    ['notion'],
  );
  assert.deepEqual(narrowed.toolAllowlist, ['memory.recall', 'search.web', 'composio-notion.*']);
});

test('naming apps on an agent that cannot reach Composio grants it nothing', () => {
  // This function narrows a capability. If it could also add one, a step
  // setting on the canvas would be a way to hand a summariser somebody's
  // mailbox.
  const summariser = role({ id: 'summariser', toolAllowlist: ['memory.recall'] });
  assert.deepEqual(narrowedToApps(summariser, ['gmail']).toolAllowlist, ['memory.recall']);
});

test('the granted server id is the one the run registers under', () => {
  // These were briefly two strings in two packages — one naming the server in
  // the grant, one creating it in the run — and a mismatch between them would
  // have granted an operator a server that does not exist, which reads to the
  // model as "you have no tools" with no error anywhere. There is now one
  // function, exported from here and imported by the run, so the only thing
  // left worth asserting is that a grant is built from it rather than from a
  // second copy of the format.
  const slug = 'Google_Sheets';
  assert.deepEqual(narrowedToApps(role(), [slug]).toolAllowlist, [
    `${serverIdForApp(slug.toLowerCase())}.*`,
  ]);
  assert.equal(serverIdForApp(slug), 'composio-google_sheets');
});
