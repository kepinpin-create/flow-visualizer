import { describe, expect, it } from 'vitest';
import { erlangC, mmcStations, trafficRates } from '../src/analysis/queueing';
import bar from '../src/templates/bar.json';
import { valid } from './helpers';

describe('erlangC', () => {
  it('matches the textbook M/M/1 result', () => {
    // λ = 0.8/min, μ = 1/min: Wq = ρ/(μ-λ) = 4, Lq = 3.2
    const q = erlangC(0.8, 1, 1);
    expect(q.wq).toBeCloseTo(4, 10);
    expect(q.lq).toBeCloseTo(3.2, 10);
  });

  it('matches a hand-worked M/M/3', () => {
    // λ = 30/h, μ = 15/h per teller: a = 2, C(3, 2) = 4/9, Wq = (4/9)/(45-30) h
    const q = erlangC(0.5, 0.25, 3);
    expect(q.pWait).toBeCloseTo(4 / 9, 10);
    expect(q.wq).toBeCloseTo((4 / 9 / 15) * 60, 10);
    expect(q.lq).toBeCloseTo(8 / 9, 10);
  });

  it('reports an unstable station', () => {
    expect(erlangC(1, 0.5, 2).wq).toBe(Infinity);
  });
});

describe('traffic equations and eligibility', () => {
  const model = valid(bar);

  it('splits flow by decision probabilities', () => {
    const r = trafficRates(model);
    expect(r.get('bar')! * 60).toBeCloseTo(32, 6);
    expect(r.get('seats')! * 60).toBeCloseTo(40, 6);
  });

  it('excludes a server whose line has a capacity', () => {
    expect(mmcStations(model).has('bar')).toBe(false);
  });
});
