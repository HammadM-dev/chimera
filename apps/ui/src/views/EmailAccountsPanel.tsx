import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import { HowTo, Step, Steps } from './HowTo.tsx';

// Mailboxes an agent can be given.
//
// The app-password point is made where it will be read — next to the field —
// rather than in a help page, because it is the one thing that goes wrong for
// nearly everybody: neither Gmail nor Outlook accepts the password you sign in
// with, and the error they return for it says "invalid credentials", which
// sends people to check the thing that is not wrong.

interface Account {
  id: string;
  label: string;
  address: string;
  imapHost: string;
  smtpHost: string;
  username: string;
}

const PRESETS = [
  {
    id: 'gmail',
    label: 'Gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    note: 'Gmail needs an app password, not your normal one. Turn on 2-step verification, then create one under Google Account, Security, App passwords.',
  },
  {
    id: 'outlook',
    label: 'Outlook or Microsoft 365',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    note: 'Needs an app password, and many work accounts have IMAP switched off by an administrator. If the password is right and sign-in still fails, that is usually why.',
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    note: 'iCloud requires an app-specific password from appleid.apple.com.',
  },
  {
    id: 'custom',
    label: 'Another provider',
    imapHost: '',
    imapPort: 993,
    smtpHost: '',
    smtpPort: 587,
    note: 'Your provider publishes these, usually imap. and smtp. followed by your domain.',
  },
] as const;

