import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { ChimeraError } from '@chimera/errors';
import { ensureBrowser } from './ensureBrowser.ts';

// M6-1. One browser profile per workspace, kept apart from every other profile
// on the machine — including, emphatically, the user's own.
//
// The master plan's constraint is "never drive the user's personal profile with
// its live sessions", and it is not a preference. An agent driving a browser
// that is already logged into the user's bank, email and admin consoles has
// every one of those sessions available to it, and a prompt injection on any
// page it visits is then a prompt injection with the user's credentials
// attached. A profile of our own starts logged out of everything.

export interface BrowserSession {
  workspaceId: string;
  context: BrowserContext;
  /** The page agents act on. One per workspace: a swarm of tabs is M8's problem. */
  page: Page;
  profileDir: string;
}

export interface ProfileManagerOptions {
  /** Where profiles live. The desktop app passes its `userData` directory. */
  root: string;
  /** Off for real use; on for a developer watching what an agent does. */
  headless?: boolean;
  /**
   * Told what the one-time browser download is doing.
   *
   * A first browser run on a fresh install fetches ~150MB. Without this the
   * app sits there saying nothing for several minutes, which reads as a hang.
   */
  onProgress?: (line: string) => void;
}

export interface BrowserProfileManager {
  getOrCreate: (workspaceId: string) => Promise<BrowserSession>;
  /** The session for a workspace, if one is open. Never launches. */
  peek: (workspaceId: string) => BrowserSession | undefined;
  close: (workspaceId: string) => Promise<void>;
  closeAll: () => Promise<void>;
  profileDirFor: (workspaceId: string) => string;
}

/**
 * Keeps a workspace id from escaping its directory.
 *
 * Workspace ids are ours, not a user's, but this path is joined and then
 * written to — and "it cannot contain a slash today" is exactly the assumption
 * that a later feature quietly breaks.
 */
function safeSegment(workspaceId: string): string {
  const cleaned = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '-');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    throw new ChimeraError('BROWSER_PROFILE_INVALID', `"${workspaceId}" is not a usable id.`, {
      workspaceId,
    });
  }
  return cleaned;
}

export function createBrowserProfileManager(options: ProfileManagerOptions): BrowserProfileManager {
  const sessions = new Map<string, BrowserSession>();
  const opening = new Map<string, Promise<BrowserSession>>();

  const profileDirFor = (workspaceId: string): string =>
    path.join(options.root, 'browser-profiles', safeSegment(workspaceId));

  const onProgress = options.onProgress;

  const launch = async (workspaceId: string): Promise<BrowserSession> => {
    const profileDir = profileDirFor(workspaceId);
    fs.mkdirSync(profileDir, { recursive: true });

    // Imported here rather than at the top of the file, and the reason is not
    // startup time.
    //
    // Playwright is external to the main bundle — it reaches for a browser it
    // locates relative to its own package and cannot be inlined — so the
    // packaged app resolves it from node_modules at runtime. A static import
    // makes that resolution happen while the main process is still starting,
    // which turned one missing dependency into "A JavaScript error occurred in
    // the main process" before a window ever opened. The whole app was
    // unusable because of a feature most runs never touch.
    //
    // Loaded at the point of use, a packaging mistake costs the browser tool
    // and nothing else, and says so in a sentence a person can act on.

    // Before the import, because Playwright reads this variable as it loads.
    const browsers = await ensureBrowser({
      root: options.root,
      ...(onProgress ? { onProgress } : {}),
    });
    process.env['PLAYWRIGHT_BROWSERS_PATH'] = browsers;

    let chromium: typeof import('playwright').chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch (err) {
      throw new ChimeraError(
        'BROWSER_LAUNCH_FAILED',
        'This build cannot drive a browser: its browser engine is missing. Reinstall CHIMERA, ' +
          'or run the automation without the browser tool.',
        { workspaceId, cause: err instanceof Error ? err.message : String(err) },
      );
    }

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: options.headless ?? true,
        // No downloads: a browser that can write anywhere on disk is a
        // filesystem tool wearing a browser's clothes, and the filesystem tool
        // is the one with a sandbox.
        acceptDownloads: false,
      });
    } catch (err) {
      throw new ChimeraError(
        'BROWSER_LAUNCH_FAILED',
        // The commonest cause by far, said first: the browser was never
        // downloaded. Everything else is a machine-specific problem the
        // underlying message describes better than we can.
        `Could not start the browser. If this is a fresh install, its browser has not been downloaded yet. ${
          err instanceof Error ? err.message : String(err)
        }`,
        { workspaceId },
      );
    }

    const page = context.pages()[0] ?? (await context.newPage());
    const session: BrowserSession = { workspaceId, context, page, profileDir };
    sessions.set(workspaceId, session);

    // A window the user closed is not a session we still hold.
    context.on('close', () => {
      sessions.delete(workspaceId);
    });

    return session;
  };

  return {
    profileDirFor,

    peek(workspaceId) {
      return sessions.get(workspaceId);
    },

    async getOrCreate(workspaceId) {
      const existing = sessions.get(workspaceId);
      if (existing) return existing;

      // Two steps asking at once get one browser, not two. Without this a
      // fan-out's first parallel items each launch their own, and the second
      // launch on the same profile directory fails — Chromium holds a lock on
      // it, correctly.
      const inFlight = opening.get(workspaceId);
      if (inFlight) return inFlight;

      const promise = launch(workspaceId).finally(() => {
        opening.delete(workspaceId);
      });
      opening.set(workspaceId, promise);
      return promise;
    },

    async close(workspaceId) {
      const session = sessions.get(workspaceId);
      sessions.delete(workspaceId);
      await session?.context.close();
    },

    async closeAll() {
      const open = [...sessions.values()];
      sessions.clear();
      // Settled, not all: one context that will not close must not leave the
      // others running. An orphaned headless browser is invisible and immortal.
      await Promise.allSettled(open.map((session) => session.context.close()));
    },
  };
}
