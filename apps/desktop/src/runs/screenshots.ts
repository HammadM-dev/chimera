import fs from 'node:fs/promises';
import path from 'node:path';
import { ChimeraError } from '@chimera/errors';

// M6-4. Where a browser screenshot goes, and how it gets back to the trace
// viewer.
//
// To a file, not into the trace row: a PNG is hundreds of kilobytes, the trace
// is read whole every time the viewer opens a run, and a base64 image in an
// agent's observation would be tens of thousands of tokens of noise in the next
// prompt. The trace holds the name; this holds the picture.

let rootDir = '';

/** Called once at startup with the app's `userData` directory. */
export function setScreenshotRoot(root: string): void {
  rootDir = path.join(root, 'run-screenshots');
}

function dirFor(runId: string): string {
  if (rootDir === '') throw new ChimeraError('SCREENSHOTS_NOT_READY', 'No screenshot root.', {});
  // The run id is a UUID we generated, but this is joined and then written to,
  // so it is constrained rather than trusted.
  const safe = runId.replace(/[^a-zA-Z0-9-]/g, '');
  if (safe === '') throw new ChimeraError('SCREENSHOTS_NOT_READY', 'No run to save under.', {});
  return path.join(rootDir, safe);
}

/** Writes one screenshot and returns the name the trace will carry. */
export function screenshotSinkFor(runId: string): (png: Buffer) => Promise<string> {
  let count = 0;
  return async (png: Buffer) => {
    count += 1;
    const name = `${String(count).padStart(3, '0')}.png`;
    const dir = dirFor(runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), png);
    return name;
  };
}

/**
 * Reads one back, as a data URL.
 *
 * Name-constrained rather than path-joined from whatever was asked for: this is
 * reachable from the renderer, and a channel that read an arbitrary path would
 * be a file-read primitive with a picture's name on it.
 */
export async function readScreenshot(runId: string, name: string): Promise<{ dataUrl: string }> {
  if (!/^\d{3}\.png$/.test(name)) return { dataUrl: '' };
  try {
    const png = await fs.readFile(path.join(dirFor(runId), name));
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}` };
  } catch {
    // A screenshot that is not there is not an error worth taking a view down
    // for — the trace still says one was taken, and the viewer shows that.
    return { dataUrl: '' };
  }
}
