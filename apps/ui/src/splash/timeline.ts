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

// The schedule the engine will actually play, captured once at arming.
//
// Recorded here, next to the timeline, for the same reason and with the same
// trade: a handful of numbers, no application data, and the path under test is
// the path that ships.
//
// It exists because reading the schedule from outside the page cannot be done
// reliably. The animations live for 2.3 seconds and go with the splash when it
// unmounts, so a test that polls for them is racing a window that a loaded
// machine can skip over entirely between frames — which is exactly how it
// failed, once, at the tail of a ninety-minute suite. Written from inside, it
// outlives the thing it describes and there is no race left to lose.

export interface ScheduledAnimation {
  readonly name: string;
  /** Start on the document timeline, in milliseconds. */
  readonly startTime: number;
  readonly delay: number;
  readonly duration: number;
  /** Which letter of the wordmark, for the per-letter animations. */
  readonly letterIndex: string | null;
}

export const SPLASH_SCHEDULE_GLOBAL = '__chimeraSplashSchedule';

declare global {
  interface Window {
    [SPLASH_SCHEDULE_GLOBAL]?: ScheduledAnimation[];
  }
}

/**
 * Reads every animation running under `root` and stores it.
 *
 * Called once, on the frame after the splash arms — before then the animations
 * do not exist, because every `animation` declaration in splash.css is scoped
 * to `[data-armed='true']`.
 */
export function recordSchedule(root: Element): void {
  if (window[SPLASH_SCHEDULE_GLOBAL] !== undefined) return;

  window[SPLASH_SCHEDULE_GLOBAL] = document
    .getAnimations()
    .filter((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      return target instanceof Element && root.contains(target);
    })
    .map((animation): ScheduledAnimation => {
      const effect = animation.effect as KeyframeEffect;
      const timing = effect.getComputedTiming();
      const target = effect.target as HTMLElement;
      return {
        name: (animation as CSSAnimation).animationName,
        startTime: Number(animation.startTime),
        delay: Number(timing.delay),
        duration: Number(timing.duration),
        letterIndex: target.dataset['letterIndex'] ?? null,
      };
    });
}
