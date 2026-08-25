import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposioServer } from './composio.ts';
import type { ComposioBackend } from './composio.ts';
import { connectInProcess } from '../mcpClient.ts';
import { isIrreversible } from '../reversibility.ts';

// The Composio server, against a stand-in.
//
// The stand-in's shapes are copied from the live API, probed with a real key on
// 2026-08-25 — not from the docs and not from a guess. That distinction is the
// whole reason this file was rewritten: the first version invented a response
// shape, the code was written to match the invention, and both agreed with each
// other while agreeing with nothing Composio actually sends. Every test passed
// and `search` returned an empty list against the real service every time.
//
// What this still cannot prove is that Composio keeps sending what it sent that
// day. It proves the server's behaviour given those shapes.

function backend(over: Partial<ComposioBackend> = {}): ComposioBackend {
  return {
    toolkits: (input) =>
      Promise.resolve(
        [
          {
            name: 'Gmail',
            slug: 'gmail',
            isNoAuth: false,
            connected: true,
            description: 'Google’s email service.',
            logo: 'https://logos.composio.dev/api/gmail',
            categories: ['email'],
            toolsCount: 61,
            authSchemes: ['OAUTH2'],
            appUrl: 'https://mail.google.com',
          },
          {
            name: 'Hacker News',
            slug: 'hackernews',
            isNoAuth: true,
            connected: false,
            description: 'Reads stories and comments.',
            logo: '',
            categories: ['news'],
            toolsCount: 6,
            authSchemes: [],
            appUrl: '',
          },
        ].filter(
          (toolkit) =>
            (input?.search === undefined || toolkit.slug.includes(input.search)) &&
            (input?.connectedOnly !== true || toolkit.connected),
        ),
      ),
    search: () =>
      Promise.resolve({
        tools: [
          {
            slug: 'GMAIL_SEND_EMAIL',
            toolkit: 'GMAIL',
            description: 'Sends an email via Gmail API. Sends immediately and is irreversible.',
            inputSchema: { type: 'object', properties: { recipient_email: { type: 'string' } } },
          },
        ],
        toolkits: [
          {
            toolkit: 'gmail',
            connected: false,
            note: "No Active connection for toolkit=gmail. You MUST call COMPOSIO_MANAGE_CONNECTIONS (toolkit='gmail') to create a connection.",
          },
        ],
        guidance: ['1) CALL COMPOSIO_MANAGE_CONNECTIONS: initiate connections for inactive apps'],
        pitfalls: ['[GMAIL_SEND_EMAIL] 429 quotaExceeded: honor Retry-After'],
      }),
    execute: () => Promise.resolve({ ok: true, output: '{"id":"m1"}' }),
    ...over,
  };
}

async function client(over: Partial<ComposioBackend> = {}) {
  return connectInProcess(createComposioServer(backend(over)));
}

test('an agent is told which apps are connected, not just which exist', async () => {
  const composio = await client();
  const result = await composio.callTool('toolkits', {});

  assert.equal(result.isError, false);
  assert.match(result.text, /Gmail/);
  // The difference between "exists" and "you can use it" is the difference
  // between an agent trying and an agent saying it cannot.
  assert.match(result.text, /"connected": true/);
  assert.match(result.text, /"connected": false/);
});

test('a search returns slugs and their arguments, so the next call is informed', async () => {
  const composio = await client();
  const result = await composio.callTool('search', { query: 'send an email' });

  assert.match(result.text, /GMAIL_SEND_EMAIL/);
  // Without the schema the agent has a name and no idea what to pass it.
  assert.match(result.text, /inputSchema/);
  assert.match(result.text, /recipient_email/);
});

test('a search says whether the app is connected, not only that the tool exists', async () => {
  // The failure this prevents is an agent planning three steps around Gmail,
  // running them, and finding out at the last one that nobody ever signed in.
  const composio = await client();
  const result = await composio.callTool('search', { query: 'send an email' });

  assert.match(result.text, /"connected": false/);
  assert.match(result.text, /COMPOSIO_MANAGE_CONNECTIONS/);
});

test('a search passes on what Composio knows goes wrong with these tools', async () => {
  const composio = await client();
  const result = await composio.callTool('search', { query: 'send an email' });

  assert.match(result.text, /429/);
  assert.match(result.text, /Retry-After/);
});

test('an app search is answered by the server, not by handing back everything', async () => {
  // Composio serves toolkits fifty to a page and had twenty-eight pages of them.
  // Filtering has to happen at their end or the answer is "the first page,
  // silently" — which is what it was.
  const composio = await client();
  const all = await composio.callTool('toolkits', {});
  const one = await composio.callTool('toolkits', { search: 'gmail' });

  assert.match(all.text, /hackernews/);
  assert.match(one.text, /gmail/);
  assert.doesNotMatch(one.text, /hackernews/);
});

