import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, MutableRefObject } from 'react';
import { layoutOf, type Layout } from './swarmForce.ts';

// The population, as a picture.
//
// A swarm's answer is a number, and a number is a poor account of how it was
// arrived at. What actually happened is that a few hundred people with
// different starting views listened to each other for a few rounds and mostly
// converged — and that is a shape: clusters around the loud, stragglers holding
// out, a colour sweeping across the crowd as a round lands.
//
// Canvas rather than SVG. Three hundred nodes and their ties is around a
// thousand elements, and a thousand DOM nodes re-styled every frame is a
// different kind of application from one that draws a thousand paths.

export interface GraphData {
  nodes: {
    id: string;
    name: string;
    kind: 'archetype' | 'follower';
    follows: string;
    influence: number;
  }[];
  ties: { from: string; to: string; weight: number }[];
  drawn: number;
  total: number;
}

export interface Stance {
  id: string;
  position: number;
  confidence: number;
}

/** What one agent is doing right now, and since when. */
export interface ActivityState {
  state: 'asking' | 'answered' | 'failed';
  /** `performance.now()` at the moment it changed. Drives the flare's decay. */
  since: number;
}

/**
 * The live feed, as a box rather than a value.
 *
 * Activity arrives several times a second and is read by an animation loop, so
 * it must not be React state: a re-render per event would rebuild the
 * component tree faster than the frames it is trying to draw. The owner
 * mutates the map inside this ref and the loop reads it, which is the same
 * arrangement `stances` uses and for the same reason.
 */
export type ActivityFeed = MutableRefObject<Map<string, ActivityState>>;

/** What one persona is, for the panel that opens when you click. */
export interface Picked {
  id: string;
  name: string;
  kind: 'archetype' | 'follower';
  position: number;
  confidence: number;
  said: string;
}

/** How long an answer stays lit after it lands, in milliseconds. */
const FLARE_MS = 1_400;

/**
 * Reads a CSS custom property as an rgb triple.
 *
 * The palette is theme-aware and lives in tokens.css; canvas cannot use a CSS
 * variable, so the values are read once from the document and mixed here. This
 * is the one place in the app that needs real numbers rather than tokens, and
 * reading them beats hard-coding a second copy that drifts from the first.
 */
