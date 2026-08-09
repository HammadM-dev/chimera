import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnimationEvent, CSSProperties, JSX } from 'react';
import { recordStage } from './timeline.ts';
import './splash.css';

const WORDMARK = 'CHIMERA';

/** DESIGN.md section 5.3 — the fixed hold shown instead of the sequence when
 * the OS asks for reduced motion. It is a timer rather than an animation
 * because the reduced-motion rules in splash.css remove every animation, so
 * there is no animationend left to unmount on. */
const REDUCED_MOTION_HOLD_MS = 400;

/* Arming thresholds. On a cold Electron start the renderer drops frames badly
 * for the first half-second or so while the GPU process and the X11 surface
 * come up — measured on the Linux dev machine as individual frame gaps of
 * 195ms and 406ms inside the first 600ms. A time-based animation started in
 * that window does not slow down, it *skips*: letters three through seven
 * land in one frame instead of 100ms apart. So the splash mounts opaque
 * immediately (covering the shell, so there is no flash of app chrome) but
 * every `animation` declaration in splash.css is scoped to
 * `[data-armed='true']` and does not exist until this resolves. */
const FRAME_BUDGET_MS = 34; // two frames at 60Hz — one dropped frame is tolerated
const STEADY_FRAMES = 6;
/** Give up waiting and play anyway. A machine that never reaches a steady
 * frame loop should still get its intro, jank and all — an indefinite dark
 * window is the worse failure. */
const ARM_TIMEOUT_MS = 1500;

/** Names must match the @keyframes in splash.css. The component reads these
 * off animation events; it never schedules a stage itself. */
const ANIMATION = {
  letter: 'splash-letter-in',
  rule: 'splash-rule-draw',
  byline: 'splash-byline-in',
  life: 'splash-life',
} as const;

type Stage = 'letters' | 'rule' | 'byline';

/** Resolves true once the renderer is genuinely ready to animate.
 *
 * Three gates, in order, because no one of them is sufficient on its own:
 *   1. `document.fonts.ready` — the wordmark and the serif byline must have
 *      their faces resolved before the first animated frame, or that frame
 *      also pays for font fallback resolution.
 *   2. `requestIdleCallback` — the browser reporting idle time is the direct
 *      signal that startup work has drained, rather than a guess at how long
 *      that takes.
 *   3. STEADY_FRAMES consecutive frames within FRAME_BUDGET_MS — idle does not
 *      imply the compositor is producing frames on cadence yet.
 *
 * ARM_TIMEOUT_MS caps the whole thing: a machine that never reaches a steady
 * frame loop should still get its intro, jank and all, because an indefinitely
 * dark window is the worse failure.
 */
function useArmed(waitForSteadyFrames: boolean): boolean {
  const [armed, setArmed] = useState(!waitForSteadyFrames);

  useEffect(() => {
    if (!waitForSteadyFrames) return;
    let raf = 0;
    let cancelled = false;
    const startedAt = performance.now();

    const waitForSteady = (): void => {
      let steady = 0;
      let previous = performance.now();
      const tick = (now: number): void => {
        if (cancelled) return;
        steady = now - previous <= FRAME_BUDGET_MS ? steady + 1 : 0;
        previous = now;
        if (steady >= STEADY_FRAMES || now - startedAt >= ARM_TIMEOUT_MS) {
          recordStage('armed');
          setArmed(true);
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    const whenIdle = (): void => {
      if (cancelled) return;
      const remaining = Math.max(0, ARM_TIMEOUT_MS - (performance.now() - startedAt));
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(waitForSteady, { timeout: remaining });
      } else {
        waitForSteady();
      }
    };

    void document.fonts.ready.then(whenIdle, whenIdle);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [waitForSteadyFrames]);

  return armed;
}

interface SplashProps {
  /** Called once when the splash is finished, whether it ran to completion,
   * was skipped, or was held statically for reduced motion. */
  onDone: () => void;
}

export function Splash({ onDone }: SplashProps): JSX.Element {
  const [stage, setStage] = useState<Stage>('letters');
  const rootRef = useRef<HTMLDivElement>(null);
  // onDone must fire exactly once: a skip landing in the same frame as the
  // final animationend would otherwise advance the shell twice.
  const doneRef = useRef(false);

  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Nothing to arm under reduced motion — there are no animations to hold.
  const armed = useArmed(!reducedMotion);

  const finish = useCallback(
    (reason: 'unmount' | 'skip') => {
      if (doneRef.current) return;
      doneRef.current = true;
      recordStage(reason);
      onDone();
    },
    [onDone],
  );

  // The timeline's origin. Under reduced motion this is also the only entry
  // before `unmount`, which is what makes "no animation ran" provable rather
  // than merely unobserved: every stage below is recorded from an
  // animationstart, so a reduced-motion timeline containing nothing but mount
  // and unmount is a positive assertion that no animation existed at all.
  useEffect(() => {
    recordStage('mount');
  }, []);

  // Any keypress or click skips (DESIGN.md section 5.2). Bound on window
  // rather than on the splash element so it works regardless of what holds
  // focus when the app opens.
  useEffect(() => {
    const skip = (): void => {
      finish('skip');
    };
    window.addEventListener('keydown', skip);
    window.addEventListener('pointerdown', skip);
    return () => {
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [finish]);

  useEffect(() => {
    if (!reducedMotion) return;
    const timer = window.setTimeout(() => {
      finish('unmount');
    }, REDUCED_MOTION_HOLD_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [reducedMotion, finish]);

  const handleAnimationStart = (event: AnimationEvent<HTMLDivElement>): void => {
    switch (event.animationName) {
      case ANIMATION.letter: {
        const index = (event.target as HTMLElement).dataset['letterIndex'];
        if (index !== undefined) recordStage(`letter-${index}`);
        break;
      }
      case ANIMATION.rule:
        recordStage('rule');
        setStage('rule');
        break;
      case ANIMATION.byline:
        recordStage('byline');
        setStage('byline');
        break;
      default:
        break;
    }
  };

  const handleAnimationEnd = (event: AnimationEvent<HTMLDivElement>): void => {
    // splash-life is the only animation on the root itself; the staged
    // animations below it bubble their events through here too.
    if (event.animationName === ANIMATION.life && event.target === rootRef.current) {
      finish('unmount');
    }
  };

  return (
    <div
      ref={rootRef}
      className="splash"
      data-stage={stage}
      data-armed={String(armed)}
      data-reduced-motion={String(reducedMotion)}
      onAnimationStart={handleAnimationStart}
      onAnimationEnd={handleAnimationEnd}
    >
      <div className="splash__mark">
        <div className="splash__wordmark" role="img" aria-label={WORDMARK}>
          {WORDMARK.split('').map((letter, index) => (
            <span
              key={`${letter}-${String(index)}`}
              className="splash__letter"
              data-letter-index={index}
              style={{ '--letter-index': index } as CSSProperties}
              aria-hidden="true"
            >
              {letter}
            </span>
          ))}
        </div>
        <div className="splash__rule" />
        <p className="splash__byline">made by Hammad</p>
      </div>
      <button
        type="button"
        className="splash__skip"
        onClick={() => {
          finish('skip');
        }}
      >
        Skip intro
      </button>
    </div>
  );
}
