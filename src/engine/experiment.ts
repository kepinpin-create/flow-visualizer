import { erlangC, losslessStations, mmcStations, serversClearOf, trafficRates } from '../analysis/queueing';
import { drawnMean } from './distributions';
import type { ModelSpec } from '../model/types';
import { runReplication, type DistanceFn, type LogEvent, type ReplicationResult } from './simulator';
import { estimate, type Estimate } from './stats';

export interface StationSummary {
  id: string;
  label: string;
  servers: number;
  utilization: Estimate;
  wqMean: Estimate;
  wqP90: Estimate;
  lqMean: Estimate;
  lqMax: Estimate;
  arrivalsPerHour: Estimate;
  bottleneck: boolean;
}

export interface SystemSummary {
  L: Estimate;
  W: Estimate;
  throughputPerHour: Estimate;
  travelMeanM: Estimate;
  balkRate: Estimate;
}

/** FR-24: simulated vs. Erlang-C for one M/M/c station. */
export interface TheoryCheck {
  id: string;
  label: string;
  c: number;
  lambdaPerHour: number;
  muPerHour: number;
  rho: number;
  wq: { simulated: Estimate; analytical: number; errorPct: number };
  lq: { simulated: Estimate; analytical: number; errorPct: number };
  /**
   * match: both errors under 5%. withinCI: a gap of 5% or more, but each
   * analytical value lies inside its simulated 95% CI, so the run is too short to tell.
   * mismatch: the gap is real.
   */
  status: 'match' | 'withinCI' | 'mismatch';
  pass: boolean;
}

/** FR-25: L = λW, checked on the replication means. */
export interface LittleCheck {
  scope: string;
  L: number;
  lambdaW: number;
  errorPct: number;
  pass: boolean;
  /** Set when the check does not apply to this run, with the reason. */
  skipped?: string;
}

export interface Warning {
  blockId?: string;
  message: string;
}

export interface ExperimentResult {
  replications: number;
  stations: StationSummary[];
  system: SystemSummary;
  theory: TheoryCheck[];
  /** M/M/c stations left out of the theory check, with the reason. */
  theorySkipped: string[];
  little: LittleCheck[];
  warnings: Warning[];
  /** Entity steps of the first replication, for the replay. */
  log?: LogEvent[];
  /** Time, minutes, up to which the log is complete (it is cut off on very long runs). */
  logEnd?: number;
}

/** Most entity steps kept for the replay; longer runs are replayed up to this point. */
export const LOG_LIMIT = 300_000;

