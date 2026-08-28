import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ChimeraError } from '@chimera/errors';

// Getting a browser onto the user's machine.
//
// Playwright's npm package deliberately contains no browser: `npx playwright
// install` fetches one afterwards, into a cache in the developer's home
// directory. That is fine on a development machine and wrong everywhere else —
// somebody who installs CHIMERA has never run that command, so every browser
// automation failed on a fresh machine with "its browser has not been
// downloaded yet" and no way to act on it.
//
// So the app fetches it, once, into its own data directory. Not into
// `~/.cache/ms-playwright`: that is Playwright's own cache and shared with
// whatever else on the machine uses Playwright, and an application that
// installs a 150MB browser into a shared location it does not own is an
// application that is difficult to uninstall.

/** Where the download goes, and where Playwright is told to look. */
export function browsersRoot(appDataRoot: string): string {
  return path.join(appDataRoot, 'browsers');
}

/**
 * True when a chromium build already exists under `root`.
 *
 * Deliberately a directory check rather than a launch attempt: this runs
 * before every browser session, and starting a browser to find out whether a
 * browser can start is a second or two on every automation.
 */
export function browserPresent(root: string): boolean {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && entry.name.startsWith('chromium'));
  } catch {
    return false;
  }
}

/** Where Playwright's own CLI lives, on disk rather than inside the asar. */
function locateCli(): string {
  // `createRequire` rather than a path relative to this file: in the packaged
  // app this module is a line in a bundle and has no meaningful directory of
  // its own, while the resolver knows where the real package was unpacked to.
  const require = createRequire(import.meta.url);
  const entry = require.resolve('playwright/package.json');
  const dir = path.dirname(entry);

  // electron-builder unpacks playwright out of the archive (see asarUnpack in
  // electron-builder.yml) because a script inside an asar cannot be spawned —
  // the archive is not a real directory to the operating system. If the
  // resolver still hands back a path inside one, say that plainly rather than
  // letting `spawn` fail with ENOENT on a path that appears to exist.
  if (dir.includes('app.asar' + path.sep)) {
    throw new ChimeraError(
      'BROWSER_LAUNCH_FAILED',
      'This build cannot install its browser: the browser engine was packed into the ' +
        'application archive instead of beside it.',
      { dir },
    );
  }

  return path.join(dir, 'cli.js');
}

export interface EnsureBrowserOptions {
  /** The app's data directory. The download lands under it. */
  root: string;
  /** Told how far along the download is, so a five-minute wait is not silent. */
  onProgress?: (line: string) => void;
  /** Injected by tests. */
  spawnInstall?: (cli: string, env: NodeJS.ProcessEnv) => Promise<void>;
}

/**
 * Makes sure a browser exists, downloading it once if it does not.
 *
 * Returns the directory to point `PLAYWRIGHT_BROWSERS_PATH` at.
 */
export async function ensureBrowser(options: EnsureBrowserOptions): Promise<string> {
  const root = browsersRoot(options.root);
  fs.mkdirSync(root, { recursive: true });

  if (browserPresent(root)) return root;

  options.onProgress?.('Downloading the browser CHIMERA drives. This happens once.');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: root,
    // The Electron binary is the Node this app has. Without this it would try
    // to open the CLI script as an application — the same trap the document
    // reader's worker fell into.
    ELECTRON_RUN_AS_NODE: '1',
  };

  const cli = locateCli();

  // One path out, so the check below cannot be skipped. Returning early on the
  // injected branch meant the test double took a route production does not,
  // and the "did it actually arrive" check was the part it skipped — which is
  // the half worth testing.
  const install = options.spawnInstall
    ? options.spawnInstall(cli, env)
    : new Promise<void>((resolve, reject) => {
        // `--with-deps` is deliberately not passed: it runs a package manager
        // under sudo, and an app that asks for the root password because
        // somebody pressed run is not a thing we are going to ship.
        const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const say = (chunk: Buffer): void => {
          const line = chunk.toString().trim();
          if (line !== '') options.onProgress?.(line);
        };
        child.stdout.on('data', say);
        child.stderr.on('data', say);

        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`the browser download exited with code ${String(code)}`));
        });
      });

  await install;

  if (!browserPresent(root)) {
    throw new ChimeraError(
      'BROWSER_LAUNCH_FAILED',
      'The browser download finished but no browser was found afterwards.',
      { root },
    );
  }

  return root;
}
