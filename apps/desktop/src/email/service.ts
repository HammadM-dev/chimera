import { randomUUID } from 'node:crypto';
import {
  emailAccountsRepository,
  setSecret,
  getSecret,
  deleteSecret,
  type AuthRef,
  type EmailAccountRecord,
} from '@chimera/store';
import { ValidationError } from '@chimera/errors';
import { getStore } from '../store/lifecycle.ts';
import { presetFor } from './presets.ts';

// Mailboxes this workspace can reach.
//
// The password goes to the OS keychain on the way in and is read back only when
// a connection is opened. Nothing here returns it, and the summaries that cross
// the preload bridge carry the address and the hosts — never the credential,
// and never the vault handle either, since a handle is a thing to keep off a
// surface a renderer can read.

export interface EmailAccountSummary {
  id: string;
  label: string;
  address: string;
  imapHost: string;
  smtpHost: string;
  username: string;
}

function summarise(record: EmailAccountRecord): EmailAccountSummary {
  return {
    id: record.id,
    label: record.label,
    address: record.address,
    imapHost: record.imapHost,
    smtpHost: record.smtpHost,
    username: record.username,
  };
}

/**
 * The server id a mailbox's tools are prefixed with.
 *
 * Per account, so a grant names which mailbox: `email-<id>.send`. One shared
 * `email` server would mean an agent allowed to answer support mail could also
 * send from any other address the workspace holds.
 */
export function serverIdForAccount(id: string): string {
  return `email-${id.slice(0, 8)}`;
}

export function listAccounts(): { accounts: EmailAccountSummary[] } {
  return { accounts: emailAccountsRepository.list(getStore()).map(summarise) };
}

export interface SaveAccountInput {
  id: string;
  label: string;
  address: string;
  preset: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
  /** The app password. Written to the vault and not kept. */
  password: string;
}

export function saveAccount(input: SaveAccountInput): { id: string } {
  const db = getStore();
  const existing = input.id === '' ? undefined : emailAccountsRepository.get(db, input.id);

  const preset = presetFor(input.preset);
  const imapHost = input.imapHost.trim() === '' ? (preset?.imapHost ?? '') : input.imapHost.trim();
  const smtpHost = input.smtpHost.trim() === '' ? (preset?.smtpHost ?? '') : input.smtpHost.trim();

  if (input.address.trim() === '' || !input.address.includes('@')) {
    throw new ValidationError('EMAIL_ADDRESS_INVALID', 'Give the full email address.', {});
  }
  if (imapHost === '' || smtpHost === '') {
    throw new ValidationError(
      'EMAIL_HOST_MISSING',
      'Choose a provider, or type the IMAP and SMTP host names.',
      {},
    );
  }
  if (input.password === '' && existing === undefined) {
    throw new ValidationError(
      'EMAIL_PASSWORD_MISSING',
      'An app password is needed. Your normal sign-in password will not work for IMAP.',
      {},
    );
  }

  // An unchanged password on an edit keeps the handle it already had, so
  // editing a label does not require typing a credential again.
  const authRef =
    input.password === '' && existing !== undefined
      ? (existing.authRef as AuthRef)
      : setSecret('connection', input.password);

  // The old secret is collected when it is replaced. Leaving it would be the
  // leak the E2E suite spent a day teaching us about.
  if (existing !== undefined && authRef !== existing.authRef) {
    try {
      deleteSecret(existing.authRef as AuthRef);
    } catch {
      // A handle that will not delete is not a reason to refuse the save.
    }
  }

  const saved = emailAccountsRepository.save(db, {
    id: existing?.id ?? (input.id === '' ? randomUUID() : input.id),
    label: input.label.trim() === '' ? input.address.trim() : input.label.trim(),
    address: input.address.trim(),
    imapHost,
    imapPort: input.imapPort,
    smtpHost,
    smtpPort: input.smtpPort,
    username: input.username.trim() === '' ? input.address.trim() : input.username.trim(),
    authRef,
  });

  return { id: saved.id };
}

export function removeAccount(id: string): { removed: boolean } {
  const db = getStore();
  const existing = emailAccountsRepository.get(db, id);
  if (!existing) return { removed: false };

  const removed = emailAccountsRepository.remove(db, id);
  if (removed) {
    try {
      deleteSecret(existing.authRef as AuthRef);
    } catch {
      // Best effort, as everywhere else: the account is gone either way.
    }
  }
  return { removed };
}

/** The account and its password, for opening a connection. Main process only. */
export function credentialsFor(id: string): {
  record: EmailAccountRecord;
  password: string;
} {
  const record = emailAccountsRepository.get(getStore(), id);
  if (!record) {
    throw new ValidationError('EMAIL_ACCOUNT_NOT_FOUND', `No mailbox with id "${id}".`, { id });
  }
  const password = getSecret(record.authRef as AuthRef);
  if (password === undefined) {
    throw new ValidationError(
      'EMAIL_PASSWORD_UNREADABLE',
      `The app password for "${record.label}" could not be read from the keychain. Save it again.`,
      { id },
    );
  }
  return { record, password };
}

/** Every mailbox password, so tool results can be scrubbed of them. */
export function emailSecrets(): string[] {
  const values: string[] = [];
  for (const record of emailAccountsRepository.list(getStore())) {
    try {
      const value = getSecret(record.authRef as AuthRef);
      if (value !== undefined && value !== '') values.push(value);
    } catch {
      // Unreadable is not leakable.
    }
  }
  return values;
}

/**
 * Opens the mailbox and reports whether it answered.
 *
 * The one thing worth doing before an agent is pointed at an account: an app
 * password that was mistyped, or a provider with IMAP switched off, otherwise
 * shows up as a failed run halfway through somebody's morning.
 */
export async function testAccount(id: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const { record, password } = credentialsFor(id);
    const { createMailTransport } = await import('./transport.ts');
    const messages = await createMailTransport(record, password).list('INBOX', 1);
    return {
      ok: true,
      detail:
        messages.length === 0
          ? 'Connected. The inbox is empty.'
          : `Connected. Most recent: "${messages[0]?.subject ?? ''}".`,
    };
  } catch (err) {
    // The provider's own words. "Invalid credentials" and "IMAP is disabled for
    // this account" are different problems with different fixes, and only the
    // server knows which one this is.
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
