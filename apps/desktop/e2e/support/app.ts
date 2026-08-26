import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Entry } from '@napi-rs/keyring';
import { vaultHandlesAt } from '@chimera/store';

export const desktopRoot = path.resolve(import.meta.dirname, '..', '..');
export const mainEntry = path.join(desktopRoot, 'dist', 'main.js');
export const fixturesDir = path.join(desktopRoot, 'e2e', 'fixtures');

/**
 * A throwaway `userData` directory for one test.
 *
 * Every launch below gets one. Two reasons, both load-bearing: the splash
 * plays once per profile (M0-8), so a shared profile would leave every test
 * after the first silently exercising the already-seen path; and without it
 * the suite writes into the developer's own application profile, so running
 * the tests changes the state of the app they use.
 */
export function freshProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-e2e-'));
}

/**
 * Removes a test workspace, keychain entries included.
 *
 * Deleting the directory was the whole of this, and the directory is not where
 * the secrets are: every connection and every plugin credential a test creates
 * goes to the real OS keychain and stayed there afterwards. One entry per
 * connection per run, never collected, across a suite that creates dozens and
 * is run many times a day.
 *
 * On this machine that reached 1,218 orphaned entries — 99% of everything in
 * the login keyring — at which point gnome-keyring, which rewrites and
 * re-encrypts the collection on every write, took longer than DBus's 25s reply
 * timeout to answer. The symptom was every provider-connecting test failing
 * with "Did not receive a reply", and the daemon burning eighteen hours of CPU.
 * The suite degraded the machine it ran on, a little more each run.
 *
 * Read the handles out of the workspace before the file goes, then delete each
 * one. Best-effort throughout: a handle that will not delete must not fail the
 * test that is already over.
 */
export function removeProfile(profile: string): void {
  try {
    purgeSecrets(path.join(profile, 'chimera.sqlite'));
  } catch {
    // A workspace with no database, or one already gone. Nothing to collect.
  }
  fs.rmSync(profile, { recursive: true, force: true });
}

function purgeSecrets(dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;

  for (const handle of vaultHandlesAt(dbPath)) {
    try {
      new Entry('chimera', handle).deletePassword();
    } catch {
      // Already gone, or a keychain that is not answering. Either way the test
      // is finished and this is not its problem.
    }
  }
}

export interface LaunchOptions {
  profile: string;
  /** Absolute path to an `e2e/fixtures` page to load instead of the renderer. */
  fixture?: string;
  /** Extra environment for the main process, e.g. an OmniRoute stub URL. */
  env?: Record<string, string>;
  /**
   * Plays the splash, as production does on every launch.
   *
   * Off by default for the suite: a test about connections should not spend
   * 2.3s watching an animation, and one of them was pushed past its timeout by
   * exactly that. `splash.spec.ts` turns it on, so the thing under test is the
   * real behaviour rather than a test-only path.
   */
  splash?: boolean;
}

export function launchApp({
  profile,
  fixture,
  env,
  splash = false,
}: LaunchOptions): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry, `--user-data-dir=${profile}`],
    cwd: desktopRoot,
    env: {
      ...process.env,
      CHIMERA_E2E_FIXTURE: fixture ?? '',
      ...(splash ? {} : { CHIMERA_E2E_NO_SPLASH: '1' }),
      ...env,
    },
  });
}

/**
 * Navigates to one of the shell's views.
 *
 * The app is an automation builder, so it opens on Home and the chat and
 * provider surfaces live behind sidebar entries. Tests take the same route a
 * person does rather than asserting against something that happens to be
 * mounted.
 */
/**
 * Puts a lot of text into a field, the way a paste does.
 *
 * `locator.fill` is quadratic in the length of the string against Electron over
 * CDP, and it is measuring itself rather than the app: at 5,000 characters it
 * takes 5.1 seconds and the renderer takes 213ms; at 20,000 it takes 45 seconds
 * and the renderer takes 195ms. A test that spends 45 seconds proving a React
 * textarea can hold 20,000 characters is timing Playwright.
 *
 * This is how a paste actually reaches a controlled React input — the native
 * value setter, then one `input` event — so the app sees exactly what it would
 * see from a person pressing Ctrl+V, and the test measures the app.
 */
