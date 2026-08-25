// A force layout, small enough to own.
//
// The alternative was d3-force, and adding a dependency needs asking first —
// but the honest reason not to is that this needs two specific things d3 does
// not do out of the box: positions that hold still between rounds so the eye
// can track a node changing its mind, and a crowd that keeps moving while the
// run is still going. A layout that re-settles every time new data arrives
// makes the crowd jump, and then the movement on screen is the layout's, not
// the population's.
//
// Velocity Verlet with three forces, which is what a force-directed graph is:
// repulsion so nodes do not pile up, springs along the ties, and a weak pull to
// the centre so the whole thing does not drift off screen.

export interface ForceNode {
  id: string;
  x: number;
  y: number;
  /** Drawn radius, from influence. Heavier nodes push harder and move less. */
  radius: number;
}

export interface ForceLink {
  from: number;
  to: number;
  weight: number;
}

export interface Layout {
  /** Mean movement per node on the last step. Exposed for tuning and tests. */
  readonly drift: number;
  nodes: ForceNode[];
  links: ForceLink[];
  /**
   * One integration step.
   *
   * `ambient` adds a small wandering force to every node. It is what keeps the
   * picture alive while a run is in flight: without it the layout reaches rest
   * in a couple of seconds and then sits perfectly still for the ten minutes
   * the crowd is actually thinking, which reads as a screenshot of a graph
   * rather than as a thing happening.
   */
  step: (ambient?: boolean) => void;
  /**
   * Pushes the crowd apart again, so a change visibly reorganises it.
   *
   * Called when a round lands. A settled layout given new opinions would
   * otherwise change colour without moving, and the movement is half of what
   * the picture is for.
   */
  reheat: (amount?: number) => void;
  /** True once movement has fallen below anything worth redrawing for. */
  readonly settled: boolean;
}

const REPULSION = 900;
const SPRING = 0.02;
const CENTRE_PULL = 0.0015;
const DAMPING = 0.86;
/** Below this mean movement per node per step, the picture has stopped. */
const SETTLED = 0.35;

/**
 * How far repulsion reaches, in pixels.
 *
 * Repulsion falls off with the square of distance, so at the strengths used
 * here a node two cutoffs away contributes about a thousandth of what its
 * neighbour does — real in arithmetic, invisible on screen. Ignoring it turns
 * the every-pair loop into a neighbourhood one: measured at the drawn cap of
 * 320 nodes, a settled crowd evaluates 19,004 pairs a step rather than 51,040,
 * and the picture is indistinguishable.
 *
 * Worth being precise about what this did and did not fix. It was written to
 * cure a stuttering graph, and it is not what was causing it — the profile
 * that suggested it came from a throttled environment where 51,000 iterations
 * of trivial arithmetic take sixteen milliseconds, which is around a thousand
 * times slower than the machine this actually runs on. On real hardware the
 * every-pair version was already far inside a frame. The stutter was one
 * animation loop per past turn in a thread, all redrawing at 60fps for good;
 * see `SwarmGraph`. This stays because it is free and because the drawn cap
 * has room to rise, not because it was the bug.
 */
const CUTOFF = 120;

/**
 * The most a node may move in one step.
 *
 * Not a nicety — without it this diverges. Every node repels its neighbours, so
 * the force on one grows with the local density while the timestep does not,
 * and at three hundred nodes measured drift went 137, 166, 143, 1039: not
 * settling slowly, blowing up. Two nodes that happen to start close produce an
 * enormous impulse, hit a wall, bounce, and hand the energy to everything they
 * pass. Capping speed makes the integrator stable at any size, at the cost of
 * taking a few more frames to spread out from a crowded start.
 */
const MAX_SPEED = 6;

/** How hard the ambient wander pushes. Enough to drift, not enough to stir. */
const WANDER = 0.06;

/**
 * Lays out a population.
 *
 * Seeded from the node ids rather than at random, so reopening a thread draws
 * the same shape it drew before. A crowd that rearranges itself every time you
 * look at it is a crowd you cannot recognise.
 */
