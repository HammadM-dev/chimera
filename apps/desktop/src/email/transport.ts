import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { MailMessage, MailSummary, MailTransport, SendRequest } from '@chimera/tools';
import type { EmailAccountRecord } from '@chimera/store';

// The real mailbox, behind the interface `packages/tools` defines.
//
// Everything provider-specific is here, so the tool server stays free of IMAP
// and SMTP and can be tested against a fake. This file is the only place in
// CHIMERA that opens a connection to somebody's email.
//
// A connection per call, closed in a finally. An agent's calls are seconds or
// minutes apart, IMAP servers drop idle connections and several providers count
// concurrent ones against a small limit — holding one open across a run is how
// you get "too many simultaneous connections" halfway through.

const MAX_PART_BYTES = 1_000_000;

/** Turns a transfer-encoded body part into text. */
function decodePart(raw: Buffer, encoding: string, charset: string): string {
  const transfer = encoding.toLowerCase();
  let bytes = raw;

  if (transfer === 'base64') {
    bytes = Buffer.from(raw.toString('ascii'), 'base64');
  } else if (transfer === 'quoted-printable') {
    const text = raw
      .toString('ascii')
      // A trailing = is a soft line break and the newline is not part of the
      // content.
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_all, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    bytes = Buffer.from(text, 'binary');
  }

  // Node decodes utf-8 and latin1 natively and nothing else. An unknown charset
  // is read as utf-8, which is right far more often than it is wrong and is
  // never worse than refusing to show the message at all.
  const encodingName = charset.toLowerCase();
  if (encodingName.includes('8859') || encodingName.includes('windows-125')) {
    return bytes.toString('latin1');
  }
  return bytes.toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface BodyNode {
  part?: string;
  type?: string;
  encoding?: string;
  parameters?: Record<string, string>;
  childNodes?: BodyNode[];
}

/** The part worth showing a person: plain text if there is any, else HTML. */
function readablePart(node: BodyNode | undefined): BodyNode | undefined {
  if (!node) return undefined;
  const flat: BodyNode[] = [];
  const walk = (current: BodyNode): void => {
    flat.push(current);
    for (const child of current.childNodes ?? []) walk(child);
  };
  walk(node);

  return (
    flat.find((candidate) => candidate.type === 'text/plain' && candidate.part !== undefined) ??
    flat.find((candidate) => candidate.type === 'text/html' && candidate.part !== undefined) ??
    (node.type?.startsWith('text/') === true ? node : undefined)
  );
}

function addressOf(list: { address?: string; name?: string }[] | undefined): string {
  if (!list || list.length === 0) return '';
  return list
    .map((entry) =>
      entry.name !== undefined && entry.name !== ''
        ? `${entry.name} <${entry.address ?? ''}>`
        : (entry.address ?? ''),
    )
    .join(', ');
}

function summarise(uid: number, envelope: Record<string, unknown>, snippet: string): MailSummary {
  return {
    id: String(uid),
    from: addressOf(envelope['from'] as { address?: string; name?: string }[] | undefined),
    to: addressOf(envelope['to'] as { address?: string; name?: string }[] | undefined),
    subject: (envelope['subject'] as string | undefined) ?? '(no subject)',
    date:
      envelope['date'] instanceof Date
        ? (envelope['date'] as Date).toISOString()
        : String(envelope['date'] ?? ''),
    snippet,
  };
}

export function createMailTransport(account: EmailAccountRecord, password: string): MailTransport {
  const imap = (): ImapFlow =>
    new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapPort === 993,
      auth: { user: account.username, pass: password },
      // Off: the client's own logger writes message metadata to stdout, which
      // is the main process's log. Somebody's subject lines are not ours to
      // put there.
      logger: false,
    });

  const withMailbox = async <T>(
    mailbox: string,
    body: (client: ImapFlow) => Promise<T>,
  ): Promise<T> => {
    const client = imap();
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await body(client);
    } finally {
      lock.release();
      await client.logout().catch(() => undefined);
    }
  };

  const bodyOf = async (client: ImapFlow, uid: number): Promise<string> => {
    const fetched = await client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
    if (!fetched) return '';
    const part = readablePart(fetched.bodyStructure as BodyNode | undefined);
    if (!part) return '';

    const download = await client.download(String(uid), part.part, { uid: true });
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of download.content) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > MAX_PART_BYTES) break;
      chunks.push(buffer);
    }

    const text = decodePart(
      Buffer.concat(chunks),
      part.encoding ?? '7bit',
      part.parameters?.['charset'] ?? 'utf-8',
    );
    return part.type === 'text/html' ? stripHtml(text) : text;
  };

  return {
    address: account.address,

    list: (mailbox, limit) =>
      withMailbox(mailbox, async (client) => {
        const total = client.mailbox === false ? 0 : client.mailbox.exists;
        if (total === 0) return [];
        // The newest, which is what "recent messages" means to a person.
        const from = Math.max(1, total - limit + 1);
        const messages: MailSummary[] = [];
        for await (const message of client.fetch(`${String(from)}:${String(total)}`, {
          envelope: true,
          uid: true,
        })) {
          messages.push(
            summarise(message.uid, message.envelope as unknown as Record<string, unknown>, ''),
          );
        }
        return messages.reverse();
      }),

    read: (id) =>
      withMailbox('INBOX', async (client) => {
        const uid = Number(id);
        if (!Number.isFinite(uid)) return null;
        const fetched = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
        if (!fetched) return null;
        const summary = summarise(uid, fetched.envelope as unknown as Record<string, unknown>, '');
        const body = await bodyOf(client, uid);
        return { ...summary, body } satisfies MailMessage;
      }),

    search: (query) =>
      withMailbox('INBOX', async (client) => {
        const criteria: Record<string, unknown> = {};
        if (query.from !== undefined) criteria['from'] = query.from;
        if (query.subject !== undefined) criteria['subject'] = query.subject;
        if (query.since !== undefined) criteria['since'] = new Date(query.since);

        const uids = await client.search(criteria, { uid: true });
        if (uids === false || uids.length === 0) return [];

        const found: MailSummary[] = [];
        // Newest first, and bounded: a search matching a whole mailbox should
        // not put ten thousand subject lines into a prompt.
        for (const uid of uids.slice(-25).reverse()) {
          const fetched = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
          if (fetched) {
            found.push(summarise(uid, fetched.envelope as unknown as Record<string, unknown>, ''));
          }
        }
        return found;
      }),

    send: async (request: SendRequest) => {
      const mailer = nodemailer.createTransport({
        host: account.smtpHost,
        port: account.smtpPort,
        secure: account.smtpPort === 465,
        auth: { user: account.username, pass: password },
      });
      try {
        const sent = await mailer.sendMail({
          from: account.address,
          to: request.to,
          subject: request.subject,
          text: request.body,
          ...(request.inReplyTo === undefined ? {} : { inReplyTo: request.inReplyTo }),
        });
        return { id: sent.messageId };
      } finally {
        mailer.close();
      }
    },
  };
}
