import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposioServer } from './composio.ts';
import type { ComposioBackend } from './composio.ts';
import { connectInProcess } from '../mcpClient.ts';
import { isIrreversible } from '../reversibility.ts';

// The Composio server, against a stand-in.
//
// Worth being plain about what this does and does not prove. It proves the
// server's own behaviour: the shape of what an agent is told, that a refusal
// reads as a refusal, and that the reversibility classification is what it
// should be. It does not prove Composio's API is what their documentation says
// — nothing here can, and the first real key is the first real test of that.

function backend(over: Partial<ComposioBackend> = {}): ComposioBackend {
  return {
    toolkits: () =>
      Promise.resolve([
        { name: 'Gmail', slug: 'gmail', isNoAuth: false, connected: true },
        { name: 'Hacker News', slug: 'hackernews', isNoAuth: true, connected: false },
      ]),
    search: () =>
      Promise.resolve([
        {
          slug: 'GMAIL_SEND_EMAIL',
          description: 'Sends an email',
          inputParameters: { type: 'object', properties: { to: { type: 'string' } } },
        },
      ]),
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
  assert.match(result.text, /inputParameters/);
});

test('a search that finds nothing says what to do next', async () => {
  const composio = await client({ search: () => Promise.resolve([]) });
  const result = await composio.callTool('search', { query: 'ride a horse' });

  assert.equal(result.isError, false);
  assert.match(result.text, /check with `toolkits`/);
});

test('an empty search is refused before it reaches the network', async () => {
  let called = false;
  const composio = await client({
    search: () => {
      called = true;
      return Promise.resolve([]);
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
