// Removing a known secret from a string, wherever that string is headed.
//
// This lives in the leaf package because four others need it and none of them
// may depend on each other: `providers` scrubs a provider's echoed request out
// of an error body, `tools` scrubs a plugin's own credential out of whatever
// that plugin returned, `core` scrubs a trace payload before it is written, and
// the desktop scrubs an IPC log line. One implementation, so a gap fixed in one
// place is not still open in the other three.
//
// It is a value blocklist, deliberately: it can only remove secrets it is told
// about. That is a weaker guarantee than never holding the value at all, which
// is why it is the last line rather than the first — capability limits and the
// vault come first, and this catches what leaks past them.

/**
 * Replaces every occurrence of every secret with `[redacted]`.
 *
 * The percent-encoded form goes too, because a credential that reached a URL
 * arrives encoded and would otherwise pass a plain substring check.
 *
 * Secrets shorter than four characters are ignored: a one- or two-character
 * "secret" matches everywhere and would redact the text into uselessness,
 * which is its own kind of failure when the text is a run trace somebody is
 * trying to read.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    scrubbed = scrubbed.split(secret).join('[redacted]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) scrubbed = scrubbed.split(encoded).join('[redacted]');
  }
  return scrubbed;
}
