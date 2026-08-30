import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge } from '../chat/useChimera.ts';
import { Mark } from '../assets/brand/Mark.tsx';
import { TOUR, type TourView } from './steps.ts';
import { useConnections, usePinnedModels } from '../views/useConnections.ts';
import './tour.css';

// The guided tour.
//
// Onboarding stops at one connected provider on purpose — nobody reads a manual
// before they have seen the thing work once. This is the manual, offered after,
// and it is a tour rather than a document because the thing being explained is
// a place: knowing where Runs is beats being told what a run is.
//
// It moves the app as it goes. A tutorial that describes a section you are not
// looking at is asking you to hold a picture in your head that is one click
// away, so each step opens the section it is about and points at the control it
// is talking about.

export interface TourProps {
  /** Opens a section. The tour drives the app rather than describing it. */
  onView: (view: TourView) => void;
  /** Called when it is finished or skipped; either way it does not return. */
  onDone: () => void;
}

interface Spot {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Where the card goes, given where the hole is. */
function placeCard(spot: Spot | null): { top: number; left: number } {
  const width = 400;
  const margin = 20;
  if (spot === null) {
    return {
      top: Math.max(margin, window.innerHeight / 2 - 160),
      left: Math.max(margin, window.innerWidth / 2 - width / 2),
    };
  }

  // Beside the target if there is room to its right, under it otherwise. The
  // card must never cover the thing it is pointing at, which is the one way a
  // spotlight can be worse than no spotlight.
  const right = spot.left + spot.width + margin;
  const left = right + width + margin < window.innerWidth ? right : spot.left;
  const under = spot.top + spot.height + margin;
  const top = under + 220 < window.innerHeight ? under : Math.max(margin, spot.top - 240);

  return {
    top: Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - 260)),
    left: Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin)),
  };
}

