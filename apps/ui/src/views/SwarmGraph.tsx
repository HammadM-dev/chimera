import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
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

/** What one persona is, for the panel that opens when you click. */
export interface Picked {
  id: string;
  name: string;
  kind: 'archetype' | 'follower';
  position: number;
  confidence: number;
  said: string;
}

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
}: {
  graph: GraphData;
  /** Where everyone stands right now. Empty before the first round lands. */
  stances: Stance[];
  /** What the thinking ones said, by name, for the detail panel. */
  said: Map<string, string>;
  /** True while rounds are still arriving — drives the pulse on thinkers. */
  live: boolean;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<Layout | null>(null);
  const stanceRef = useRef<Map<string, Stance>>(new Map());
  const [picked, setPicked] = useState<Picked | null>(null);
  const [size, setSize] = useState({ width: 640, height: 380 });

  // Stances arrive per round and are read by the draw loop, which must not
  // re-subscribe every time they change — hence a ref rather than state.
  useEffect(() => {
    stanceRef.current = new Map(stances.map((stance) => [stance.id, stance]));
  }, [stances]);

  // The layout is rebuilt only when the population itself changes. A new round
  // must not move anybody: the point is watching the same crowd change colour.
  useEffect(() => {
    layoutRef.current = graph.nodes.length === 0 ? null : layoutOf(graph.nodes, graph.ties, size);
  }, [graph.nodes, graph.ties, size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return undefined;

    const observer = new ResizeObserver(() => {
      const box = parent.getBoundingClientRect();
      setSize({ width: Math.max(240, box.width), height: Math.max(220, box.height) });
    });
    observer.observe(parent);
    return () => {
      observer.disconnect();
    };
  }, []);

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

    let frame = 0;
    let pulse = 0;

    const draw = (): void => {
      const layout = layoutRef.current;
      context.clearRect(0, 0, size.width, size.height);

      if (layout === null) {
        frame = requestAnimationFrame(draw);
        return;
      }

      // Keep integrating until it comes to rest; after that only redraw, so an
      // idle graph costs a clear and a few hundred arcs rather than a physics
      // step. Rounds keep arriving and changing colour either way.
      if (!layout.settled) layout.step();
      pulse = (pulse + 0.04) % (Math.PI * 2);

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

      for (let at = 0; at < layout.nodes.length; at += 1) {
        const node = layout.nodes[at];
        const meta = graph.nodes[at];
        if (!node || !meta) continue;

        const stance = stanceRef.current.get(node.id);
        const position = stance?.position ?? 0;
        // Colour is the opinion: red against, green for, muted while undecided.
        // Confidence drives how far from grey it has travelled, so a crowd that
        // has not made its mind up reads as grey rather than as a weak green.
        const towards = position < 0 ? against : forIt;
        const strength =
          Math.min(1, Math.abs(position)) * (0.35 + (stance?.confidence ?? 0) * 0.65);
        const [r, g, b] = mix(undecided, towards, strength);

        // A thinking agent breathes while the round is in flight. This is the
        // only motion once the layout rests, and it is what makes the picture
        // read as a thing happening rather than a chart.
        const breathing =
          live && meta.kind === 'archetype' ? 1 + Math.sin(pulse + at * 0.4) * 0.12 : 1;

        context.beginPath();
        context.arc(node.x, node.y, node.radius * breathing, 0, Math.PI * 2);
        context.fillStyle = `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
        context.fill();

        // Archetypes are ringed. They are the ones a model actually answers
        // for; everyone else moved by arithmetic, and the difference is worth
        // being able to see.
        if (meta.kind === 'archetype') {
          context.lineWidth = 1;
          context.strokeStyle = `rgba(${String(hairline[0])}, ${String(hairline[1])}, ${String(hairline[2])}, 0.55)`;
          context.stroke();
        }

        if (picked?.id === node.id) {
          context.lineWidth = 1.5;
          context.strokeStyle = `rgb(${String(hairline[0])}, ${String(hairline[1])}, ${String(hairline[2])})`;
          context.beginPath();
          context.arc(node.x, node.y, node.radius * breathing + 4, 0, Math.PI * 2);
          context.stroke();
        }
      }

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [size, graph.nodes, live, picked]);

  const pick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const layout = layoutRef.current;
      const canvas = canvasRef.current;
      if (layout === null || !canvas) return;

      const box = canvas.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;

      let best: { at: number; distance: number } | null = null;
      for (let at = 0; at < layout.nodes.length; at += 1) {
        const node = layout.nodes[at];
        if (!node) continue;
        const distance = Math.hypot(node.x - x, node.y - y);
        if (distance <= node.radius + 6 && (best === null || distance < best.distance)) {
          best = { at, distance };
        }
      }

      if (best === null) {
        setPicked(null);
        return;
      }

      const meta = graph.nodes[best.at];
      if (!meta) return;
      const stance = stanceRef.current.get(meta.id);
      setPicked({
        id: meta.id,
        name: meta.name,
        kind: meta.kind,
        position: stance?.position ?? 0,
        confidence: stance?.confidence ?? 0,
        said: said.get(meta.name) ?? '',
      });
    },
    [graph.nodes, said],
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
    <div className="swarm-graph" data-testid="swarm-graph">
      <div className="swarm-graph__stage">
        <canvas
          ref={canvasRef}
          className="swarm-graph__canvas"
          data-testid="swarm-graph-canvas"
          style={{ width: `${String(size.width)}px`, height: `${String(size.height)}px` }}
          onClick={pick}
        />
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
        <span className="swarm-graph__count">
          {graph.drawn === graph.total
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