export interface ExperimentOptions {
  distance?: DistanceFn;
  recordLog?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export const THEORY_TOLERANCE_PCT = 5;
export const LITTLE_TOLERANCE_PCT = 5;

const pctError = (sim: number, ref: number) => (ref === 0 ? (sim === 0 ? 0 : Infinity) : (Math.abs(sim - ref) / ref) * 100);

/** Runs every replication and turns them into KPIs with 95% confidence intervals (FR-19, FR-22–26). */
export function runExperiment(model: ModelSpec, opts: ExperimentOptions = {}): ExperimentResult {
  const reps: ReplicationResult[] = [];
  let log: LogEvent[] | undefined;
  const n = model.run.replications;
  for (let r = 0; r < n; r++) {
    const repLog = opts.recordLog && r === 0 ? [] : undefined;
    reps.push(runReplication(model, { replication: r, distance: opts.distance, log: repLog }));
    if (repLog) log = repLog;
    opts.onProgress?.(r + 1, n);
  }

  const over = (f: (r: ReplicationResult) => number) => estimate(reps.map(f));
  const stations: StationSummary[] = reps[0].stations.map((s, i) => ({
    id: s.id,
    label: s.label,
    servers: s.servers,
    utilization: over((r) => r.stations[i].utilization),
    wqMean: over((r) => r.stations[i].wqMean),
    wqP90: over((r) => r.stations[i].wqP90),
    lqMean: over((r) => r.stations[i].lqMean),
    lqMax: over((r) => r.stations[i].lqMax),
    arrivalsPerHour: over((r) => r.stations[i].arrivalRate * 60),
    bottleneck: false,
  }));
  // FR-23: flag the station with the highest utilization.
  const top = stations.reduce<StationSummary | undefined>(
    (best, s) => (!best || s.utilization.mean > best.utilization.mean ? s : best), undefined);
  if (top) top.bottleneck = true;

  const system: SystemSummary = {
    L: over((r) => r.system.L),
    W: over((r) => r.system.W),
    throughputPerHour: over((r) => r.system.throughputPerHour),
    travelMeanM: over((r) => r.system.travelMeanM),
    balkRate: over((r) => r.system.balkRate),
  };

  // Offered load λ·E[S]/c is exact where no line turns entities away; elsewhere only
  // the simulated value is meaningful. At 1 or more the station never settles.
  const rates = trafficRates(model);
  const lossless = losslessStations(model);
  const offered = new Map<string, number>();
  for (const b of model.blocks) {
    if (b.type === 'server' && lossless.has(b.id)) offered.set(b.id, ((rates.get(b.id) ?? 0) * drawnMean(b.service)) / b.servers);
  }
  const overloaded = new Set([...offered].filter(([, load]) => load >= 1).map(([id]) => id));
  const overloadedNames = stations.filter((s) => overloaded.has(s.id)).map((s) => s.label || s.id).join(', ');
  const clear = serversClearOf(model, overloaded);

  // FR-24: theory check on every M/M/c station.
  const eligible = mmcStations(model);
  const theory: TheoryCheck[] = [];
  const theorySkipped: string[] = [];
  for (const s of stations) {
    if (!eligible.has(s.id)) continue;
    const block = model.blocks.find((b) => b.id === s.id);
    if (block?.type !== 'server') continue;
    if (overloaded.has(s.id)) continue;
    if (!clear.has(s.id)) {
      theorySkipped.push(`${s.label || s.id} is not compared: ${overloadedNames} before it is overloaded, so fewer people get through, and more evenly, than Erlang-C assumes.`);
      continue;
    }
    const lambda = rates.get(s.id) ?? 0;
    const mu = 1 / drawnMean(block.service);
    const q = erlangC(lambda, mu, block.servers);
    if (!Number.isFinite(q.wq)) continue;
    const wqErr = pctError(s.wqMean.mean, q.wq);
    const lqErr = pctError(s.lqMean.mean, q.lq);
    const inside = (e: Estimate, ref: number) => Math.abs(e.mean - ref) <= e.half;
    const status = wqErr < THEORY_TOLERANCE_PCT && lqErr < THEORY_TOLERANCE_PCT
      ? 'match'
      : inside(s.wqMean, q.wq) && inside(s.lqMean, q.lq) ? 'withinCI' : 'mismatch';
    theory.push({
      id: s.id,
      label: s.label,
      c: block.servers,
      lambdaPerHour: lambda * 60,
      muPerHour: mu * 60,
      rho: q.rho,
      wq: { simulated: s.wqMean, analytical: q.wq, errorPct: wqErr },
      lq: { simulated: s.lqMean, analytical: q.lq, errorPct: lqErr },
      status,
      pass: status !== 'mismatch',
    });
  }

  // FR-25: Little's Law for the whole system and for each waiting line.
  const little: LittleCheck[] = [];
  const meanOf = (f: (r: ReplicationResult) => number) => reps.reduce((sum, r) => sum + f(r), 0) / reps.length;
  const sysL = meanOf((r) => r.system.L);
  const sysLW = meanOf((r) => r.system.departureRate) * meanOf((r) => r.system.wAllDepartures);
  const whole = littleCheck('Whole system', sysL, sysLW);
  // L = λW needs a system that settles; with an overloaded station the count keeps climbing.
  if (overloaded.size) whole.skipped = `${overloadedNames} is overloaded, so the number of people keeps growing and L = λW does not apply to the whole system.`;
  little.push(whole);
  reps[0].stations.forEach((s, i) => {
    const L = meanOf((r) => r.stations[i].lqMean);
    const lw = meanOf((r) => r.stations[i].arrivalRate) * meanOf((r) => r.stations[i].wqMean);
    const line = littleCheck(`Line at ${s.label || s.id}`, L, lw);
    // Its waits count only people served before the end, while the line keeps growing.
    if (overloaded.has(s.id)) line.skipped = `${s.label || s.id} is overloaded, so its line keeps growing and L = λW does not apply to it.`;
    little.push(line);
  });

  // FR-26: utilization warnings.
  const warnings: Warning[] = [];
  for (const s of stations) {
    const name = s.label || s.id;
    const load = offered.get(s.id);
    if (load !== undefined && load >= 1) {
      warnings.push({
        blockId: s.id,
        message: `${name} is unstable: work arrives at ${(load * 100).toFixed(0)}% of its capacity, so the line grows for as long as the run lasts.`,
      });
    } else if (Math.max(s.utilization.mean, load ?? 0) >= 0.95) {
      const rho = Math.max(s.utilization.mean, load ?? 0);
      warnings.push({
        blockId: s.id,
        message: `${name} is ${(rho * 100).toFixed(1)}% busy. At ρ ≥ 0.95 queues swing widely and settle slowly, so results depend heavily on run length.`,
      });
    }
  }
  if (model.run.warmupMin < 3 * system.W.mean) {
    warnings.push({
      message: `Warm-up (${model.run.warmupMin} min) is shorter than 3× the mean time in system (${system.W.mean.toFixed(1)} min). The model starts empty, so early waits may be biased low.`,
    });
  }

  let logEnd = model.run.hours * 60;
  if (log && log.length > LOG_LIMIT) {
    // Cut at a time boundary so no moment is half recorded.
    const cut = log[LOG_LIMIT].t;
    log = log.filter((e) => e.t < cut);
    logEnd = cut;
  }

  return { replications: n, stations, system, theory, theorySkipped, little, warnings, log, logEnd };
}

function littleCheck(scope: string, L: number, lambdaW: number): LittleCheck {
  const errorPct = L < 1e-9 && lambdaW < 1e-9 ? 0 : (Math.abs(L - lambdaW) / Math.max(L, lambdaW)) * 100;
  // Lines that are almost always empty pass on a small absolute gap; their % error is all noise.
  const pass = errorPct < LITTLE_TOLERANCE_PCT || Math.abs(L - lambdaW) < 0.01;
  return { scope, L, lambdaW, errorPct, pass };
}
