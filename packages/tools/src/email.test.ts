import test from 'node:test';
import assert from 'node:assert/strict';
import { isIrreversible } from './reversibility.ts';
import { createToolRegistry } from './toolRegistry.ts';
import { connectInProcess } from './mcpClient.ts';
import { createEmailServer, type MailTransport, type MailSummary } from './servers/email.ts';

const ALLOWED = { role: { id: 'mailer', toolAllowlist: ['email.*'] } };

// The email server, against a mailbox that exists only here. No IMAP, no SMTP,
// no account: the point of injecting the transport is that the whole path can
// be exercised without one, because the real API for this feature is somebody's
// inbox and CLAUDE.md does not let CI near it.

function fakeMailbox(): { transport: MailTransport; sent: { to: string; subject: string }[] } {
  const messages: (MailSummary & { body: string })[] = [
    {
      id: 'm-1',
      from: 'accounts@northgate.test',
      to: 'me@bellweather.test',
      subject: 'Invoice INV-1044',
      date: '2026-08-14T09:00:00Z',
      snippet: 'Please find attached',
      body: 'Please find attached invoice INV-1044 for GBP 24,960.00.',
    },
    {
      id: 'm-2',
      from: 'legal@northgate.test',
      to: 'me@bellweather.test',
      subject: 'Renewal notice',
      date: '2026-08-15T11:00:00Z',
      snippet: 'The agreement renews',
      body: 'The agreement renews on 28 February 2027.',
    },
  ];
  const sent: { to: string; subject: string }[] = [];

  return {
    sent,
    transport: {
      address: 'me@bellweather.test',
      list: (_mailbox, limit) => Promise.resolve(messages.slice(0, limit)),
      read: (id) => Promise.resolve(messages.find((message) => message.id === id) ?? null),
      search: (query) =>
        Promise.resolve(
          messages.filter(
            (message) =>
              (query.from === undefined || message.from.includes(query.from)) &&
              (query.subject === undefined || message.subject.includes(query.subject)),
          ),
        ),
      send: (request) => {
        sent.push({ to: request.to, subject: request.subject });
        return Promise.resolve({ id: 'sent-1' });
      },
    },
  };
}

/**
 * Calls a tool the way a run does: through a real registry, over the in-process
 * transport, with a role whose allowlist has to permit it.
 */
async function withMailbox(
  body: (
    call: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{ text: string; isError: boolean }>,
    sent: { to: string; subject: string }[],
  ) => Promise<void>,
  override?: Partial<MailTransport>,
): Promise<void> {
  const { transport, sent } = fakeMailbox();
  const registry = createToolRegistry();
  await registry.registerServer(
    'email',
    await connectInProcess(createEmailServer({ ...transport, ...override })),
  );
  try {
    await body(async (name, args) => {
      const result = await registry.invoke(`email.${name}`, args, ALLOWED);
      return { text: result.text, isError: result.isError };
    }, sent);
  } finally {
    await registry.close();
  }
}

test('sending is irreversible and reading is not — the whole safety story in one assertion', () => {
  // Which means the Governor gates send and reply, and leaves triage alone.
  assert.equal(isIrreversible('email.send'), true);
  assert.equal(isIrreversible('email.reply'), true);
  assert.equal(isIrreversible('email.list'), false);
  assert.equal(isIrreversible('email.read'), false);
  assert.equal(isIrreversible('email.search'), false);
});

test('a mailbox can be listed, read and searched', async () => {
  await withMailbox(async (call) => {
    const listed = await call('list', { mailbox: 'INBOX', limit: 20 });
    assert.match(listed.text, /INV-1044/);
    assert.match(listed.text, /Renewal notice/);

    const read = await call('read', { id: 'm-2' });
    assert.match(read.text, /28 February 2027/);

    const found = await call('search', { subject: 'Renewal' });
    assert.match(found.text, /m-2/);
    assert.doesNotMatch(found.text, /INV-1044/);
  });
});

test('reading a message that is not there says so rather than inventing one', async () => {
  await withMailbox(async (call) => {
    const result = await call('read', { id: 'nope' });
    assert.equal(result.isError, true);
    assert.match(result.text, /No message with id/);
  });
});

test('a search with nothing to search by is refused, not answered with everything', async () => {
  await withMailbox(async (call) => {
    const result = await call('search', {});
    assert.equal(result.isError, true);
  });
});

test('a reply goes to the sender and keeps the thread', async () => {
  await withMailbox(async (call, sent) => {
    const result = await call('reply', { id: 'm-1', body: 'The purchase order is missing.' });
    assert.equal(result.isError, false);
    assert.deepEqual(sent, [{ to: 'accounts@northgate.test', subject: 'Re: Invoice INV-1044' }]);
  });
});

test('a reply to a message already titled Re: does not become Re: Re:', async () => {
  await withMailbox(async (call, sent) => {
    await call('reply', { id: 'm-1', body: 'x' });
    await call('reply', { id: 'm-1', body: 'y' });
    assert.deepEqual(
      sent.map((message) => message.subject),
      ['Re: Invoice INV-1044', 'Re: Invoice INV-1044'],
    );
  });
});

test('a mailbox that will not answer is reported, not thrown', async () => {
  await withMailbox(
    async (call) => {
      const result = await call('list', { mailbox: 'INBOX', limit: 5 });
      assert.equal(result.isError, true);
      // The provider's own words: an expired app password is the commonest
      // cause and the only useful thing to tell somebody.
      assert.match(result.text, /AUTHENTICATIONFAILED/);
    },
    { list: () => Promise.reject(new Error('Invalid credentials (AUTHENTICATIONFAILED)')) },
  );
});

test('a role without the grant cannot reach the mailbox at all', async () => {
  const { transport } = fakeMailbox();
  const registry = createToolRegistry();
  await registry.registerServer('email', await connectInProcess(createEmailServer(transport)));
  try {
    await assert.rejects(() =>
      registry.invoke(
        'email.list',
        { mailbox: 'INBOX' },
        { role: { id: 'researcher', toolAllowlist: ['filesystem.readFile'] } },
      ),
    );
  } finally {
    await registry.close();
  }
});
