import { interarrival, isExponential, mean } from '../engine/distributions';
import type { Block, ModelSpec } from '../model/types';

/** Erlang-C results for an M/M/c station; rates per minute, times in minutes. */
export interface MMc {
  lambda: number;
  mu: number;
  c: number;
  rho: number;
  /** Probability an arrival has to wait. */
  pWait: number;
  wq: number;
  lq: number;
}

export function erlangC(lambda: number, mu: number, c: number): MMc {
  const a = lambda / mu;
  const rho = a / c;
  if (rho >= 1) return { lambda, mu, c, rho, pWait: 1, wq: Infinity, lq: Infinity };
  // Erlang-B by recursion (stable for large c), then convert to Erlang-C.
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  const pWait = b / (1 - rho * (1 - b));
  const wq = pWait / (c * mu - lambda);
  return { lambda, mu, c, rho, pWait, wq, lq: lambda * wq };
}

/**
 * Long-run arrival rate (per minute) into every block, from the traffic
 * equations λ = λ0 + λP. Ignores balking and finite queues.
 */
export function trafficRates(model: ModelSpec): Map<string, number> {
  const external = new Map<string, number>();
  for (const b of model.blocks) {
    if (b.type === 'source' && b.maxArrivals === undefined) {
      external.set(b.id, (b.groupSize ?? 1) / mean(interarrival(b.arrival)));
    }
  }
  let rates = new Map(model.blocks.map((b) => [b.id, external.get(b.id) ?? 0]));
  for (let iter = 0; iter < 10000; iter++) {
    const next = new Map(model.blocks.map((b) => [b.id, external.get(b.id) ?? 0]));
    for (const l of model.links) {
      next.set(l.to, next.get(l.to)! + rates.get(l.from)! * (l.prob ?? 1));
    }
    let diff = 0;
    for (const [id, v] of next) diff = Math.max(diff, Math.abs(v - rates.get(id)!));
    rates = next;
    if (diff < 1e-12) break;
  }
  return rates;
}

/** Servers for which `ok` holds on the server itself and on every block upstream of it. */
function serversWhereUpstream(model: ModelSpec, ok: (b: Block) => boolean): Set<string> {
  const byId = new Map<string, Block>(model.blocks.map((b) => [b.id, b]));
  const into = new Map<string, string[]>();
  for (const l of model.links) into.set(l.to, [...(into.get(l.to) ?? []), l.from]);

  const result = new Set<string>();
  for (const b of model.blocks) {
    if (b.type !== 'server' || !ok(b)) continue;
    const seen = new Set<string>([b.id]);
    const stack = [b.id];
    let all = true;
    while (stack.length && all) {
      for (const up of into.get(stack.pop()!) ?? []) {
        if (seen.has(up)) continue;
        seen.add(up);
        if (!ok(byId.get(up)!)) all = false;
        stack.push(up);
      }
    }
    if (all) result.add(b.id);
  }
  return result;
}

const losesNothing = (b: Block) => b.type !== 'queue' || (b.capacity === undefined && b.balkThreshold === undefined);

/**
 * Servers that no full or balking line sits in front of, so the traffic
 * equations give their true arrival rate and offered load.
 */
export function losslessStations(model: ModelSpec): Set<string> {
  return serversWhereUpstream(model, losesNothing);
}

/**
 * Servers whose inputs are Poisson and service is exponential, with an
 * unlimited FIFO line: the stations queuing theory can check exactly.
 * Holds for open Jackson networks (random routing, Poisson sources, M/G/∞ delays).
 */
export function mmcStations(model: ModelSpec): Set<string> {
  return serversWhereUpstream(model, (b) => {
    switch (b.type) {
      case 'source':
        return isExponential(interarrival(b.arrival)) && (b.groupSize ?? 1) === 1 && b.maxArrivals === undefined;
      case 'server':
        return isExponential(b.service);
      case 'queue':
        return losesNothing(b) && b.discipline !== 'LIFO';
      default:
        return true;
    }
  });
}
