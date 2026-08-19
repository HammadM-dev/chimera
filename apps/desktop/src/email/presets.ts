// Where the common providers keep their mailboxes.
//
// Presets fill in four fields somebody would otherwise have to look up, and
// nothing more: the account is still IMAP and SMTP underneath, so anything not
// listed here works by typing the hosts in.
//
// Both of the big two require an app password rather than the password used to
// sign in, because both disabled plain password access for IMAP. That is the
// single most likely thing to go wrong in setting one of these up, so the note
// travels with the preset rather than living in a help page.

export interface MailPreset {
  id: string;
  label: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  note: string;
}

export const MAIL_PRESETS: readonly MailPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    note: 'Gmail needs an app password, not your normal one. Turn on 2-step verification, then create one under Google Account, Security, App passwords. IMAP also has to be on in Gmail settings.',
  },
  {
    id: 'outlook',
    label: 'Outlook or Microsoft 365',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    note: 'Needs an app password, and many work accounts have IMAP switched off by their administrator. If sign-in fails with the right password, that is usually why.',
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    note: 'iCloud requires an app-specific password, created at appleid.apple.com.',
  },
  {
    id: 'custom',
    label: 'Another provider',
    imapHost: '',
    imapPort: 993,
    smtpHost: '',
    smtpPort: 587,
    note: 'Your provider will publish its IMAP and SMTP host names, usually imap. and smtp. followed by your domain.',
  },
];

export function presetFor(id: string): MailPreset | undefined {
  return MAIL_PRESETS.find((preset) => preset.id === id);
}
