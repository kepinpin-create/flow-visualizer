import type { Arrival, Distribution } from '../model/types';
import type { Rng } from './rng';

/** Draws one value, in minutes, from a distribution (FR-12). Never negative. */
export function sample(d: Distribution, rng: Rng): number {
  switch (d.dist) {
    case 'fixed':
      return d.valueMin;
    case 'exponential':
      return -d.meanMin * Math.log(1 - rng.next());
    case 'uniform':
      return d.min + (d.max - d.min) * rng.next();
    case 'triangular': {
      const { min, mode, max } = d;
      if (max === min) return min;
      const u = rng.next();
      const f = (mode - min) / (max - min);
      return u < f
        ? min + Math.sqrt(u * (max - min) * (mode - min))
        : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
    }
    case 'normal': {
      // Box-Muller, truncated at zero by redrawing.
      for (let i = 0; i < 100; i++) {
        const u1 = 1 - rng.next();
        const u2 = rng.next();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const x = d.meanMin + d.sdMin * z;
        if (x >= 0) return x;
      }
      return 0;
    }
  }
}

export function mean(d: Distribution): number {
  switch (d.dist) {
    case 'fixed':
      return d.valueMin;
    case 'exponential':
    case 'normal':
      return d.meanMin;
    case 'uniform':
      return (d.min + d.max) / 2;
    case 'triangular':
      return (d.min + d.mode + d.max) / 3;
  }
}

/** The inter-arrival time distribution behind a Source's arrival setting. */
export function interarrival(a: Arrival): Distribution {
  if ('ratePerHour' in a) {
    const m = 60 / a.ratePerHour;
    return a.dist === 'fixed' ? { dist: 'fixed', valueMin: m } : { dist: 'exponential', meanMin: m };
  }
  return a;
}

export function isExponential(d: Distribution): boolean {
  return d.dist === 'exponential';
}
