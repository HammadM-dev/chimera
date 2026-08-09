// Stage checkpoints the splash records as they actually happen, so timing can
// be asserted against real events rather than against the numbers the source
// already claims. Every entry's `t` is a raw `performance.now()` reading taken
// inside the DOM event that marks that stage; the consumer normalises against
// `letter-0`, which is by definition t=0 of the animation timeline (its
// animation-delay is `0 * 100ms`).
//
// This array is populated in production builds too. It holds four to eleven
// numbers and no application data of any kind, and having the real launch
// path be the one under test is worth more than the bytes it costs — a
// timeline that only exists under a test flag is a timeline that can drift
// from what ships.

export interface SplashTimelineEntry {
  /** `letter-0`..`letter-6`, `rule`, `byline`, `skip`, or `unmount`. */
  readonly stage: string;
  /** `performance.now()` at the moment the stage began. */
  readonly t: number;
}

export const SPLASH_TIMELINE_GLOBAL = '__chimeraSplashTimeline';

declare global {
  interface Window {
    [SPLASH_TIMELINE_GLOBAL]?: SplashTimelineEntry[];
  }
}

export function recordStage(stage: string): void {
  const timeline = (window[SPLASH_TIMELINE_GLOBAL] ??= []);
  timeline.push({ stage, t: performance.now() });
}