export function layoutOf(
  nodes: { id: string; influence: number; kind: 'archetype' | 'follower'; follows: string }[],
  ties: { from: string; to: string; weight: number }[],
  size: { width: number; height: number },
): Layout {
  const index = new Map(nodes.map((node, at) => [node.id, at]));
  const count = nodes.length;

  // Archetypes first, spread evenly around a ring; each follower starts beside
  // the one it listens to.
  //
  // This was a single ring for everybody, and it produced exactly the wrong
  // picture: a sunburst, with the archetypes collapsed into one knot at the
  // centre and a hundred followers in a perfect circle around them. Springs
  // pull a follower towards its archetype, so if they all start equidistant
  // from all of them there is nothing to break the symmetry, and the layout
  // has no reason to form the clusters that are the whole point.
  const archetypes = nodes.filter((node) => node.kind === 'archetype');
  const seats = new Map(archetypes.map((node, at) => [node.id, at]));
  const spread = Math.max(1, archetypes.length);

  const seatOf = (at: number): { x: number; y: number } => {
    const angle = (at / spread) * Math.PI * 2;
    return {
      x: size.width / 2 + Math.cos(angle) * size.width * 0.3,
      y: size.height / 2 + Math.sin(angle) * size.height * 0.3,
    };
  };

  // Physics runs on flat arrays and the drawing reads objects.
  //
  // The inner loop touches four fields of every neighbour of every node, every
  // frame; flat arrays keep that a contiguous read rather than a property
  // lookup per field. The objects are still the public surface — hit-testing
  // and the renderer want `node.x` — and they are written back once per step,
  // which is O(n) and free.
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const vxs = new Float64Array(count);
  const vys = new Float64Array(count);
  const radii = new Float64Array(count);
  const phases = new Float64Array(count);

  const placed: ForceNode[] = nodes.map((node, at) => {
    const seat = seats.get(node.kind === 'archetype' ? node.id : node.follows);
    const home = seatOf(seat ?? at % spread);
    // Deterministic scatter around the seat, from the index — so a follower
    // does not start exactly on top of its archetype, and reopening a thread
    // draws the same arrangement.
    const spin = at * 2.39996;
    const reach = node.kind === 'archetype' ? 0 : 18 + ((at * 7) % 46);

    xs[at] = home.x + Math.cos(spin) * reach;
    ys[at] = home.y + Math.sin(spin) * reach;
    radii[at] = node.kind === 'archetype' ? 5 + node.influence * 5 : 2.5 + node.influence * 2;
    // Every node wanders on its own clock, so the crowd shimmers rather than
    // sloshing about as one body.
    phases[at] = at * 2.39996;

    return { id: node.id, x: xs[at], y: ys[at], radius: radii[at] };
  });

  const links: ForceLink[] = ties.flatMap((tie) => {
    const from = index.get(tie.from);
    const to = index.get(tie.to);
    return from === undefined || to === undefined ? [] : [{ from, to, weight: tie.weight }];
  });

  let movement = Number.POSITIVE_INFINITY;
  let tick = 0;

  // Repulsion eases off as the crowd grows, but by the square root rather than
  // linearly. Dividing by the headcount outright made it far too weak to
  // matter at a hundred nodes: everybody stayed wherever they started and the
  // springs did all the work, which is how the first version came out as a
  // ring that never moved. Stability comes from the speed cap below, not from
  // making the forces small.
  const repulsion = REPULSION * Math.sqrt(24 / Math.max(24, count));

  // The neighbourhood grid, allocated once and refilled each step. Cells are
  // one cutoff across, so a node's neighbours are in its own cell and the
  // eight around it and nowhere else.
  const columns = Math.max(1, Math.ceil(size.width / CUTOFF));
  const rows = Math.max(1, Math.ceil(size.height / CUTOFF));
  const cells = columns * rows;
  const cellStart = new Int32Array(cells + 1);
  const cellOf = new Int32Array(count);
  const ordered = new Int32Array(count);

  const bucket = (at: number): number => {
    const column = Math.min(columns - 1, Math.max(0, Math.floor((xs[at] as number) / CUTOFF)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((ys[at] as number) / CUTOFF)));
    return row * columns + column;
  };

  /** Counting sort of node indices into cells. Deterministic, allocation-free. */
  const rebuildGrid = (): void => {
    cellStart.fill(0);
    for (let at = 0; at < count; at += 1) {
      const cell = bucket(at);
      cellOf[at] = cell;
      cellStart[cell + 1] = (cellStart[cell + 1] as number) + 1;
    }
    for (let cell = 0; cell < cells; cell += 1) {
      cellStart[cell + 1] = (cellStart[cell + 1] as number) + (cellStart[cell] as number);
    }
    // A second cursor over the offsets, so `cellStart` survives the fill and
    // can be read as ranges below.
    const cursor = cellStart.slice(0, cells);
    for (let at = 0; at < count; at += 1) {
      const cell = cellOf[at] as number;
      ordered[cursor[cell] as number] = at;
      cursor[cell] = (cursor[cell] as number) + 1;
    }
  };

  const repel = (a: number, b: number): void => {
    const dx = (xs[b] as number) - (xs[a] as number);
    const dy = (ys[b] as number) - (ys[a] as number);
    const squared = dx * dx + dy * dy || 0.01;
    if (squared > CUTOFF * CUTOFF) return;
    const distance = Math.sqrt(squared);
    const push = repulsion / squared;
    const ux = (dx / distance) * push;
    const uy = (dy / distance) * push;
    vxs[a] = (vxs[a] as number) - ux;
    vys[a] = (vys[a] as number) - uy;
    vxs[b] = (vxs[b] as number) + ux;
    vys[b] = (vys[b] as number) + uy;
  };

  const step = (ambient = false): void => {
    tick += 1;
    let moved = 0;

    // Repulsion, over neighbourhoods rather than every pair. Each cell is
    // resolved against itself and the four cells after it in scan order, which
    // covers every neighbouring pair exactly once.
    rebuildGrid();
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const cell = row * columns + column;
        const from = cellStart[cell] as number;
        const to = cellStart[cell + 1] as number;
        if (from === to) continue;

        for (let i = from; i < to; i += 1) {
          const a = ordered[i] as number;
          for (let j = i + 1; j < to; j += 1) repel(a, ordered[j] as number);
        }

        // Right, and the three below. The cells before this one in scan order
        // already did their side of the pair.
        for (const [dc, dr] of [
          [1, 0],
          [-1, 1],
          [0, 1],
          [1, 1],
        ] as const) {
          const nc = column + dc;
          const nr = row + dr;
          if (nc < 0 || nc >= columns || nr >= rows) continue;
          const other = nr * columns + nc;
          const otherFrom = cellStart[other] as number;
          const otherTo = cellStart[other + 1] as number;
          for (let i = from; i < to; i += 1) {
            const a = ordered[i] as number;
            for (let j = otherFrom; j < otherTo; j += 1) repel(a, ordered[j] as number);
          }
        }
      }
    }

    // Springs. A stronger tie pulls harder, which is what makes clusters form
    // around the archetype their members actually listen to.
    for (const link of links) {
      const from = link.from;
      const to = link.to;
      const dx = (xs[to] as number) - (xs[from] as number);
      const dy = (ys[to] as number) - (ys[from] as number);
      const pull = SPRING * link.weight;
      vxs[from] = (vxs[from] as number) + dx * pull;
      vys[from] = (vys[from] as number) + dy * pull;
      vxs[to] = (vxs[to] as number) - dx * pull;
      vys[to] = (vys[to] as number) - dy * pull;
    }

    const midX = size.width / 2;
    const midY = size.height / 2;

    for (let at = 0; at < count; at += 1) {
      let vx = (vxs[at] as number) + (midX - (xs[at] as number)) * CENTRE_PULL;
      let vy = (vys[at] as number) + (midY - (ys[at] as number)) * CENTRE_PULL;

      if (ambient) {
        const phase = phases[at] as number;
        vx += Math.cos(tick * 0.021 + phase) * WANDER;
        vy += Math.sin(tick * 0.017 + phase * 1.7) * WANDER;
      }

      vx *= DAMPING;
      vy *= DAMPING;

      const speed = Math.hypot(vx, vy);
      if (speed > MAX_SPEED) {
        vx = (vx / speed) * MAX_SPEED;
        vy = (vy / speed) * MAX_SPEED;
      }

      let x = (xs[at] as number) + vx;
      let y = (ys[at] as number) + vy;
      moved += Math.abs(vx) + Math.abs(vy);

      // Kept on screen. Bouncing rather than clamping, so a node pinned to an
      // edge does not sit there vibrating against it.
      const margin = (radii[at] as number) + 2;
      if (x < margin) {
        x = margin;
        vx = Math.abs(vx) * 0.5;
      }
      if (x > size.width - margin) {
        x = size.width - margin;
        vx = -Math.abs(vx) * 0.5;
      }
      if (y < margin) {
        y = margin;
        vy = Math.abs(vy) * 0.5;
      }
      if (y > size.height - margin) {
        y = size.height - margin;
        vy = -Math.abs(vy) * 0.5;
      }

      xs[at] = x;
      ys[at] = y;
      vxs[at] = vx;
      vys[at] = vy;

      const node = placed[at] as ForceNode;
      node.x = x;
      node.y = y;
    }

    movement = moved;
  };

  const reheat = (amount = 2.5): void => {
    const midX = size.width / 2;
    const midY = size.height / 2;
    for (let at = 0; at < count; at += 1) {
      // Outward from the centre, along each node's own phase, so the crowd
      // breathes out rather than every node jumping the same way.
      const phase = (phases[at] as number) + (xs[at] as number) * 0.01;
      const away = Math.atan2((ys[at] as number) - midY, (xs[at] as number) - midX);
      vxs[at] = (vxs[at] as number) + Math.cos(away + Math.sin(phase) * 0.6) * amount;
      vys[at] = (vys[at] as number) + Math.sin(away + Math.sin(phase) * 0.6) * amount;
    }
    movement = Number.POSITIVE_INFINITY;
  };

  return {
    nodes: placed,
    links,
    step,
    reheat,
    get drift() {
      return movement / Math.max(1, count);
    },
    get settled() {
      return movement / Math.max(1, count) < SETTLED;
    },
  };
}
