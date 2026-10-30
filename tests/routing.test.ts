import { describe, expect, it } from 'vitest';
import { buildGrid, computeRoutes, findRoute, routeKey } from '../src/routing/pathfinder';
import type { ModelSpec, Point } from '../src/model/types';
import bar from '../src/templates/bar.json';
import { valid } from './helpers';

const MPP = 0.02; // 50 px per meter
const room = (walls: Point[][]): ModelSpec => ({
  version: '0.1', entityLabel: 'x', blocks: [], links: [], walls,
  background: { file: '', metersPerPixel: MPP }, run: { hours: 1, warmupMin: 0, replications: 2, seed: 1 },
});

/** True when segments p1–p2 and q1–q2 cross. */
function crosses([p1, p2]: Point[], [q1, q2]: Point[]): boolean {
  const d = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return d(p1, p2, q1) * d(p1, p2, q2) < 0 && d(q1, q2, p1) * d(q1, q2, p2) < 0;
}

describe('walking paths (FR-16)', () => {
  it('walks straight across an open floor', () => {
    const g = buildGrid(room([]), 1000, 600);
    const r = findRoute(g, [100, 300], [900, 300], MPP);
    expect(r.points).toHaveLength(2);
    expect(r.meters).toBeCloseTo(16, 6);
  });

  it('goes around a wall through the door gap', () => {
    // A wall across the room at x = 500 with a 1.5 m (75 px) door near the bottom.
    const wall: Point[] = [[500, 0], [500, 500]];
    const g = buildGrid(room([wall]), 1000, 600);
    const r = findRoute(g, [100, 100], [900, 100], MPP);
    expect(r.noPath).toBe(false);
    // The shortest way is two diagonal legs via the end of the wall: 2 × hypot(400, 400) px ≈ 22.6 m.
    expect(r.meters).toBeGreaterThan(22.6);
    expect(r.meters).toBeLessThan(25);
    expect(Math.max(...r.points.map(([, y]) => y))).toBeGreaterThan(500);
    for (let i = 1; i < r.points.length; i++) {
      expect(crosses([r.points[i - 1], r.points[i]], wall)).toBe(false);
    }
    // Smoothing leaves a few straight legs, not a staircase of cells.
    expect(r.points.length).toBeLessThanOrEqual(6);
  });

  it('reports when walls leave no way through', () => {
    const box: Point[] = [[300, 200], [700, 200], [700, 400], [300, 400], [300, 200]];
    const g = buildGrid(room([box]), 1000, 600);
    const r = findRoute(g, [500, 300], [900, 300], MPP);
    expect(r.noPath).toBe(true);
    expect(r.points).toHaveLength(2);
  });

  it('gives every link of the bar a route, with no walk from line to bartender', () => {
    const m = valid(bar);
    const routes = computeRoutes(m, 1000, 750);
    expect(routes.size).toBe(m.links.length);
    expect(routes.get(routeKey('bar_queue', 'bar'))!.meters).toBe(0);
    expect(routes.get(routeKey('door', 'split'))!.meters).toBeGreaterThan(0);
  });

  it('changes when a block moves (FR-17 recomputes from the model)', () => {
    const m = valid(bar);
    const before = computeRoutes(m, 1000, 750).get(routeKey('bar', 'seats'))!.meters;
    m.blocks.find((b) => b.id === 'seats')!.x = 850;
    const after = computeRoutes(m, 1000, 750).get(routeKey('bar', 'seats'))!.meters;
    expect(after).not.toBeCloseTo(before, 3);
  });
});
