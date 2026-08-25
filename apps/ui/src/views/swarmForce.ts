// A force layout, small enough to own.
//
// The alternative was d3-force, and adding a dependency needs asking first —
// but the honest reason not to is that this needs one specific thing d3 does
// not do out of the box: positions that hold still between rounds so the eye
// can track a node changing its mind. A layout that re-settles every time new
// data arrives makes the crowd jump, and then the movement on screen is the
// layout's, not the population's.
//
// Velocity Verlet with three forces, which is what a force-directed graph is:
// repulsion so nodes do not pile up, springs along the ties, and a weak pull to
// the centre so the whole thing does not drift off screen.

export interface ForceNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
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
  /** One integration step. Called per animation frame. */
  step: () => void;
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
 * The most a node may move in one step.
 *
 * Not a nicety — without it this diverges. Every node repels every other, so
 * the force on one grows with the population while the timestep does not, and
 * at three hundred nodes measured drift went 137, 166, 143, 1039: not settling
 * slowly, blowing up. Two nodes that happen to start close produce an enormous
 * impulse, hit a wall, bounce, and hand the energy to everything they pass.
 * Capping speed makes the integrator stable at any size, at the cost of taking
 * a few more frames to spread out from a crowded start.
 */
const MAX_SPEED = 6;

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

  const placed: ForceNode[] = nodes.map((node, at) => {
    // A deterministic starting ring: archetypes near the middle, their
    // followers further out, spread by index. Starting from a shape rather than
    // from noise means far fewer steps to something legible.
    const angle = (at / Math.max(1, nodes.length)) * Math.PI * 2;
    const ring = node.kind === 'archetype' ? 0.22 : 0.42;
    return {
      id: node.id,
      x: size.width / 2 + Math.cos(angle) * size.width * ring,
      y: size.height / 2 + Math.sin(angle) * size.height * ring,
      vx: 0,
      vy: 0,
      radius: node.kind === 'archetype' ? 5 + node.influence * 5 : 2.5 + node.influence * 2,
    };
  });

  const links: ForceLink[] = ties.flatMap((tie) => {
    const from = index.get(tie.from);
    const to = index.get(tie.to);
    return from === undefined || to === undefined ? [] : [{ from, to, weight: tie.weight }];
  });

  let movement = Number.POSITIVE_INFINITY;

  // Repulsion is shared out as the crowd grows. The force on one node is the
  // sum over every other, so a fixed constant means three hundred nodes push
  // each other roughly ten times as hard as thirty — the same layout at a
  // different size behaves like a different simulation.
  const repulsion = REPULSION * (24 / Math.max(24, placed.length));

  const step = (): void => {
    let moved = 0;

    // Repulsion. O(n²) and deliberately so: at the three hundred nodes this is
    // capped to, that is ninety thousand cheap operations a frame, and a
    // quadtree would be a hundred lines of code to save time nobody is short
    // of. If the cap ever rises, this is the thing to fix.
    for (let a = 0; a < placed.length; a += 1) {
      const one = placed[a] as ForceNode;
      for (let b = a + 1; b < placed.length; b += 1) {
        const other = placed[b] as ForceNode;
        const dx = other.x - one.x;
        const dy = other.y - one.y;
        const squared = dx * dx + dy * dy || 0.01;
        const distance = Math.sqrt(squared);
        const push = repulsion / squared;
        const ux = (dx / distance) * push;
        const uy = (dy / distance) * push;
        one.vx -= ux;
        one.vy -= uy;
        other.vx += ux;
        other.vy += uy;
      }
    }

    // Springs. A stronger tie pulls harder, which is what makes clusters form
    // around the archetype their members actually listen to.
    for (const link of links) {
      const from = placed[link.from] as ForceNode;
      const to = placed[link.to] as ForceNode;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const pull = SPRING * link.weight;
      from.vx += dx * pull;
      from.vy += dy * pull;
      to.vx -= dx * pull;
      to.vy -= dy * pull;
    }

    for (const node of placed) {
      node.vx += (size.width / 2 - node.x) * CENTRE_PULL;
      node.vy += (size.height / 2 - node.y) * CENTRE_PULL;
      node.vx *= DAMPING;
      node.vy *= DAMPING;

      const speed = Math.hypot(node.vx, node.vy);
      if (speed > MAX_SPEED) {
        node.vx = (node.vx / speed) * MAX_SPEED;
        node.vy = (node.vy / speed) * MAX_SPEED;
      }

      node.x += node.vx;
      node.y += node.vy;
      moved += Math.abs(node.vx) + Math.abs(node.vy);

      // Kept on screen. Bouncing rather than clamping, so a node pinned to an
      // edge does not sit there vibrating against it.
      const margin = node.radius + 2;
      if (node.x < margin) {
        node.x = margin;
        node.vx = Math.abs(node.vx) * 0.5;
      }
      if (node.x > size.width - margin) {
        node.x = size.width - margin;
        node.vx = -Math.abs(node.vx) * 0.5;
      }
      if (node.y < margin) {
        node.y = margin;
        node.vy = Math.abs(node.vy) * 0.5;
      }
      if (node.y > size.height - margin) {
        node.y = size.height - margin;
        node.vy = -Math.abs(node.vy) * 0.5;
      }
    }

    movement = moved;
  };

  return {
    nodes: placed,
    links,
    step,
    get drift() {
      return movement / Math.max(1, placed.length);
    },
    get settled() {
      return movement / Math.max(1, placed.length) < SETTLED;
    },
  };
}
