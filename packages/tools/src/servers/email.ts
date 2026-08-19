import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// The email tool server.
//
// Reading a mailbox and sending from it are the two halves, and they are not
// the same kind of act: everything here that reads is contained and everything
// that sends cannot be undone. `packages/tools/src/reversibility.ts` classifies
// `email.send` and `email.reply` accordingly, so the Governor demands a human
// gate before either — and the planner now puts one there when it designs an
// automation that sends.
//
// No IMAP or SMTP library is imported here. This package stays free of both, so
// the whole path can be exercised against a fake mailbox with no network and no
// account, which is what CLAUDE.md's "never hit a real API in CI" requires of a
// feature whose real API is somebody's inbox. The desktop supplies the real
// transport.

/** One message, as the tools report it. Never the raw MIME. */
export interface MailSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  /** First line or so, for a list the model can scan without reading each one. */
  snippet: string;
}

export interface MailMessage extends MailSummary {
  body: string;
}

export interface SendRequest {
  to: string;
  subject: string;
  body: string;
  /** Set when replying, so the thread is kept. */
  inReplyTo?: string;
}

/**
 * Everything this server needs from the outside world.
 *
 * Injected rather than imported for the same reason the HTTP server takes a
 * `fetch` and the browser server takes a page: a test that had to reach a real
 * mailbox would be a test that does not run.
 */
export interface MailTransport {
  list: (mailbox: string, limit: number) => Promise<MailSummary[]>;
  read: (id: string) => Promise<MailMessage | null>;
  search: (query: { from?: string; subject?: string; since?: string }) => Promise<MailSummary[]>;
  send: (request: SendRequest) => Promise<{ id: string }>;
  /** The address messages are sent from, for the model to state what it did. */
  address: string;
}

const MAX_BODY_CHARS = 20_000;

function failure(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function ok(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

function renderSummaries(messages: MailSummary[]): string {
  if (messages.length === 0) return 'No messages matched.';
  return messages
    .map(
      (message) =>
        `id: ${message.id}\nfrom: ${message.from}\ndate: ${message.date}\nsubject: ${message.subject}\n${message.snippet}`,
    )
    .join('\n\n');
}

/**
 * Runs a handler, turning a transport failure into something the agent can read.
 *
 * A mailbox that will not answer is an ordinary condition — an expired app
 * password, a provider throttling, a laptop off the network — and an agent that
 * is told so can say what happened. An exception here would surface as a broken
 * tool instead.
 */
async function guard(
  work: () => Promise<{ content: { type: 'text'; text: string }[]; isError?: true }>,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  try {
    return await work();
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
}

export function createEmailServer(transport: MailTransport): McpServer {
  const server = new McpServer({ name: 'chimera-email', version: '0.0.0' });

  server.registerTool(
    'list',
    {
      description: `Lists recent messages in a mailbox of ${transport.address}. Reading only.`,
      inputSchema: {
        mailbox: z.string().default('INBOX'),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ mailbox, limit }) =>
      guard(async () => ok(renderSummaries(await transport.list(mailbox ?? 'INBOX', limit ?? 20)))),
  );

  server.registerTool(
    'read',
    {
      description: 'Reads one message in full, by the id given in a list or search result.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) =>
      guard(async () => {
        const message = await transport.read(id);
        if (!message) return failure(`No message with id "${id}".`);
        const body =
          message.body.length > MAX_BODY_CHARS
            ? `${message.body.slice(0, MAX_BODY_CHARS)}\n[truncated at ${String(MAX_BODY_CHARS)} characters]`
            : message.body;
        return ok(
          `from: ${message.from}\nto: ${message.to}\ndate: ${message.date}\nsubject: ${message.subject}\n\n${body}`,
        );
      }),
  );

  server.registerTool(
    'search',
    {
      description: 'Finds messages by sender, subject, or date. Reading only.',
      inputSchema: {
        from: z.string().optional(),
        subject: z.string().optional(),
        since: z.string().optional().describe('ISO date; messages on or after it'),
      },
    },
    async ({ from, subject, since }) =>
      guard(async () => {
        if (from === undefined && subject === undefined && since === undefined) {
          return failure('Give a sender, a subject, or a date to search by.');
        }
        return ok(
          renderSummaries(
            await transport.search({
              ...(from === undefined ? {} : { from }),
              ...(subject === undefined ? {} : { subject }),
              ...(since === undefined ? {} : { since }),
            }),
          ),
        );
      }),
  );

  server.registerTool(
    'send',
    {
      description: `Sends a message from ${transport.address}. This cannot be undone and needs a person to approve it.`,
      inputSchema: { to: z.string(), subject: z.string(), body: z.string() },
    },
    async ({ to, subject, body }) =>
      guard(async () => {
        const sent = await transport.send({ to, subject, body });
        return ok(`Sent to ${to} (id ${sent.id}).`);
      }),
  );

  server.registerTool(
    'reply',
    {
      description: `Replies to a message from ${transport.address}, keeping the thread. This cannot be undone and needs a person to approve it.`,
      inputSchema: { id: z.string(), body: z.string() },
    },
    async ({ id, body }) =>
      guard(async () => {
        const original = await transport.read(id);
        if (!original) return failure(`No message with id "${id}" to reply to.`);
        const sent = await transport.send({
          to: original.from,
          subject: original.subject.toLowerCase().startsWith('re:')
            ? original.subject
            : `Re: ${original.subject}`,
          body,
          inReplyTo: id,
        });
        return ok(`Replied to ${original.from} (id ${sent.id}).`);
      }),
  );

  return server;
}