export function EmailAccountsPanel(): JSX.Element {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [adding, setAdding] = useState(false);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>(PRESETS[0]);
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await bridge().invoke<{ accounts: Account[] }>('email:accounts', {});
      setAccounts(result.accounts);
    } catch (err) {
      setNote(describeError(err).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="panel" data-testid="email-accounts">
      <h3 className="panel__title">Mailboxes</h3>
      <p className="agent-card__prompt">
        An agent can be given one of these to read and answer. Sending always stops for your
        approval first — a sent message cannot be taken back.
      </p>

      {accounts.length === 0 && !adding && (
        <p className="agent-card__prompt" data-testid="email-empty">
          No mailboxes yet.
        </p>
      )}

      {accounts.map((account) => (
        <div key={account.id} className="connection-row" data-testid={`email-${account.id}`}>
          <span>{account.address}</span>
          <span className="connection-row__meta">{account.imapHost}</span>
          <div className="brief__left">
            <button
              type="button"
              className="button button--quiet"
              data-testid="email-test"
              onClick={() => {
                void (async () => {
                  setNote('Checking…');
                  const result = await bridge().invoke<{ ok: boolean; detail: string }>(
                    'email:test',
                    { id: account.id },
                  );
                  setNote(result.detail);
                })();
              }}
            >
              Check
            </button>
            <button
              type="button"
              className="button button--quiet"
              data-testid="email-remove"
              onClick={() => {
                void (async () => {
                  await bridge().invoke('email:remove', { id: account.id });
                  await refresh();
                })();
              }}
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      {adding && (
        <div data-testid="email-form">
          <div className="field">
            <label className="field__label" htmlFor="email-preset">
              Provider
            </label>
            <select
              id="email-preset"
              className="control"
              data-testid="email-preset"
              value={preset.id}
              onChange={(event) => {
                const chosen = PRESETS.find((one) => one.id === event.target.value) ?? PRESETS[0];
                setPreset(chosen);
                setImapHost(chosen.imapHost);
                setSmtpHost(chosen.smtpHost);
              }}
            >
              {PRESETS.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="email-address">
              Email address
            </label>
            <input
              id="email-address"
              className="control"
              data-testid="email-address"
              value={address}
              placeholder="you@yourbusiness.com"
              onChange={(event) => {
                setAddress(event.target.value);
              }}
            />
          </div>

          {preset.id === 'custom' && (
            <>
              <div className="field">
                <label className="field__label" htmlFor="email-imap">
                  IMAP host
                </label>
                <input
                  id="email-imap"
                  className="control"
                  data-testid="email-imap"
                  value={imapHost}
                  onChange={(event) => {
                    setImapHost(event.target.value);
                  }}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="email-smtp">
                  SMTP host
                </label>
                <input
                  id="email-smtp"
                  className="control"
                  data-testid="email-smtp"
                  value={smtpHost}
                  onChange={(event) => {
                    setSmtpHost(event.target.value);
                  }}
                />
              </div>
            </>
          )}

          <div className="field">
            <label className="field__label" htmlFor="email-password">
              App password
            </label>
            <input
              id="email-password"
              className="control"
              type="password"
              data-testid="email-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
            <span className="agent-editor__toolNote">{preset.note}</span>

            <HowTo label="Not sure how? Show me the steps">
              {preset.id === 'gmail' && (
                <Steps>
                  <Step>
                    Go to <strong>myaccount.google.com</strong> and open <strong>Security</strong>.
                  </Step>
                  <Step>
                    Turn on <strong>2-Step Verification</strong> if it is off. Google will not offer
                    app passwords until it is on.
                  </Step>
                  <Step>
                    Back in Security, open <strong>App passwords</strong>. If you cannot see it,
                    search &quot;app passwords&quot; in the search box at the top.
                  </Step>
                  <Step>
                    Give it a name — <strong>CHIMERA</strong> — and create it. Google shows a
                    16-character password once. Copy it.
                  </Step>
                  <Step>
                    Paste it above. Not your normal Google password: that one will always be
                    refused.
                  </Step>
                  <Step>
                    In Gmail, open <strong>Settings</strong>, then{' '}
                    <strong>Forwarding and POP/IMAP</strong>, and make sure{' '}
                    <strong>IMAP is enabled</strong>.
                  </Step>
                </Steps>
              )}

              {preset.id === 'outlook' && (
                <Steps>
                  <Step>
                    Go to <strong>account.microsoft.com/security</strong>.
                  </Step>
                  <Step>
                    Turn on <strong>two-step verification</strong>, then open{' '}
                    <strong>Advanced security options</strong>.
                  </Step>
                  <Step>
                    Under <strong>App passwords</strong>, create one and copy it.
                  </Step>
                  <Step>Paste it above, in place of your normal password.</Step>
                  <Step>
                    If sign-in still fails on a <strong>work or school account</strong>, IMAP is
                    almost certainly switched off by your administrator. Ask them to enable IMAP for
                    your mailbox — nothing here can turn it on for you.
                  </Step>
                </Steps>
              )}

              {preset.id === 'icloud' && (
                <Steps>
                  <Step>
                    Sign in at <strong>appleid.apple.com</strong>.
                  </Step>
                  <Step>
                    Under <strong>Sign-In and Security</strong>, choose{' '}
                    <strong>App-Specific Passwords</strong>.
                  </Step>
                  <Step>Create one, name it CHIMERA, and copy it.</Step>
                  <Step>Paste it above.</Step>
                </Steps>
              )}

              {preset.id === 'custom' && (
                <Steps>
                  <Step>
                    Find your provider&apos;s <strong>IMAP</strong> and <strong>SMTP</strong> host
                    names. They are usually in a help page called &quot;email settings&quot; or
                    &quot;set up your email in another app&quot;, and are usually{' '}
                    <code>imap.yourdomain.com</code> and <code>smtp.yourdomain.com</code>.
                  </Step>
                  <Step>
                    Put them in the two fields above. The ports CHIMERA uses are <code>993</code>{' '}
                    for IMAP and <code>587</code> for SMTP, which is what almost every provider
                    expects.
                  </Step>
                  <Step>
                    Use your mailbox password, unless your provider issues separate{' '}
                    <strong>app passwords</strong> — if it does, use one of those.
                  </Step>
                  <Step>
                    Add the mailbox, then press <strong>Check</strong>. If something is wrong the
                    server&apos;s own words appear, and they are usually specific enough to act on.
                  </Step>
                </Steps>
              )}
            </HowTo>
          </div>

          <div className="brief__left">
            <button
              type="button"
              className="button button--primary"
              data-testid="email-save"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  setNote('');
                  try {
                    await bridge().invoke('email:save', {
                      id: '',
                      label: address,
                      address,
                      preset: preset.id,
                      imapHost: imapHost === '' ? preset.imapHost : imapHost,
                      imapPort: preset.imapPort,
                      smtpHost: smtpHost === '' ? preset.smtpHost : smtpHost,
                      smtpPort: preset.smtpPort,
                      username: address,
                      password,
                    });
                    setPassword('');
                    setAddress('');
                    setAdding(false);
                    await refresh();
                  } catch (err) {
                    setNote(describeError(err).message);
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Add mailbox
            </button>
            <button
              type="button"
              className="button"
              data-testid="email-cancel"
              onClick={() => {
                setAdding(false);
                setPassword('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!adding && (
        <button
          type="button"
          className="button"
          data-testid="email-add"
          onClick={() => {
            setAdding(true);
            setImapHost(preset.imapHost);
            setSmtpHost(preset.smtpHost);
          }}
        >
          Add a mailbox
        </button>
      )}

      {note !== '' && (
        <p className="connections__error" data-testid="email-note" role="alert">
          {note}
        </p>
      )}
    </div>
  );
}