export function Tour({ onView, onDone }: TourProps): JSX.Element {
  const [at, setAt] = useState(0);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The last step asks for something to be done rather than read. Read live so
  // the button unlocks the moment they pin, without a refresh.
  const { pinned } = usePinnedModels();
  // What there is to pin. A requirement nobody can satisfy is a trap, not a
  // requirement: somebody who skipped setup reaches the last step with no
  // connection, so no catalogue, so no Pin button anywhere on the screen the
  // step is pointing at — and "Finish" stays disabled for as long as they care
  // to look at it. The ask stands whenever it can be met, which is the normal
  // path, and steps aside when it cannot.
  const { choices, loaded } = useConnections();

  const step = TOUR[at] ?? TOUR[0];
  const last = at === TOUR.length - 1;
  /** True when this step is waiting on something the person has not done yet. */
  const blocked =
    step?.requires === 'pinnedModel' && pinned.length === 0 && (!loaded || choices.length > 0);

  // The section this step is about, opened before it is explained.
  useEffect(() => {
    if (step) onView(step.view);
  }, [step, onView]);

  // Measured after the section has rendered, and again on resize — a hole cut
  // where an element used to be is worse than no hole.
  useLayoutEffect(() => {
    let frame = 0;
    const measure = (): void => {
      const target = step?.target ?? '';
      if (target === '') {
        setSpot(null);
        return;
      }
      const node = document.querySelector(`[data-testid="${target}"]`);
      if (node === null) {
        setSpot(null);
        return;
      }
      const box = node.getBoundingClientRect();
      setSpot({
        top: box.top - 6,
        left: box.left - 6,
        width: box.width + 12,
        height: box.height + 12,
      });
    };

    // Two frames: one for the view switch to commit, one for its layout.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(measure);
    });
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
    };
  }, [step]);

  const finish = useCallback(() => {
    void bridge()
      .invoke('tour:set', { seen: true })
      .catch(() => undefined);

    // Take the offer off the URL as well as out of the settings file.
    //
    // Whether to show the tour is decided by main and travels on this window's
    // own URL, which reloading does not change — so a reload re-offered a tour
    // somebody had already dismissed, settings flag or not. `replaceState`
    // rewrites the URL the document will reload from, which is the only place
    // that answer lives for the life of this window.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('tour') === '1') {
        url.searchParams.set('tour', '0');
        window.history.replaceState({}, '', url.toString());
      }
    } catch {
      // A URL that will not parse is one this never had to fix.
    }

    onDone();
  }, [onDone]);

  // Arrow keys and Escape, because a full-screen thing that only responds to
  // its own buttons is a thing people feel trapped in.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (confirming) return;
      if (event.key === 'Escape') setConfirming(true);
      if (event.key === 'ArrowRight' || event.key === 'Enter') {
        // Blocked means blocked: a keyboard shortcut past a step that is
        // waiting on something would make the requirement decorative.
        if (blocked) return;
        if (last) finish();
        else setAt((current) => Math.min(TOUR.length - 1, current + 1));
      }
      if (event.key === 'ArrowLeft') setAt((current) => Math.max(0, current - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [blocked, confirming, finish, last]);

  const card = placeCard(spot);

  if (confirming) {
    return (
      <div className="tour" data-testid="tour">
        <div className="tour__veil" />
        <div
          className="tour__card tour__card--centre"
          data-testid="tour-skip-confirm"
          role="dialog"
        >
          <p className="tour__eyebrow">Skip the tour</p>
          <h2 className="tour__title">Sure? There is a lot here that is not obvious.</h2>
          <p className="tour__body">
            CHIMERA is not one screen — it is agents, a canvas, runs and traces, connected apps,
            swarms and a governor with real limits, and how those fit together is most of learning
            it. The tour is about two minutes and it is the shortest path to knowing where
            everything is.
          </p>
          <p className="tour__body">
            If you skip it, you can start it again from Home whenever you like.
          </p>
          <div className="tour__actions">
            <button
              type="button"
              className="button button--primary"
              data-testid="tour-keep-going"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep going
            </button>
            <button
              type="button"
              className="button button--quiet"
              data-testid="tour-skip-confirmed"
              onClick={finish}
            >
              Skip anyway
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`tour${step?.requires === undefined ? '' : ' tour--hands-on'}`}
      data-testid="tour"
      data-step={String(at)}
    >
      {/* The dim, with a hole in it. One element and a very large shadow rather
          than four rectangles around the target: four rectangles have seams,
          and the seams show on every non-integer layout. */}
      {spot === null ? (
        <div className="tour__veil" />
      ) : (
        <div
          className="tour__hole"
          data-testid="tour-hole"
          style={{
            top: `${String(spot.top)}px`,
            left: `${String(spot.left)}px`,
            width: `${String(spot.width)}px`,
            height: `${String(spot.height)}px`,
          }}
        />
      )}

      <div
        className="tour__card"
        data-testid="tour-card"
        role="dialog"
        aria-label={step?.title ?? 'Tour'}
        style={{ top: `${String(card.top)}px`, left: `${String(card.left)}px` }}
      >
        <header className="tour__head">
          <Mark size={18} className="tour__mark" />
          <span className="tour__eyebrow" data-testid="tour-progress">
            {at + 1} of {TOUR.length}
          </span>
        </header>

        <h2 className="tour__title">{step?.title}</h2>
        <p className="tour__body">{step?.body}</p>
        {step?.tip !== undefined && (
          <p className="tour__tip" data-testid="tour-tip">
            {step.tip}
          </p>
        )}

        <div className="tour__actions">
          {at > 0 && (
            <button
              type="button"
              className="button button--quiet"
              data-testid="tour-back"
              onClick={() => {
                setAt(Math.max(0, at - 1));
              }}
            >
              Back
            </button>
          )}
          <button
            type="button"
            className="button button--primary"
            data-testid="tour-next"
            disabled={blocked}
            title={blocked ? 'Pin a model below to finish' : undefined}
            onClick={() => {
              if (last) finish();
              else setAt(Math.min(TOUR.length - 1, at + 1));
            }}
          >
            {last ? 'Finish' : 'Next'}
          </button>
          {blocked && (
            <span className="tour__waiting" data-testid="tour-waiting">
              waiting for a pin
            </span>
          )}
          {!last && (
            <button
              type="button"
              className="tour__skip"
              data-testid="tour-skip"
              onClick={() => {
                setConfirming(true);
              }}
            >
              Skip
            </button>
          )}
        </div>

        <div className="tour__pips" aria-hidden="true">
          {TOUR.map((one, index) => (
            <i key={one.title} className={`tour__pip${index <= at ? ' tour__pip--on' : ''}`} />
          ))}
        </div>
      </div>
    </div>
  );
}
