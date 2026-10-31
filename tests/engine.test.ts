import { describe, expect, it } from 'vitest';
import { drawnMean } from '../src/engine/distributions';
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

  it('warns that a 90%-busy line needs a longer warm-up, and says how long', () => {
    // Settling time 1 / (μ(1 − √0.9)²) ≈ 380 min; with 60 min the waits read about 16% low.
    const res = runExperiment(mmc(54, 1, 1, { hours: 8, warmupMin: 60, replications: 5, seed: 1 }));
    expect(res.warnings.map((w) => w.message).join('\n')).toMatch(/too short for Server \(90% busy\).*at least 380 min/);
  });

  it('stays quiet about warm-up for the bank example', () => {
    const res = runExperiment(valid(bank));
    expect(res.warnings.filter((w) => w.message.startsWith('Warm-up'))).toHaveLength(0);
  });

  it('warns when a station is unstable', () => {
    const res = runExperiment(mmc(70, 1, 1, { hours: 50, warmupMin: 60, replications: 3, seed: 1 }));
    expect(res.warnings.some((w) => w.message.includes('unstable'))).toBe(true);
    expect(res.theory).toHaveLength(0);
  });
});

describe('checks behind an overloaded station', () => {
  // Entrance → kiosk at 100% load → half go on to a loan desk at 50% load.
  const res = runExperiment(valid({
    version: '0.1', entityLabel: 'customer',
    blocks: [
      { id: 'in', type: 'source', label: 'In', x: 0, y: 0, arrival: { dist: 'exponential', ratePerHour: 15 } },
      { id: 'kiosk', type: 'server', label: 'Kiosk', x: 1, y: 0, servers: 1, service: { dist: 'exponential', meanMin: 4 } },
      { id: 'split', type: 'decision', label: 'Loan?', x: 2, y: 0 },
      { id: 'loan', type: 'server', label: 'Loan desk', x: 3, y: 0, servers: 1, service: { dist: 'exponential', meanMin: 4 } },
      { id: 'out', type: 'sink', label: 'Out', x: 4, y: 0 },
    ],
    links: [
      { from: 'in', to: 'kiosk' }, { from: 'kiosk', to: 'split' },
      { from: 'split', to: 'loan', prob: 0.5 }, { from: 'split', to: 'out', prob: 0.5 }, { from: 'loan', to: 'out' },
    ],
    run: { hours: 8, warmupMin: 1, replications: 30, seed: 7 },
  }));

  it('does not compare a station after it with Erlang-C, and says why', () => {
    expect(res.theory).toHaveLength(0);
    expect(res.theorySkipped).toHaveLength(1);
    expect(res.theorySkipped[0]).toMatch(/Loan desk.*Kiosk before it is overloaded/);
  });

  it('marks whole-system Little\'s Law as not applicable instead of failing it', () => {
    const whole = res.little.find((l) => l.scope === 'Whole system')!;
    expect(whole.skipped).toMatch(/Kiosk is overloaded/);
    expect(res.little.filter((l) => l.skipped).map((l) => l.scope)).toEqual(['Whole system', 'Line at Kiosk']);
  });
});

describe('a normal time cut off at zero', () => {
  const desk = (ratePerHour: number) => valid({
    version: '0.1', entityLabel: 'customer',
    blocks: [
      { id: 'in', type: 'source', label: 'In', x: 0, y: 0, arrival: { dist: 'exponential', ratePerHour } },
      { id: 'desk', type: 'server', label: 'Desk', x: 1, y: 0, servers: 1, service: { dist: 'normal', meanMin: 4, sdMin: 4 } },
      { id: 'out', type: 'sink', label: 'Out', x: 2, y: 0 },
    ],
    links: [{ from: 'in', to: 'desk' }, { from: 'desk', to: 'out' }],
    run: { hours: 200, warmupMin: 120, replications: 5, seed: 3 },
  });

  it('averages what the simulator actually draws', () => {
    expect(drawnMean({ dist: 'normal', meanMin: 4, sdMin: 4 })).toBeCloseTo(5.15, 2);
    expect(drawnMean({ dist: 'normal', meanMin: 4, sdMin: 0 })).toBe(4);
    // 8/h at 5.15 min each keeps one desk 69% busy, not the 53% the typed mean suggests.
    expect(runExperiment(desk(8)).stations[0].utilization.mean).toBeCloseTo((8 * 5.15) / 60, 1);
  });

  it('calls a desk unstable when the real average overloads it', () => {
    // Typed mean: 13 × 4 / 60 = 87%. Real: 13 × 5.15 / 60 = 112%.
    expect(runExperiment(desk(13)).warnings.some((w) => w.message.includes('unstable'))).toBe(true);
  });
});