export async function pasteInto(page: Page, testId: string, text: string): Promise<void> {
  const set = await page.evaluate(
    ({ id, value }) => {
      const field = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
        `[data-testid="${id}"]`,
      );
      if (!field) return false;
      const prototype =
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    { id: testId, value: text },
  );

  if (!set) throw new Error(`No element with data-testid="${testId}" to paste into`);
  // React has to have processed the event before the caller reads it back.
  await expect(page.getByTestId(testId)).not.toHaveValue('', { timeout: 10_000 });
}

export async function goTo(
  page: Page,
  view:
    | 'home'
    | 'build'
    | 'swarm'
    | 'runs'
    | 'agents'
    | 'apps'
    | 'notes'
    | 'memory'
    | 'providers'
    | 'chat',
): Promise<void> {
  await page.waitForSelector('[data-testid="app-shell"]');
  // The splash first, then setup. Both are full-screen overlays, and a nav
  // click made underneath either one is intercepted rather than delivered.
  await page.waitForSelector('.splash', { state: 'detached', timeout: 20_000 });
  await dismissOnboarding(page);
  await page.getByTestId(`nav-${view}`).click();
}

/**
 * Clears first-launch setup if it is showing.
 *
 * Every test starts on a fresh profile with no connections, which is exactly
 * the condition that triggers the guide — so a test that wants the app has to
 * get past it, the same way a person would. Tolerant of it being absent so the
 * helper stays usable from a test that has already connected something.
 */
export async function dismissOnboarding(page: Page): Promise<void> {
  const skip = page.getByTestId('intro-skip').first();
  // `count()` rather than a timed `waitFor`: absence is the normal case once a
  // test has connected something, and a five-second wait for an element that
  // is never coming, paid on every navigation, cost M1-11 twenty seconds of
  // its budget and made it fail under load. The guide mounts in the same React
  // commit that unmounts the splash, and `goTo` has already waited for that,
  // so there is no race left to wait out.
  if ((await skip.count()) > 0) await skip.click();

  await dismissTour(page);
}

/**
 * Clears the guided tour, which comes up behind the setup guide on a fresh
 * profile.
 *
 * Not optional politeness: the tour dims the app and takes clicks, so a test
 * that starts on a fresh profile and reaches for the sidebar finds its click
 * swallowed by a veil. `dismissOnboarding` calls this, so anything going
 * through `goTo` is already covered — it is exported for the tests that skip
 * the setup guide by hand and then interact with the app.
 *
 * Dismissed the way a person would rather than by writing the "seen" flag
 * behind the app's back, so it exercises the same path they take.
 */
export async function dismissTour(page: Page): Promise<void> {
  const tourSkip = page.getByTestId('tour-skip').first();
  if ((await tourSkip.count()) === 0) return;
  await tourSkip.click();
  await page.getByTestId('tour-skip-confirmed').click();
  await page.getByTestId('tour').waitFor({ state: 'detached', timeout: 10_000 });
}

/**
 * The canvas's own settle delay before it arranges itself, plus a margin.
 * Mirrors TIDY_SETTLE_MS in apps/ui/src/views/CanvasView.tsx.
 */
const CANVAS_SETTLE_MS = 600;

/**
 * Waits until the canvas has stopped rearranging itself.
 *
 * Drawing a line schedules a layout, which lands a moment later and moves the
 * steps into the order they run in. Measuring a handle before that and dropping
 * on it afterwards means dropping where the handle used to be — which is what a
 * person avoids without thinking, by waiting for the graph to settle before
 * reaching for the next port.
 */
