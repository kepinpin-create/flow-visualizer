import { describe, expect, it } from 'vitest';
import { runExperiment } from '../src/engine/experiment';
import { runReplication, type LogEvent } from '../src/engine/simulator';
import bank from '../src/templates/bank.json';
import bar from '../src/templates/bar.json';
import { mmc, valid } from './helpers';

const longRun = { hours: 2000, warmupMin: 600, replications: 10, seed: 7 };

describe('determinism (FR-18)', () => {
  it('gives identical results for the same seed', () => {
    const m = valid(bank);
    expect(runReplication(m, { replication: 3 })).toEqual(runReplication(m, { replication: 3 }));
  });

  it('gives different results for another replication or seed', () => {
    const m = valid(bank);
    const a = runReplication(m, { replication: 0 }).system.W;
    expect(runReplication(m, { replication: 1 }).system.W).not.toBe(a);
    expect(runReplication({ ...m, run: { ...m.run, seed: 43 } }, { replication: 0 }).system.W).not.toBe(a);
  });
});

describe('M/M/c benchmarks: simulated vs. analytical under 5%', () => {
  const cases: [string, number, number, number][] = [
    ['M/M/1 at ρ = 0.8', 48, 1, 1],
    ['M/M/3 bank at ρ = 0.67', 30, 4, 3],
    ['M/M/5 at ρ = 0.9', 45, 6, 5],
  ];
  for (const [name, rate, service, c] of cases) {
    it(name, () => {
      const res = runExperiment(mmc(rate, service, c, longRun));
      expect(res.theory).toHaveLength(1);
      const t = res.theory[0];
      expect(t.wq.errorPct).toBeLessThan(5);
      expect(t.lq.errorPct).toBeLessThan(5);
      expect(t.status).toBe('match');
      expect(res.stations[0].utilization.mean).toBeCloseTo(t.rho, 1);
    });
  }

  it('holds on a Jackson network with a split', () => {
    const model = valid({
      version: '0.1',
      entityLabel: 'part',
      blocks: [
        { id: 'in', type: 'source', label: 'In', x: 0, y: 0, arrival: { dist: 'exponential', ratePerHour: 30 } },
        { id: 'a', type: 'server', label: 'A', x: 1, y: 0, servers: 1, service: { dist: 'exponential', meanMin: 1.5 } },
        { id: 'd', type: 'decision', label: 'Split', x: 2, y: 0 },
        { id: 'b', type: 'server', label: 'B', x: 3, y: 0, servers: 2, service: { dist: 'exponential', meanMin: 6 } },
        { id: 'out', type: 'sink', label: 'Out', x: 4, y: 0 },
      ],
      links: [
        { from: 'in', to: 'a' },
        { from: 'a', to: 'd' },
        { from: 'd', to: 'b', prob: 0.5 },
        { from: 'd', to: 'out', prob: 0.5 },
        { from: 'b', to: 'out' },
      ],
      run: longRun,
    });
    const res = runExperiment(model);
    expect(res.theory.map((t) => t.id).sort()).toEqual(['a', 'b']);
    for (const t of res.theory) expect(t.status, `${t.id}: Wq ${t.wq.errorPct}%, Lq ${t.lq.errorPct}%`).toBe('match');
  });

  it('never calls the bank template at its default settings a mismatch', () => {
    const res = runExperiment(valid(bank));
    expect(res.theory[0].status).not.toBe('mismatch');
  });
});

describe("Little's Law (FR-25)", () => {
  it('passes on the bank template at its default settings', () => {
    const res = runExperiment(valid(bank));
    for (const l of res.little) expect(l.pass, `${l.scope}: ${l.errorPct}%`).toBe(true);
  });

  it('passes on the bar template, which has balking', () => {
    const res = runExperiment(valid(bar));
    for (const l of res.little) expect(l.pass, `${l.scope}: ${l.errorPct}%`).toBe(true);
  });
});

describe('bar template', () => {
  const res = runExperiment(valid(bar), { recordLog: true });

  it('never lets the line pass its capacity', () => {
    expect(res.stations[0].lqMax.mean).toBeLessThanOrEqual(10);
  });

  it('flags the bartenders as the bottleneck and reports confidence intervals', () => {
    expect(res.stations[0].bottleneck).toBe(true);
    expect(res.system.W.half).toBeGreaterThan(0);
    expect(res.system.travelMeanM.mean).toBeGreaterThan(0);
  });

  it('warns that 30 minutes of warm-up is short', () => {
    expect(res.warnings.some((w) => w.message.startsWith('Warm-up'))).toBe(true);
  });

  it('records a replay log in time order', () => {
    const log = res.log as LogEvent[];
    expect(log.length).toBeGreaterThan(0);
    for (let i = 1; i < log.length; i++) expect(log[i].t).toBeGreaterThanOrEqual(log[i - 1].t);
  });
});

describe('warnings (FR-26)', () => {
  it('warns when utilization reaches 0.95', () => {
    const res = runExperiment(mmc(57.5, 1, 1, { hours: 200, warmupMin: 600, replications: 5, seed: 1 }));
    expect(res.warnings.some((w) => w.message.includes('busy'))).toBe(true);
  });

  it('warns when a station is unstable', () => {
    const res = runExperiment(mmc(70, 1, 1, { hours: 50, warmupMin: 60, replications: 3, seed: 1 }));
    expect(res.warnings.some((w) => w.message.includes('unstable'))).toBe(true);
    expect(res.theory).toHaveLength(0);
  });
});
