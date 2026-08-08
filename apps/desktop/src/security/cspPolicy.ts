import type { Session } from 'electron';

// DECISION (docs/SECURITY.md section 7): M0 starting point, to be tightened
// (e.g. nonce-based script-src) once the real asset pipeline is in place.
// connect-src 'self' means the renderer has NO network egress of its own —
// every provider/tool call's egress happens in the main process, reached
// only through the Governor. This is a second, process-boundary enforcement
// of CLAUDE.md hard rule 1, independent of the Governor's own code checks.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function applyCsp(session: Session): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    });
  });
}