export async function waitForCanvasStill(page: Page, timeoutMs = 3_000): Promise<void> {
  const positions = async (): Promise<string> =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.react-flow__node'))
        .map(
          (node) =>
            `${node.getAttribute('data-id') ?? ''}:${(node as HTMLElement).style.transform}`,
        )
        .join('|'),
    );

  // Only ever as long as the canvas's own settle delay needs; a graph that is
  // genuinely still answers on the second read, in a tenth of a second.
  const deadline = Date.now() + timeoutMs;
  let last = await positions();
  while (Date.now() < deadline) {
    await page.waitForTimeout(60);
    const now = await positions();
    if (now === last && now !== '') return;
    last = now;
  }
}

/**
 * Drags one React Flow handle onto another.
 *
 * `locator.dragTo` sends mousedown, one mousemove and mouseup. React Flow
 * builds a connection from a *sequence* of moves — it starts a connection line
 * on the first, tracks the pointer across the rest, and accepts a drop only
 * onto a handle it has seen the pointer over. One move sometimes satisfies that
 * and sometimes does not, which is why specs drawing three lines in a row lost
 * one of them in a loaded suite while passing on their own.
 *
 * Twice that was read as the canvas's own auto-layout moving the target
 * mid-drag, and twice something real but different was fixed. The tell was that
 * it kept happening afterwards, always on whichever spec drew the most lines.
 */
export async function dragHandle(page: Page, source: Locator, target: Locator): Promise<void> {
  await waitForCanvasStill(page);

  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('Cannot draw a join: a handle has no box');

  const centre = (box: { x: number; y: number; width: number; height: number }) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  const start = centre(from);
  const end = centre(to);

  // `hover` rather than a bare move to begin with: it waits for the handle to
  // be visible, stable and actually hittable, which a raw mouse.move does not,
  // and a connection started on an element that was still settling never
  // starts at all.
  await source.hover();
  await page.mouse.down();

  // Through the middle rather than straight to the end. React Flow builds a
  // connection from a sequence of moves — it opens a line on the first, follows
  // the pointer across the rest, and accepts a drop only onto a handle it has
  // seen the pointer arrive over. `locator.dragTo` sends one move, which
  // sometimes satisfies that and sometimes does not.
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 10 });
  await page.mouse.move(end.x, end.y, { steps: 10 });
  // Twice at the destination: the second is what marks the handle as the one
  // under the pointer when the button comes up.
  await page.mouse.move(end.x, end.y);
  await page.mouse.up();
}

/**
 * Joins two steps by their default ports, and waits for the line to exist.
 *
 * The wait is the point. Drawing a line re-renders the canvas, and a second
 * drag begun before that has committed measures handles that are about to
 * move. The symptom was one join in a sequence silently not landing — and the
 * tell was that adding a diagnostic between the joins made it pass, because
 * reading the edge count was itself the pause that had been missing.
 */
/**
 * Drags until a line exists, or gives up saying so.
 *
 * Drawing a line schedules a layout that moves the steps into the order they
 * run in, so the next join aims at a handle that may have just moved. Waiting
 * for the canvas to settle first helps and does not always suffice, because the
 * arrangement can begin between the measurement and the drop. Retrying is what
 * a person does when a drag does not take, and it makes these helpers mean "the
 * join exists afterwards" rather than "a drag was attempted".
 */
/**
 * Makes sure both ends of a join are actually on screen before dragging.
 *
 * A node the canvas has panned out of view is not reachable — for a person
 * either, which is the point: what they do is press fit-view and try again, and
 * so does this. Without it the drag aims at a handle whose coordinates are
 * behind the section header, and Playwright reports the header intercepting the
 * pointer, which reads like a styling bug and is not one.
 *
 * The canvas re-arranges itself on a timer after nodes are added, so whether a
 * handle is in view at the moment of measurement depends on how busy the app
 * was a second earlier. It got measurably worse when the shell grew three more
 * reads on mount, which is a timing change rather than a layout one.
 */
