import { cancelEveryRun } from '../runs/service.ts';
import { closeBrowsers } from '../runs/browser.ts';

// M8-3. Who said the machine could be driven, what shows while it is, and the
// key that stops everything.
//
// Native control is the one capability where "the agent did something I did not
// expect" means a mouse moving on the user's own desktop. So it is granted for
// a session rather than configured once, it is visible the whole time it is
// held, and there is a key that ends it from anywhere — including when the app
// does not have focus, which is exactly when it matters.

export interface ControlSession {
  granted: boolean;
  /** What the grant covers, in the user's words, for the indicator. */
  reason: string;
  grantedAt: string;
  /**
   * Actions are described but never performed.
   *
   * F6.0's dry run: an ops manager can watch what an agent *would* do to their
   * desktop before anything touches it, which is the only honest way to earn
   * the grant in the first place.
   */
  dryRun: boolean;
}

const REVOKED: ControlSession = { granted: false, reason: '', grantedAt: '', dryRun: true };
let session: ControlSession = REVOKED;

type Listener = (session: ControlSession) => void;
const listeners = new Set<Listener>();

function announce(): void {
  for (const listener of listeners) listener(session);
}

export function onControlSessionChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function controlSession(): ControlSession {
  return session;
}

/**
 * Grants native control for this session.
 *
 * "This session" is deliberate: the grant does not survive a restart, and is
 * not a setting. A permission that persists is a permission nobody remembers
 * giving.
 */
export function grantControl(input: { reason: string; dryRun: boolean }): ControlSession {
  session = {
    granted: true,
    reason: input.reason.trim() === '' ? 'Native control' : input.reason.trim(),
    grantedAt: new Date().toISOString(),
    dryRun: input.dryRun,
  };
  announce();
  return session;
}

export function revokeControl(): ControlSession {
  session = REVOKED;
  announce();
  return session;
}

export interface PanicResult {
  cancelledRuns: number;
  controlRevoked: boolean;
}

/**
 * Stops everything, now.
 *
 * Every run is cancelled, the browser is closed, and the control grant is
 * revoked. Deliberately not "pause": somebody reaching for this is not asking
 * for a considered wind-down, and a stop that leaves one agent finishing its
 * turn is not the thing they pressed.
 *
 * It works whether or not native control was ever granted. A browser agent
 * filling in the wrong form is exactly as urgent as a mouse moving on its own,
 * and a panic key that only covered one of them would be a panic key people
 * learn not to trust.
 */
export function panic(): PanicResult {
  const cancelledRuns = cancelEveryRun();
  const wasGranted = session.granted;
  revokeControl();
  void closeBrowsers();
  return { cancelledRuns, controlRevoked: wasGranted };
}
