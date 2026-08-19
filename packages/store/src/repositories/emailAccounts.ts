import type Database from 'better-sqlite3';

// Mailboxes an agent may be given.
//
// The password is not in this table and never passes through it: `authRef` is a
// vault handle, and the value behind it is resolved at the moment a connection
// is opened and goes out of scope again immediately.

export interface EmailAccountRecord {
  id: string;
  label: string;
  address: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
  authRef: string;
  createdAt: string;
}

interface Row {
  id: string;
  label: string;
  address: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  auth_ref: string;
  created_at: string;
}

function toRecord(row: Row): EmailAccountRecord {
  return {
    id: row.id,
    label: row.label,
    address: row.address,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    username: row.username,
    authRef: row.auth_ref,
    createdAt: row.created_at,
  };
}

export function list(db: Database.Database): EmailAccountRecord[] {
  return (
    db
      .prepare(
        'SELECT id, label, address, imap_host, imap_port, smtp_host, smtp_port, username, auth_ref, created_at FROM email_accounts ORDER BY label',
      )
      .all() as Row[]
  ).map(toRecord);
}

export function get(db: Database.Database, id: string): EmailAccountRecord | undefined {
  const row = db
    .prepare(
      'SELECT id, label, address, imap_host, imap_port, smtp_host, smtp_port, username, auth_ref, created_at FROM email_accounts WHERE id = ?',
    )
    .get(id) as Row | undefined;
  return row ? toRecord(row) : undefined;
}

export type SaveEmailAccountInput = Omit<EmailAccountRecord, 'createdAt'>;

export function save(db: Database.Database, input: SaveEmailAccountInput): EmailAccountRecord {
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO email_accounts
       (id, label, address, imap_host, imap_port, smtp_host, smtp_port, username, auth_ref, created_at)
     VALUES (@id, @label, @address, @imapHost, @imapPort, @smtpHost, @smtpPort, @username, @authRef, @createdAt)
     ON CONFLICT(id) DO UPDATE SET
       label = @label, address = @address, imap_host = @imapHost, imap_port = @imapPort,
       smtp_host = @smtpHost, smtp_port = @smtpPort, username = @username, auth_ref = @authRef`,
  ).run({ ...input, createdAt });
  return get(db, input.id) as EmailAccountRecord;
}

export function remove(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM email_accounts WHERE id = ?').run(id).changes > 0;
}
