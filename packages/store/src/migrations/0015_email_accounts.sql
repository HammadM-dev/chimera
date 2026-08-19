-- Mailboxes an agent may be given.
--
-- The password is not here. `auth_ref` is a vault handle like every other
-- credential in this store — CLAUDE.md, "secrets never leave the vault, not
-- into SQLite". What is here is only what it takes to find the server.
--
-- IMAP for reading and SMTP for sending are separate endpoints on nearly every
-- provider, so both are stored; a provider that uses one host for both simply
-- has the same value twice.
CREATE TABLE email_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  username TEXT NOT NULL,
  auth_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);
