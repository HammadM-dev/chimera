// Opening a link in the user's own browser.
//
// The renderer cannot do this and must not be able to. `applyNavigationGuard`
// denies `window.open` to everything but the app's own `file://` origin, for
// the reason written there: a login page rendered inside CHIMERA's own chrome
// is indistinguishable, to the person looking at it, from CHIMERA phishing that
// page. So the only way out of the app is the operating system's browser, and
// the only thing that can reach `shell.openExternal` is the main process.
//
// That guard is also why the Composio Connect button did nothing. The renderer
// called `window.open` with Composio's sign-in URL, the guard denied it exactly
// as designed, logged a line into a console nobody has open, and the button sat
// on "Opening" for good. The guard was right; the caller was in the wrong
// process.
//
// An allowlist rather than "https is fine". Every URL that reaches here came
// out of an API response body, which is to say out of somewhere this build does
// not control, and "open the user's browser at a URL of the server's choosing"
// is a capability worth naming the destinations of.

/**
 * Hosts CHIMERA will send somebody's browser to.
 *
 * `connect.composio.dev` is where Composio's `authorize` redirects land —
 * verified against the live API, 2026-08-25: every toolkit answers with
 * `https://connect.composio.dev/link/<id>`. Composio's own onward redirect to
 * Google or Slack happens in the browser, where it belongs, and is no longer
 * anything this process has a say in.
 */
const ALLOWED_HOSTS = new Set([
  // Where `authorize` redirects land.
  'connect.composio.dev',
  // Signing up, and the dashboard the sign-up lands on. `app.composio.dev` and
  // `platform.composio.dev` both redirect to `dashboard.composio.dev`; all
  // three are listed because a redirect is followed by the browser, not by
  // this process, and which one a link points at changes with their marketing.
  'composio.dev',
  'app.composio.dev',
  'platform.composio.dev',
  'dashboard.composio.dev',
  // One page per app: `docs.composio.dev/toolkits/<slug>`. Checked live —
  // gmail, notion, slack and hubspot all answer 200, and a slug that does not
  // exist answers 404 rather than redirecting somewhere unexpected.
  'docs.composio.dev',
]);

export interface OpenResult {
  opened: boolean;
  /** Why not, in words a person can act on. Empty when it opened. */
  reason: string;
}

/** True when this is somewhere we are prepared to send a browser. */
export function isOpenable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname);
}

export async function openExternal(url: string): Promise<OpenResult> {
  if (!isOpenable(url)) {
    return {
      opened: false,
      reason: `CHIMERA will not open ${url} — it only opens links to sites it knows.`,
    };
  }
  try {
    // Imported here rather than at the top of the file. `electron` is a
    // CommonJS module with no named exports, so a static `import { shell }`
    // fails to instantiate under Node's ESM loader — which is what runs the
    // unit tests, and which took the whole IPC registry suite down with it.
    // Nothing above this line needs Electron, so nothing above it loads it.
    const { shell } = await import('electron');
    await shell.openExternal(url);
    return { opened: true, reason: '' };
  } catch (err) {
    // A machine with no browser association, or a desktop portal that refused.
    // Worth saying rather than swallowing: the user can still paste the URL.
    return { opened: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