test('asking only for connected apps leaves out the ones nobody signed into', async () => {
  const composio = await client();
  const result = await composio.callTool('toolkits', { connectedOnly: true });

  assert.match(result.text, /gmail/);
  assert.doesNotMatch(result.text, /hackernews/);
});

test('a search that finds nothing says what to do next', async () => {
  const composio = await client({
    search: () => Promise.resolve({ tools: [], toolkits: [], guidance: [], pitfalls: [] }),
  });
  const result = await composio.callTool('search', { query: 'ride a horse' });

  assert.equal(result.isError, false);
  assert.match(result.text, /check with `toolkits`/);
});

test('an empty search is refused before it reaches the network', async () => {
  let called = false;
  const composio = await client({
    search: () => {
      called = true;
      return Promise.resolve({ tools: [], toolkits: [], guidance: [], pitfalls: [] });
    },
  });

  const result = await composio.callTool('search', { query: '   ' });
  assert.equal(result.isError, true);
  assert.equal(called, false);
});

test('a workspace with no key gets a message it can act on, not a crash', async () => {
  const composio = await client({
    toolkits: () => Promise.reject(new Error('Composio is not connected in this workspace.')),
  });

  const result = await composio.callTool('toolkits', {});
  assert.equal(result.isError, true);
  assert.match(result.text, /not connected in this workspace/);
});

test('a tool that fails at the far end is an error the agent can read', async () => {
  const composio = await client({
    execute: () => Promise.resolve({ ok: false, output: 'that mailbox is full' }),
  });

  const result = await composio.callTool('execute', { slug: 'GMAIL_SEND_EMAIL', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.text, /mailbox is full/);
});

test('running a Composio tool always needs a person to have said yes', () => {
  // The whole safety argument in one assertion. `execute` is how an agent sends
  // the email, creates the issue and charges the card, and this build has no
  // list of which of Composio's thousands are harmless — so it is irreversible
  // outright and needs an approval step, like `email.send` and `shell.exec`.
  assert.equal(isIrreversible('composio.execute', {}), true);
  assert.equal(isIrreversible('composio.execute', { slug: 'GMAIL_FETCH_EMAILS' }), true);

  // The two reads are reads.
  assert.equal(isIrreversible('composio.toolkits', {}), false);
  assert.equal(isIrreversible('composio.search', { query: 'x' }), false);
});

test('a per-app server is judged by the same rules as the shared one', () => {
  // An App operator pointed at one app is given its own server —
  // `composio-gmail` — holding that app's tools and nothing else. The tools are
  // the same three with the same consequences, so the reversibility rules have
  // to reach them.
  //
  // Getting this wrong is not a small mistake in either direction. Left to the
  // unknown-server default, `composio-gmail.search` would be irreversible, and
  // an operator narrowed to one app could not look up which tools exist without
  // an approval step in front of it. And a rule that stopped at the shared
  // server would let `composio-gmail.execute` through the gate entirely.
  assert.equal(isIrreversible('composio-gmail.execute', {}), true);
  assert.equal(isIrreversible('composio-google_sheets.execute', {}), true);
  assert.equal(isIrreversible('composio-gmail.search', { query: 'send mail' }), false);
  assert.equal(isIrreversible('composio-gmail.toolkits', {}), false);

  // A server that merely starts with the same letters is still unknown, and an
  // unknown server is irreversible.
  assert.equal(isIrreversible('composiofake.search', {}), true);
});

test('a narrowed server tells the model which app it holds', () => {
  // The limit is in the backend and stays there. This is about the model not
  // spending three turns planning around a tool it will be refused: an operator
  // that knows it holds Gmail and nothing else says so to the person, rather
  // than forming a perfect Slack call and failing at the last step.
  const shared = createComposioServer(backend());
  const scoped = createComposioServer(backend(), 'gmail');

  const describe = (server: ReturnType<typeof createComposioServer>): string =>
    JSON.stringify(
      (server as unknown as { _registeredTools: Record<string, { description?: string }> })
        ._registeredTools,
    );

  assert.ok(!describe(shared).includes('reaches gmail and nothing else'));
  const said = describe(scoped);
  assert.ok(said.includes('reaches gmail and nothing else'), said.slice(0, 200));
  // On all three tools, not just the one that acts: an agent that thinks it can
  // search every app will plan to.
  assert.equal(said.split('reaches gmail and nothing else').length - 1, 3);
});
