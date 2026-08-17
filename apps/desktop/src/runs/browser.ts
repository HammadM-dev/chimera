import path from 'node:path';
import { createBrowserProfileManager, type BrowserProfileManager } from '@chimera/control';
import type { BrowserPage } from '@chimera/tools';

// The main process's browser: one profile manager for the app, one profile per
// workspace, and a lazy launch.
//
// Lazy because most automations never touch a browser, and starting Chromium
// for a run that only reads files would cost every user a second and 200MB for
// nothing. The first `browser.*` call in a run is what starts it.

let root = '';
let manager: BrowserProfileManager | undefined;

export function setBrowserRoot(userData: string): void {
  root = userData;
}

function browsers(): BrowserProfileManager {
  manager ??= createBrowserProfileManager({
    root: path.join(root),
    // Headless by default. A visible window is the right default for
    // supervision and the wrong one for a machine that is also being used —
    // M8's supervision surface is where that choice belongs, not here.
    headless: true,
  });
  return manager;
}

/**
 * The page a run acts on.
 *
 * Keyed by workspace rather than by run: a run should inherit the session a
 * previous run logged in with, the same way a person does not log in again for
 * every task. Runs do not overlap on it, because a browser page is a single
 * thing and two runs driving one is a race the user would watch happen.
 */
export function pageForWorkspace(workspaceId = 'default'): () => Promise<BrowserPage> {
  return async () => {
    const session = await browsers().getOrCreate(workspaceId);
    // The one cast in this boundary, and the reason the boundary exists.
    // `BrowserPage` is the slice of a page the tool server uses, declared in
    // `packages/tools` so that package needs no browser dependency at all.
    // Playwright's own `Page` satisfies it in every respect a call cares about;
    // it does not satisfy it *structurally*, because `page.route` is declared
    // as a property rather than a method and its parameter types are therefore
    // checked contravariantly against ours. Asserting here — where both types
    // are in scope and the mismatch is understood — beats loosening the
    // interface everywhere else to accommodate one signature.
    return session.page as unknown as BrowserPage;
  };
}

export async function closeBrowsers(): Promise<void> {
  await manager?.closeAll();
  manager = undefined;
}