function readColour(name: string, fallback: [number, number, number]): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  if (hex?.[1] !== undefined) {
    const value = Number.parseInt(hex[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(raw);
  const parts = rgb?.[1]?.split(',').map((one) => Number(one.trim()));
  return parts !== undefined && parts.length >= 3
    ? [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
    : fallback;
}

function mix(
  a: [number, number, number],
  b: [number, number, number],
  amount: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount),
  ];
}

export function SwarmGraph({
  graph,
  stances,
  said,
  live,
  activity,
  caption = '',
  round = 0,
}: {
  graph: GraphData;
  /** Where everyone stands right now. Empty before the first round lands. */
  stances: Stance[];
  /** What the thinking ones said, by name, for the detail panel. */
  said: Map<string, string>;
  /** True while rounds are still arriving — drives the motion and the pulse. */
  live: boolean;
  /** Per-agent activity, when there is a run to watch. */
  activity?: ActivityFeed;
  /** A line of progress under the picture. Empty on a finished thread. */
  caption?: string;
  /**
   * Bumped when a round lands, to push the crowd apart again.
   *
   * A number rather than a callback because the graph is the thing that knows
   * how to move; the owner only knows when something happened. Deliberately
   * not the stance list: individual answers land several times a second, and
   * reheating on each would be a permanent stir rather than a round breaking.
   */
  round?: number;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<Layout | null>(null);
  const stanceRef = useRef<Map<string, Stance>>(new Map());
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [full, setFull] = useState(false);
  const [names, setNames] = useState(true);
  const [size, setSize] = useState({ width: 640, height: 380 });

  const empty = useRef<Map<string, ActivityState>>(new Map());
  const feed = activity ?? empty;

  // Stances arrive per round and are read by the draw loop, which must not
  // re-subscribe every time they change — hence a ref rather than state.
  useEffect(() => {
    stanceRef.current = new Map(stances.map((stance) => [stance.id, stance]));
  }, [stances]);

  // The layout is rebuilt only when the population itself changes, or when the
  // stage does. A new round must not move anybody: the point is watching the
  // same crowd change colour.
  useEffect(() => {
    layoutRef.current = graph.nodes.length === 0 ? null : layoutOf(graph.nodes, graph.ties, size);
  }, [graph.nodes, graph.ties, size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return undefined;

    const observer = new ResizeObserver(() => {
      const box = parent.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return;
      setSize({ width: Math.max(240, box.width), height: Math.max(220, box.height) });
    });
    observer.observe(parent);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Escape leaves fullscreen. The button is the obvious way out and this is
  // the one everybody tries first.
  useEffect(() => {
    if (!full) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [full]);

  // Everything the loop needs that is not a ref, in one box it can read
  // without being torn down and rebuilt. Restarting the animation on every
  // prop change was what made a thread with several finished graphs expensive:
  // each restart is a fresh closure, and none of them ever stopped.
  const view = useRef({ live, names, picked, nodes: graph.nodes });
  view.current = { live, names, picked, nodes: graph.nodes };

  /**
   * Wakes the animation, which otherwise stops.
   *
   * This is the fix for the real performance fault. Every graph in a thread —
   * one per question ever asked of this crowd — used to run its own 60fps
   * loop, clearing the canvas and redrawing several hundred arcs and a
   * thousand hairlines, for good, whether or not anything had changed. Five
   * finished turns on screen was five of those. A finished graph now draws
   * once and stops; a running one animates until the run ends.
   */
  const wake = useRef<() => void>(() => undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return undefined;

    const ratio = window.devicePixelRatio || 1;
    canvas.width = size.width * ratio;
    canvas.height = size.height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const against = readColour('--semantic-danger', [212, 97, 74]);
    const forIt = readColour('--semantic-success', [90, 167, 111]);
    const undecided = readColour('--text-muted', [111, 108, 102]);
    const hairline = readColour('--text-primary', [245, 243, 238]);
    const ink = `rgb(${String(hairline[0])}, ${String(hairline[1])}, ${String(hairline[2])})`;

    let frame = 0;
    let running = false;
    let pulse = 0;

    const draw = (): void => {
      const layout = layoutRef.current;
      const { live: isLive, names: showNames, picked: chosen, nodes: meta } = view.current;
      const now = performance.now();
      context.clearRect(0, 0, size.width, size.height);

      if (layout === null) {
        running = false;
        return;
      }

      // While a run is in flight the crowd never comes to rest: the wander
      // keeps it drifting, which is the difference between watching a
      // population and looking at a diagram of one. When the run is over it
      // integrates to rest and then stops entirely.
      if (isLive || !layout.settled) layout.step(isLive);
      pulse = (pulse + 0.045) % (Math.PI * 2);

      // Ties first, under the nodes. Faint: they are context for the clusters,
      // not the subject, and at three hundred nodes a confident line weight
      // turns the whole thing into a grey field.
      context.lineWidth = 0.5;
      for (const link of layout.links) {
        const from = layout.nodes[link.from];
        const to = layout.nodes[link.to];
        if (!from || !to) continue;
        context.strokeStyle = `rgba(${String(hairline[0])}, ${String(hairline[1])}, ${String(hairline[2])}, ${String(0.04 + link.weight * 0.08)})`;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
      }

      const hover = hoverRef.current;
      let nearest: { at: number; distance: number } | null = null;
      let flaring = false;
      const labels: { x: number; y: number; text: string; strong: boolean }[] = [];

      for (let at = 0; at < layout.nodes.length; at += 1) {
        const node = layout.nodes[at];
        const who = meta[at];
        if (!node || !who) continue;

        if (hover !== null) {
          const distance = Math.hypot(node.x - hover.x, node.y - hover.y);
          if (distance <= node.radius + 8 && (nearest === null || distance < nearest.distance)) {
            nearest = { at, distance };
          }
        }

        const stance = stanceRef.current.get(node.id);
        const position = stance?.position ?? 0;
        // Colour is the opinion: red against, green for, muted while undecided.
        // Confidence drives how far from grey it has travelled, so a crowd that
        // has not made its mind up reads as grey rather than as a weak green.
        const towards = position < 0 ? against : forIt;
        const strength =
          Math.min(1, Math.abs(position)) * (0.35 + (stance?.confidence ?? 0) * 0.65);
        const [r, g, b] = mix(undecided, towards, strength);

        // What this agent is doing, right now. `asking` means a request is
        // genuinely in flight to a provider; `answered` flares and fades. This
        // is the live progress — not a decoration standing in for the work,
        // the work itself, one model call at a time.
        const doing = feed.current.get(node.id);
        const age = doing === undefined ? Number.POSITIVE_INFINITY : now - doing.since;
        const waiting = doing?.state === 'asking';
        const flare =
          doing?.state === 'answered' && age < FLARE_MS ? 1 - age / FLARE_MS : 0;
        if (waiting || flare > 0) flaring = true;

        // A thinking agent breathes while the round is in flight, and one with
        // a request actually open breathes harder.
        const breathing =
          isLive && (who.kind === 'archetype' || waiting)
            ? 1 + Math.sin(pulse * (waiting ? 2.2 : 1) + at * 0.4) * (waiting ? 0.28 : 0.12)
            : 1;
        const radius = node.radius * breathing + flare * 2;

        if (waiting) {
          // An opening ring, so an agent that has been waiting thirty seconds
          // looks different from one asked a moment ago.
          const reach = radius + 4 + ((age / 900) % 1) * 10;
          context.beginPath();
          context.arc(node.x, node.y, reach, 0, Math.PI * 2);
          context.strokeStyle = `rgba(${String(hairline[0])}, ${String(hairline[1])}, ${String(hairline[2])}, ${String(0.35 * (1 - ((age / 900) % 1)))})`;
          context.lineWidth = 1;
          context.stroke();
        }

        if (flare > 0) {
          context.beginPath();
          context.arc(node.x, node.y, radius + 6 * flare, 0, Math.PI * 2);
          context.fillStyle = `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(0.28 * flare)})`;
          context.fill();
        }

        context.beginPath();
        context.arc(node.x, node.y, radius, 0, Math.PI * 2);
        context.fillStyle = `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
        context.fill();

        // Archetypes are ringed. They are the ones a model actually answers
        // for; everyone else moved by arithmetic, and the difference is worth
        // being able to see.
        if (who.kind === 'archetype') {
          context.lineWidth = 1;
          context.strokeStyle = `rgba(${String(hairline[0])}, ${String(hairline[1])}, ${String(hairline[2])}, ${String(waiting ? 0.9 : 0.55)})`;
          context.stroke();
        }

        if (chosen?.id === node.id) {
          context.lineWidth = 1.5;
          context.strokeStyle = ink;
          context.beginPath();
          context.arc(node.x, node.y, radius + 4, 0, Math.PI * 2);
          context.stroke();
        }

        // Name tags. Archetypes carry theirs always — there are at most two
        // dozen of them and they are the ones with something to say. A
        // follower is one of three hundred and gets a tag only when it is
        // under the cursor or opened, which is the only moment its name is a
        // question anybody is asking.
        if (showNames && who.kind === 'archetype') {
          labels.push({ x: node.x + radius + 4, y: node.y + 3, text: who.name, strong: false });
        }
      }

      if (nearest !== null) {
        const node = layout.nodes[nearest.at];
        const who = meta[nearest.at];
        if (node && who && (!showNames || who.kind !== 'archetype')) {
          labels.push({
            x: node.x + node.radius + 4,
            y: node.y + 3,
            text: who.name,
            strong: true,
          });
        }
      }

      // Labels last so nothing is drawn over them.
      context.font = '400 10px ui-sans-serif, system-ui, sans-serif';
      context.textBaseline = 'alphabetic';
      for (const label of labels) {
        const width = context.measureText(label.text).width;
        // Flipped to the left near the right edge, rather than clipped off it.
        const x = label.x + width > size.width - 4 ? label.x - width - 12 : label.x;
        context.fillStyle = `rgba(${String(hairline[0])}, ${String(hairline[1])}, ${String(hairline[2])}, ${String(label.strong ? 0.92 : 0.6)})`;
        context.fillText(label.text, x, label.y);
      }

      // Another frame only while something is still moving. A finished,
      // settled graph costs nothing until it is touched again.
      if (isLive || !layout.settled || flaring || hover !== null) {
        frame = requestAnimationFrame(draw);
      } else {
        running = false;
      }
    };

    const start = (): void => {
      if (running) return;
      running = true;
      frame = requestAnimationFrame(draw);
    };
    wake.current = start;
    start();

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      wake.current = () => undefined;
    };
  }, [size, feed]);

  // Anything that changes the picture wakes it. A settled graph is asleep, so
  // without this a new round would change colour and nothing would repaint.
  useEffect(() => {
    wake.current();
  }, [live, names, picked, stances, graph.nodes]);

  // A round landing is worth seeing move, not only seeing recolour.
  useEffect(() => {
    if (round > 0) layoutRef.current?.reheat();
    wake.current();
  }, [round]);

  const at = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }, []);

  const pick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const layout = layoutRef.current;
      const point = at(event);
      if (layout === null || point === null) return;

      let best: { at: number; distance: number } | null = null;
      for (let index = 0; index < layout.nodes.length; index += 1) {
        const node = layout.nodes[index];
        if (!node) continue;
        const distance = Math.hypot(node.x - point.x, node.y - point.y);
        if (distance <= node.radius + 6 && (best === null || distance < best.distance)) {
          best = { at: index, distance };
        }
      }

      if (best === null) {
        setPicked(null);
        return;
      }

      const who = graph.nodes[best.at];
      if (!who) return;
      const stance = stanceRef.current.get(who.id);
      setPicked({
        id: who.id,
        name: who.name,
        kind: who.kind,
        position: stance?.position ?? 0,
        confidence: stance?.confidence ?? 0,
        said: said.get(who.name) ?? '',
      });
    },
    [at, graph.nodes, said],
  );

  const archetypes = useMemo(
    () => graph.nodes.filter((node) => node.kind === 'archetype').length,
    [graph.nodes],
  );

  if (graph.nodes.length === 0) {
    return (
      <div className="swarm-graph swarm-graph--empty" data-testid="swarm-graph">
        <p className="agent-card__prompt">The crowd appears once the cast is written.</p>
      </div>
    );
  }

  const leaning =
    picked === null
      ? ''
      : picked.position < -0.1
        ? 'against'
        : picked.position > 0.1
          ? 'for'
          : 'undecided';

  return (
    <div
      className={`swarm-graph${full ? ' swarm-graph--full' : ''}`}
      data-testid="swarm-graph"
      data-full={full ? 'yes' : 'no'}
    >
      <div className="swarm-graph__stage">
        <canvas
          ref={canvasRef}
          className="swarm-graph__canvas"
          data-testid="swarm-graph-canvas"
          style={{ width: `${String(size.width)}px`, height: `${String(size.height)}px` }}
          onClick={pick}
          onMouseMove={(event) => {
            hoverRef.current = at(event);
            wake.current();
          }}
          onMouseLeave={() => {
            hoverRef.current = null;
            wake.current();
          }}
        />

        <div className="swarm-graph__tools">
          {archetypes > 0 && (
            <button
              type="button"
              className={`swarm-graph__tool${names ? ' swarm-graph__tool--on' : ''}`}
              data-testid="swarm-graph-names"
              aria-pressed={names}
              onClick={() => {
                setNames(!names);
              }}
            >
              Names
            </button>
          )}
          <button
            type="button"
            className="swarm-graph__tool"
            data-testid="swarm-graph-full"
            aria-pressed={full}
            onClick={() => {
              setFull(!full);
            }}
          >
            {full ? 'Close' : 'Full screen'}
          </button>
        </div>
      </div>

      <div className="swarm-graph__legend">
        <span className="swarm-graph__key">
          <i className="swarm-graph__swatch swarm-graph__swatch--against" />
          Against
        </span>
        <span className="swarm-graph__key">
          <i className="swarm-graph__swatch swarm-graph__swatch--undecided" />
          Undecided
        </span>
        <span className="swarm-graph__key">
          <i className="swarm-graph__swatch swarm-graph__swatch--for" />
          For
        </span>
        <span className="swarm-graph__count" data-testid="swarm-graph-caption">
          {caption !== ''
            ? caption
            : graph.drawn === graph.total
              ? `${String(graph.total)} people`
              : `${String(graph.drawn)} of ${String(graph.total)} shown`}
        </span>
      </div>

      {picked !== null && (
        <aside className="swarm-graph__detail" data-testid="swarm-graph-detail">
          <header className="swarm-graph__who">
            <span className="swarm-graph__name">{picked.name}</span>
            <span className="swarm-graph__role">
              {picked.kind === 'archetype' ? 'Thinks for itself' : 'Follows'}
            </span>
          </header>
          <p className="swarm-graph__stance">
            {leaning}
            {picked.confidence > 0 && ` · ${String(Math.round(picked.confidence * 100))}% sure`}
          </p>
          {picked.said !== '' && <p className="swarm-graph__said">“{picked.said}”</p>}
        </aside>
      )}
    </div>
  );
}
