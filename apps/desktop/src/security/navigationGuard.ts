import type { BrowserWindow } from 'electron';

// DECISION (docs/SECURITY.md section 7): allow only the app's own packaged
// origin — file:// for the built renderer — inside any BrowserWindow. There
// is deliberately no dev-server origin to allow: M0-8 built the renderer as a
// static bundle loaded over file:// rather than standing up a Vite dev server,
// so development and production load the renderer by exactly the same path and
// this allowlist has no environment-dependent entry to get wrong. Anything else — including a provider's OAuth login page —
// must go through shell.openExternal to the user's default OS browser,
// never navigated to in-app: an in-app window navigating to a real login
// page is indistinguishable, from the user's perspective, from CHIMERA
// phishing that same page inside its own chrome. That decision belongs to
// the calling code that initiates an OAuth flow, not to this guard — this
// guard's job is only to deny, log, and stop there.
const ALLOWED_ORIGINS = new Set<string>([]);

function isAllowed(targetUrl: string): boolean {
  try {
    const target = new URL(targetUrl);
    if (target.protocol === 'file:') return true;
    return ALLOWED_ORIGINS.has(target.origin);
  } catch {
    return false;
  }
}

export function applyNavigationGuard(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url)) {
      return { action: 'allow' };
    }
    console.warn(`[security] blocked window.open to non-allowlisted origin: ${url}`);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) {
      console.warn(`[security] blocked in-window navigation to non-allowlisted origin: ${url}`);
      event.preventDefault();
    }
  });
}