async function bringIntoView(page: Page, source: Locator, target: Locator): Promise<void> {
  const flow = page.locator('.react-flow');
  const visible = async (): Promise<boolean> => {
    const area = await flow.boundingBox();
    const boxes = await Promise.all([source.boundingBox(), target.boundingBox()]);
    if (area === null) return false;
    return boxes.every(
      (box) =>
        box !== null &&
        box.y >= area.y &&
        box.y + box.height <= area.y + area.height &&
        box.x >= area.x &&
        box.x + box.width <= area.x + area.width,
    );
  };

  if (await visible()) return;

  const fit = page.locator('.react-flow__controls-fitview');
  if ((await fit.count()) === 0) return;
  await fit.click();
  await waitForCanvasStill(page);
}

export async function joinHandles(
  page: Page,
  source: () => Locator,
  target: () => Locator,
  what: string,
): Promise<void> {
  const edges = page.locator('.react-flow__edge');
  const before = await edges.count();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await bringIntoView(page, source(), target());
    await dragHandle(page, source(), target());
    try {
      await expect(edges).toHaveCount(before + 1, { timeout: 2_000 });

      // Sit out the arrangement this line just scheduled.
      //
      // `waitForCanvasStill` can only see movement that has already begun; a
      // layout waiting on a timer looks exactly like a canvas at rest. So the
      // next join would measure a handle, the layout would fire, and the drop
      // would land where the handle used to be — which the retry above then
      // papered over, slowly. Waiting out the delay makes it not happen.
      await page.waitForTimeout(CANVAS_SETTLE_MS);
      await waitForCanvasStill(page);
      return;
    } catch {
      await waitForCanvasStill(page);
    }
  }

  await expect(edges, `${what} did not draw a line after three attempts`).toHaveCount(before + 1, {
    timeout: 2_000,
  });
}

export async function joinSteps(page: Page, fromTestId: string, toTestId: string): Promise<void> {
  await joinHandles(
    page,
    () => page.locator(`[data-testid="${fromTestId}"] .react-flow__handle-right`),
    () => page.locator(`[data-testid="${toTestId}"] .react-flow__handle-left`),
    `joining ${fromTestId} to ${toTestId}`,
  );
}

/**
 * Joins several steps of the same kind into one target, top to bottom.
 *
 * Every step of one role carries the same test id, so `.nth(i)` is DOM order —
 * and clicking a node moves it in the DOM, which meant a loop of four joins
 * connected one node twice and another not at all. React Flow drops the
 * duplicate, so four drags produced three edges and the rule under test never
 * tripped.
 *
 * Their vertical order is stable in a way DOM order is not, so that is what
 * identifies them.
 */
export async function joinAllInto(
  page: Page,
  sourceTestId: string,
  toTestId: string,
): Promise<void> {
  const handles = page.locator(`[data-testid^="${sourceTestId}"] .react-flow__handle-right`);
  const count = await handles.count();

  const ordered: { index: number; y: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const box = await handles.nth(index).boundingBox();
    ordered.push({ index, y: box?.y ?? 0 });
  }
  ordered.sort((a, b) => a.y - b.y);

  const target = page.locator(`[data-testid="${toTestId}"] .react-flow__handle-left`);
  for (const { y } of ordered) {
    // Re-found by position each time: a join can move what is on the canvas,
    // and an index captured before the first drag would not survive it.
    const fresh = page.locator(`[data-testid^="${sourceTestId}"] .react-flow__handle-right`);
    const total = await fresh.count();
    let pick = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let index = 0; index < total; index += 1) {
      const box = await fresh.nth(index).boundingBox();
      const distance = Math.abs((box?.y ?? 0) - y);
      if (distance < best) {
        best = distance;
        pick = index;
      }
    }
    await joinHandles(
      page,
      () => fresh.nth(pick),
      () => target,
      `joining a ${sourceTestId} to ${toTestId}`,
    );
  }
}
