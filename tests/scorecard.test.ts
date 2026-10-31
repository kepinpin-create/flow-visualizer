import { describe, expect, it } from 'vitest';
import { planAdvice } from '../src/layout/advice';
import { scoreLayout } from '../src/layout/scorecard';
import { runExperiment } from '../src/engine/experiment';
import type { ModelSpec } from '../src/model/types';
import { computeRoutes } from '../src/routing/pathfinder';
import { valid } from './helpers';

const run = { hours: 8, warmupMin: 60, replications: 10, seed: 3 };
const bg = { file: '', metersPerPixel: 0.02, width: 1500, height: 1000 };
const score = (m: ModelSpec) => scoreLayout(m, computeRoutes(m, bg.width, bg.height), runExperiment(m));
const crit = (m: ModelSpec, id: string) => score(m).criteria.find((c) => c.id === id)!;

/** Entrance → line → counter → exit, with the line and counter where we put them. */
function bank(opts: { queue: [number, number]; queueW: number; counter: [number, number]; rate?: number; walls?: ModelSpec['walls'] }) {
  return valid({
    version: '0.1', entityLabel: 'customer', background: bg, walls: opts.walls ?? [],
    blocks: [
      { id: 'in', type: 'source', label: 'Entrance', x: 100, y: 500, arrival: { dist: 'exponential', ratePerHour: opts.rate ?? 40 } },
      { id: 'line', type: 'queue', label: 'Line', x: opts.queue[0], y: opts.queue[1], w: opts.queueW, h: 1 },
      { id: 'tellers', type: 'server', label: 'Tellers', x: opts.counter[0], y: opts.counter[1], servers: 3, service: { dist: 'exponential', meanMin: 4 } },
      { id: 'out', type: 'sink', label: 'Exit', x: 1400, y: 500 },
    ],
    links: [{ from: 'in', to: 'line' }, { from: 'line', to: 'tellers' }, { from: 'tellers', to: 'out' }],
    run,
  });
}

describe('layout scorecard', () => {
  it('flags a waiting line too short for its peak, and passes a long one', () => {
    const short = crit(bank({ queue: [600, 500], queueW: 1, counter: [800, 500] }), 'queues');
    expect(short.grade).not.toBe('good');
    expect(short.markers[0].kind).toBe('overflow');
    expect(crit(bank({ queue: [500, 500], queueW: 12, counter: [1100, 500] }), 'queues').grade).toBe('good');
  });

  it('flags a line that reaches the entrance at its peak', () => {
    // A short line right next to the entrance, with the counter on the far side: it spills back toward the door.
    const doors = crit(bank({ queue: [230, 500], queueW: 1, counter: [400, 500] }), 'doors');
    expect(doors.grade).not.toBe('good');
    expect(doors.markers[0].kind).toBe('door');
  });

  it('flags walking back the way you came', () => {
    // The counter sits behind the entrance's line, so people turn around at it to reach the exit... placed on the far left.
    const m = valid({
      version: '0.1', entityLabel: 'customer', background: bg,
      blocks: [
        { id: 'in', type: 'source', label: 'Entrance', x: 100, y: 500, arrival: { dist: 'exponential', ratePerHour: 30 } },
        { id: 'desk', type: 'server', label: 'Desk', x: 1300, y: 500, servers: 2, service: { dist: 'exponential', meanMin: 2 } },
        { id: 'out', type: 'sink', label: 'Exit', x: 150, y: 520 },
      ],
      links: [{ from: 'in', to: 'desk' }, { from: 'desk', to: 'out' }],
      run,
    });
    const order = crit(m, 'order');
    expect(order.grade).toBe('poor');
    expect(order.markers[0].kind).toBe('uturn');
  });

  it('flags busy paths that cross', () => {
    const m = valid({
      version: '0.1', entityLabel: 'customer', background: bg,
      blocks: [
        { id: 'in', type: 'source', label: 'Entrance', x: 100, y: 100, arrival: { dist: 'exponential', ratePerHour: 30 } },
        { id: 'split', type: 'decision', label: 'Split', x: 150, y: 500 },
        { id: 'a', type: 'server', label: 'A', x: 1300, y: 900, servers: 2, service: { dist: 'exponential', meanMin: 2 } },
        { id: 'b', type: 'server', label: 'B', x: 1300, y: 100, servers: 2, service: { dist: 'exponential', meanMin: 2 } },
        { id: 'outA', type: 'sink', label: 'Exit A', x: 700, y: 100 },
        { id: 'outB', type: 'sink', label: 'Exit B', x: 700, y: 900 },
      ],
      links: [
        { from: 'in', to: 'split' }, { from: 'split', to: 'a', prob: 0.5 }, { from: 'split', to: 'b', prob: 0.5 },
        { from: 'a', to: 'outA' }, { from: 'b', to: 'outB' },
      ],
      run,
    });
    const c = crit(m, 'crossings');
    expect(c.grade).not.toBe('good');
    expect(c.markers.length).toBeGreaterThan(0);
  });

  it('reports walls as detours', () => {
    const open = crit(bank({ queue: [500, 500], queueW: 12, counter: [1100, 500] }), 'walking');
    const walled = crit(bank({ queue: [500, 500], queueW: 12, counter: [1100, 500], walls: [[[300, 0], [300, 900]]] }), 'walking');
    expect(open.grade).toBe('good');
    expect(walled.detail).toMatch(/\d+% longer/);
  });
});

describe('applying AI layout advice', () => {
  const m = bank({ queue: [600, 500], queueW: 1, counter: [800, 500] });

  it('lengthens a line and keeps it beside its counter', () => {
    const p = planAdvice(m, { title: 't', why: '', moves: [], resizes: [{ blockId: 'line', widthM: 5, depthM: 1 }] });
    expect(p.ok).toBe(true);
    expect(p.model.blocks.find((b) => b.id === 'line')!.w).toBe(5);
    expect(crit(p.model, 'queues').markers.length).toBeLessThanOrEqual(crit(m, 'queues').markers.length);
  });

  it('refuses a size that runs into the counter, and an unknown block', () => {
    const tooBig = planAdvice(m, { title: 't', why: '', moves: [], resizes: [{ blockId: 'line', widthM: 30, depthM: 1 }] });
    expect(tooBig.ok).toBe(false);
    expect(planAdvice(m, { title: 't', why: '', moves: [{ blockId: 'ghost', xM: 5, yM: 5 }], resizes: [] }).ok).toBe(false);
  });

  it('never moves a fixed block', () => {
    const p = planAdvice(m, { title: 't', why: '', moves: [{ blockId: 'in', xM: 10, yM: 10 }], resizes: [] });
    expect(p.ok).toBe(false);
    expect(p.changes[0].problem).toMatch(/fixed in place/);
  });
});
