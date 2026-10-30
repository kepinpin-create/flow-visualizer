import { describe, expect, it } from 'vitest';
import { runReplication, type LogEvent } from '../src/engine/simulator';
import { Replay } from '../src/replay/replay';
import { computeRoutes, routeDistances } from '../src/routing/pathfinder';
import bar from '../src/templates/bar.json';
import { valid } from './helpers';

const model = valid(bar);
const routes = computeRoutes(model, 1000, 750);
const dist = routeDistances(routes);
const log: LogEvent[] = [];
runReplication(model, { replication: 0, log, distance: (a, b) => dist[`${a}>${b}`] });
const end = model.run.hours * 60;

describe('replay (FR-20)', () => {
  it('never shows more waiting or in service than the model allows', () => {
    const r = new Replay(log, model, routes, end);
    for (let t = 0; t <= end; t += 0.5) {
      const f = r.at(t);
      expect(f.waiting).toBeLessThanOrEqual(10); // bar line capacity
      expect(f.inService).toBeLessThanOrEqual(2); // two bartenders
      expect(f.dots.filter((d) => d.state !== 'balk')).toHaveLength(f.inSystem);
    }
  });

  it('gives the same picture after scrubbing back as when played forward', () => {
    const scrubbed = new Replay(log, model, routes, end);
    scrubbed.at(300);
    const back = scrubbed.at(120);
    const fresh = new Replay(log, model, routes, end).at(120);
    expect(back).toEqual(fresh);
  });

  it('keeps every dot on the plan', () => {
    const r = new Replay(log, model, routes, end);
    for (let t = 0; t <= end; t += 7) {
      for (const d of r.at(t).dots) {
        expect(d.x).toBeGreaterThan(0);
        expect(d.x).toBeLessThan(1000);
        expect(d.y).toBeGreaterThan(0);
        expect(d.y).toBeLessThan(750);
      }
    }
  });

  it('moves walkers along their path over time', () => {
    const first = log.find((e) => e.kind === 'move' && e.arriveT > e.t + 0.05) as Extract<LogEvent, { kind: 'move' }>;
    const r = new Replay(log, model, routes, end);
    const at = (t: number) => r.at(t).dots.find((d) => d.id === first.entity)!;
    const a = at(first.t + 0.001);
    const b = at((first.t + first.arriveT) / 2);
    expect(a.state).toBe('move');
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(1);
  });
});
