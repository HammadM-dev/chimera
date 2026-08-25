import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutOf } from './swarmForce.ts';

// The layout is arithmetic, so it is testable without a canvas.

function population(count: number) {
  return Array.from({ length: count }, (_, at) => ({
    id: `n${String(at)}`,
    influence: 0.5,
    kind: (at < 3 ? 'archetype' : 'follower') as 'archetype' | 'follower',
    follows: at < 3 ? '' : `n${String(at % 3)}`,
  }));
}

const SIZE = { width: 600, height: 400 };

test('a layout settles rather than running forever', () => {
  const nodes = population(40);
  const ties = nodes.slice(3).map((node) => ({ from: node.id, to: node.follows, weight: 0.8 }));
  const layout = layoutOf(nodes, ties, SIZE);

  for (let i = 0; i < 600 && !layout.settled; i += 1) layout.step();

  assert.ok(layout.settled, `expected rest; drift was ${layout.drift.toFixed(4)}`);
});

test('a full-sized population settles too, rather than blowing up', () => {
  // The one that caught the real fault. Every node repels every other, so the
  // force on one grows with the crowd while the timestep does not: at the
  // drawn cap, measured drift went 137, 166, 143, 1039 — diverging, not
  // settling. Repulsion is shared out by population and speed is capped, and
  // this is what holds both in place.
  const nodes = population(320);
  const ties = nodes.slice(3).map((node) => ({ from: node.id, to: node.follows, weight: 0.8 }));
  const layout = layoutOf(nodes, ties, SIZE);

  for (let i = 0; i < 900 && !layout.settled; i += 1) layout.step();

  assert.ok(layout.settled, `expected rest at 320 nodes; drift was ${layout.drift.toFixed(4)}`);
  for (const node of layout.nodes) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), 'a position diverged');
  }
});

test('every node stays on screen', () => {
  // A node that drifts off the canvas is invisible and indistinguishable from
  // one that was never drawn.
  const nodes = population(60);
  const layout = layoutOf(nodes, [], SIZE);

  for (let i = 0; i < 400; i += 1) layout.step();

  for (const node of layout.nodes) {
    assert.ok(node.x >= 0 && node.x <= SIZE.width, `x off screen: ${String(node.x)}`);
    assert.ok(node.y >= 0 && node.y <= SIZE.height, `y off screen: ${String(node.y)}`);
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), 'position went non-finite');
  }
});

test('the same population lays out the same way twice', () => {
  // Reopening a thread has to draw the crowd you remember. Nothing here may
  // depend on Math.random.
  const nodes = population(30);
  const ties = nodes.slice(3).map((node) => ({ from: node.id, to: node.follows, weight: 0.6 }));

  const first = layoutOf(nodes, ties, SIZE);
  const second = layoutOf(nodes, ties, SIZE);
  for (let i = 0; i < 200; i += 1) {
    first.step();
    second.step();
  }

  assert.deepEqual(
    first.nodes.map((node) => `${node.x.toFixed(3)},${node.y.toFixed(3)}`),
    second.nodes.map((node) => `${node.x.toFixed(3)},${node.y.toFixed(3)}`),
  );
});

test('followers gather nearer the archetype they listen to', () => {
  // The structure the picture exists to show. Two archetypes, followers wired
  // to one each; each group should end up closer to its own.
  const nodes = [
    { id: 'a0', influence: 0.9, kind: 'archetype' as const, follows: '' },
    { id: 'a1', influence: 0.9, kind: 'archetype' as const, follows: '' },
    ...Array.from({ length: 10 }, (_, at) => ({
      id: `f${String(at)}`,
      influence: 0.2,
      kind: 'follower' as const,
      follows: at % 2 === 0 ? 'a0' : 'a1',
    })),
  ];
  const ties = nodes.slice(2).map((node) => ({ from: node.id, to: node.follows, weight: 1 }));
  const layout = layoutOf(nodes, ties, SIZE);
  for (let i = 0; i < 800; i += 1) layout.step();

  const at = (id: string) => layout.nodes[nodes.findIndex((node) => node.id === id)];
  const gap = (one: string, other: string) => {
    const a = at(one);
    const b = at(other);
    return Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
  };

  let nearerOwn = 0;
  for (let f = 0; f < 10; f += 1) {
    const own = f % 2 === 0 ? 'a0' : 'a1';
    const other = f % 2 === 0 ? 'a1' : 'a0';
    if (gap(`f${String(f)}`, own) < gap(`f${String(f)}`, other)) nearerOwn += 1;
  }

  assert.ok(nearerOwn >= 8, `expected followers to cluster; ${String(nearerOwn)}/10 did`);
});

test('a tie naming a node that is not drawn is dropped, not crashed on', () => {
  const nodes = population(5);
  const layout = layoutOf(nodes, [{ from: 'n0', to: 'nowhere', weight: 1 }], SIZE);
  assert.equal(layout.links.length, 0);
  layout.step();
});
