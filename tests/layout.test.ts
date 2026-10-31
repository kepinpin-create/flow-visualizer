import { describe, expect, it } from 'vitest';
import { spotProblem } from '../src/ai/placement';
import { linkFlows, optimizeLayout, walkingLoad } from '../src/layout/optimize';
import { computeRoutes, routeDistances, routeKey } from '../src/routing/pathfinder';
import bar from '../src/templates/bar.json';
import { valid } from './helpers';

// Bar: 40 arrivals/h, 80% order at the bar, 20% go straight to the seats; everyone sits, then leaves.
const model = valid(bar);

describe('flow per path', () => {
  it('follows the arrival rate and the decision split', () => {
    const f = linkFlows(model);
    expect(f.get(routeKey('door', 'split'))).toBeCloseTo(40, 6);
    expect(f.get(routeKey('split', 'bar_queue'))).toBeCloseTo(32, 6);
    expect(f.get(routeKey('split', 'seats'))).toBeCloseTo(8, 6);
    expect(f.get(routeKey('seats', 'exit'))).toBeCloseTo(40, 6);
  });

  it('weights each walking distance by how many people walk it', () => {
    const d = routeDistances(computeRoutes(model, 1000, 750));
    const f = linkFlows(model);
    const manual = [...f].reduce((s, [k, v]) => s + v * (d[k] ?? 0), 0);
    expect(walkingLoad(f, d)).toBeCloseTo(manual, 6);
  });
});

describe('optimize layout', () => {
  const result = optimizeLayout(model, { timeBudgetMs: 5000 });
  const moved = (id: string) => result.model.blocks.find((b) => b.id === id)!;

  it('lowers the walking load', () => {
    expect(result.moves.length).toBeGreaterThan(0);
    expect(result.after).toBeLessThan(result.before);
    // Cross-check with full paths computed from scratch.
    const d = routeDistances(computeRoutes(result.model, 1000, 750));
    expect(walkingLoad(linkFlows(model), d)).toBeCloseTo(result.after, 3);
  });

  it('never moves fixed blocks or the split point', () => {
    for (const id of ['door', 'exit', 'split']) {
      const b = model.blocks.find((x) => x.id === id)!;
      expect([moved(id).x, moved(id).y]).toEqual([b.x, b.y]);
    }
  });

  it('keeps a queue beside its server', () => {
    const dx = moved('bar').x - moved('bar_queue').x;
    const dy = moved('bar').y - moved('bar_queue').y;
    const q = model.blocks.find((b) => b.id === 'bar_queue')!;
    const s = model.blocks.find((b) => b.id === 'bar')!;
    expect([dx, dy]).toEqual([s.x - q.x, s.y - q.y]);
  });

  it('puts every moved block in a legal spot', () => {
    for (const m of result.moves) {
      const b = moved(m.id);
      const others = { ...result.model, blocks: result.model.blocks.filter((x) => !(x.id === 'bar_queue' && m.id === 'bar') && !(x.id === 'bar' && m.id === 'bar_queue')) };
      expect(spotProblem(others, b, b.x, b.y)).toBeNull();
    }
  });

  it('still counts walkers when the entrance has a "max arrivals" cap', () => {
    // 40/h for 8 h would be 320 people; a cap of 50 means about 6.25/h on average over the run.
    const capped = valid({ ...bar, blocks: bar.blocks.map((b) => (b.type === 'source' ? { ...b, maxArrivals: 50 } : b)) });
    expect(linkFlows(capped).get(routeKey('door', 'split'))).toBeCloseTo(50 / 8, 6);
    const r = optimizeLayout(capped);
    expect(r.before).toBeGreaterThan(0);
    expect(r.moves.length).toBeGreaterThan(0);
  });

  it('reports no moves when everything is fixed', () => {
    const locked = { ...model, blocks: model.blocks.map((b) => ({ ...b, fixed: true })) };
    expect(optimizeLayout(locked).moves).toHaveLength(0);
  });
});

describe('optimize layout keeps blocks in their room', () => {
  // A 20 x 12 m building split by a wall at x = 10 m with a 1.2 m doorway; the counter is in the right room.
  const W = 1000;
  const H = 600;
  const twoRooms = valid({
    version: '0.1', entityLabel: 'customer',
    background: { file: '', metersPerPixel: 0.02, width: W, height: H },
    walls: [
      [[0, 0], [W, 0], [W, H], [0, H], [0, 0]],
      [[500, 0], [500, 270]], [[500, 330], [500, H]], // the inner wall, with a 60 px (1.2 m) doorway
    ],
    blocks: [
      { id: 'in', type: 'source', label: 'Entrance', x: 40, y: 300, arrival: { dist: 'exponential', ratePerHour: 30 } },
      { id: 'desk', type: 'server', label: 'Desk', x: 900, y: 500, servers: 2, service: { dist: 'exponential', meanMin: 3 } },
      { id: 'out', type: 'sink', label: 'Exit', x: 40, y: 360 },
    ],
    links: [{ from: 'in', to: 'desk' }, { from: 'desk', to: 'out' }],
    run: { hours: 4, warmupMin: 30, replications: 5, seed: 1 },
  });

  it('finds the two rooms through the doorway', async () => {
    const { findRooms } = await import('../src/layout/rooms');
    const rooms = findRooms(twoRooms, W, H);
    expect(rooms.at(250, 300)).not.toBe(rooms.at(750, 300));
    expect(rooms.at(250, 100)).toBe(rooms.at(250, 500));
  });

  it('never moves the desk into the room with the entrance, and never more than 6 m', () => {
    const r = optimizeLayout(twoRooms);
    const desk = r.model.blocks.find((b) => b.id === 'desk')!;
    expect(desk.x).toBeGreaterThan(500); // still right of the inner wall
    for (const m of r.moves) expect(m.movedM).toBeLessThanOrEqual(6.01);
    expect(r.after).toBeLessThanOrEqual(r.before);
  });
});
