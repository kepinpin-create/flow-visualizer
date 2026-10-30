/** Mean with a 95% confidence half-width across replications. */
export interface Estimate {
  mean: number;
  half: number;
}

// Two-sided 95% Student-t quantiles for 1..30 degrees of freedom.
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
  2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

export function t95(df: number): number {
  if (df <= 0) return NaN;
  if (df <= 30) return T95[df - 1];
  if (df <= 60) return 2.042 - ((df - 30) / 30) * (2.042 - 2.0);
  if (df <= 120) return 2.0 - ((df - 60) / 60) * (2.0 - 1.98);
  return 1.96;
}

export function estimate(values: number[]): Estimate {
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (n < 2) return { mean, half: NaN };
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return { mean, half: t95(n - 1) * Math.sqrt(variance / n) };
}
