import type { Block, Link, ModelSpec, QueueBlock, ServerBlock } from '../model/types';
import { DEFAULT_METERS_PER_PIXEL, DEFAULT_TRAVEL_SPEED_MPS } from '../model/types';
import { interarrival, sample } from './distributions';
import { EventQueue } from './heap';
import { createRng, type Rng } from './rng';

/** Walking distance in meters between two blocks. */
export type DistanceFn = (fromId: string, toId: string) => number;

/** Straight-line distance using the plan scale; replaced by wall-aware paths once routing lands. */
export function straightLineDistance(model: ModelSpec): DistanceFn {
  const mpp = model.background?.metersPerPixel ?? DEFAULT_METERS_PER_PIXEL;
  const pos = new Map(model.blocks.map((b) => [b.id, b]));
  return (a, b) => {
    const p = pos.get(a)!;
    const q = pos.get(b)!;
    return Math.hypot(p.x - q.x, p.y - q.y) * mpp;
  };
}

/** One step of an entity's life, for the animated replay. */
export type LogEvent =
  | { t: number; kind: 'create'; entity: number; block: string }
  | { t: number; kind: 'move'; entity: number; from: string; to: string; arriveT: number }
  | { t: number; kind: 'wait'; entity: number; block: string }
  | { t: number; kind: 'start'; entity: number; block: string }
  | { t: number; kind: 'balk'; entity: number; block: string }
  | { t: number; kind: 'exit'; entity: number; block: string };

export interface StationResult {
  id: string;
  label: string;
  servers: number;
  /** Mean fraction of servers busy. */
  utilization: number;
  wqMean: number;
  wqP90: number;
  lqMean: number;
  lqMax: number;
  /** Entities that joined the line or went straight to service, per minute. */
  arrivalRate: number;
  served: number;
  balked: number;
}

export interface SystemResult {
  /** Mean number in system (time average). */
  L: number;
  /** Mean time in system of entities that reached a Sink, minutes. */
  W: number;
  throughputPerHour: number;
  /** Mean walking distance of entities that reached a Sink, meters. */
  travelMeanM: number;
  balkRate: number;
  exits: number;
  arrivals: number;
  /** Little's Law inputs over every departure (Sink or balk). */
  departureRate: number;
  wAllDepartures: number;
}

export interface ReplicationResult {
  stations: StationResult[];
  system: SystemResult;
}

/** A value that changes over time, averaged over the time after warm-up. */
class TimeAverage {
  private value = 0;
  private last = 0;
  private area = 0;
  private start = 0;
  max = 0;

  set(t: number, v: number): void {
    this.area += this.value * (t - this.last);
    this.last = t;
    this.value = v;
    if (v > this.max) this.max = v;
  }

  add(t: number, dv: number): void {
    this.set(t, this.value + dv);
  }

  reset(t: number): void {
    this.set(t, this.value);
    this.area = 0;
    this.start = t;
    this.max = this.value;
  }

  mean(t: number): number {
    this.set(t, this.value);
    return t > this.start ? this.area / (t - this.start) : 0;
  }
}

interface Entity {
  id: number;
  born: number;
  waitStart: number;
  travelM: number;
}

interface Station {
  block: ServerBlock;
  queue?: QueueBlock;
  line: Entity[];
  busy: number;
  busyTA: TimeAverage;
  lineTA: TimeAverage;
  waits: number[];
  entered: number;
  served: number;
  balked: number;
}

type Ev =
  | { kind: 'source'; block: string; count: number }
  | { kind: 'arrive'; entity: Entity; block: string }
  | { kind: 'serviceEnd'; entity: Entity; station: Station }
  | { kind: 'delayEnd'; entity: Entity; block: string }
  | { kind: 'warmupEnd' };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export interface RunOptions {
  /** Replication index; picks the random stream. */
  replication: number;
  distance?: DistanceFn;
  /** When given, every entity step is appended here. */
  log?: LogEvent[];
}

/** Runs one replication of a validated model (FR-18). */
export function runReplication(model: ModelSpec, opts: RunOptions): ReplicationResult {
  const rng: Rng = createRng(model.run.seed, opts.replication);
  const end = model.run.hours * 60;
  const warmup = model.run.warmupMin;
  const distance = opts.distance ?? straightLineDistance(model);
  const metersPerMin = (model.travelSpeedMps ?? DEFAULT_TRAVEL_SPEED_MPS) * 60;
  const log = opts.log;

  const blocks = new Map<string, Block>(model.blocks.map((b) => [b.id, b]));
  const outLinks = new Map<string, Link[]>();
  for (const l of model.links) outLinks.set(l.from, [...(outLinks.get(l.from) ?? []), l]);

  // Each Server is a station; a Queue feeding it configures its waiting line.
  const stations = new Map<string, Station>();
  for (const b of model.blocks) {
    if (b.type === 'server') {
      stations.set(b.id, {
        block: b, line: [], busy: 0, busyTA: new TimeAverage(), lineTA: new TimeAverage(),
        waits: [], entered: 0, served: 0, balked: 0,
      });
    }
  }
  const stationOfQueue = new Map<string, Station>();
  for (const b of model.blocks) {
    if (b.type === 'queue') {
      const st = stations.get(outLinks.get(b.id)![0].to)!;
      st.queue = b;
      stationOfQueue.set(b.id, st);
    }
  }

  const events = new EventQueue<Ev>();
  const inSystem = new TimeAverage();
  let nextId = 0;
  let arrivals = 0;
  let exits = 0;
  let balks = 0;
  let sumW = 0;
  let sumWAll = 0;
  let sumTravel = 0;
  let now = 0;
  const afterWarmup = () => now >= warmup;

  function moveOn(e: Entity, from: string) {
    const links = outLinks.get(from)!;
    let link = links[0];
    if (links.length > 1) {
      let u = rng.next();
      for (const l of links) {
        link = l;
        u -= l.prob ?? 0;
        if (u < 0) break;
      }
    }
    // A Queue sits beside its Server, so stepping from line to service costs no walk.
    const d = blocks.get(from)!.type === 'queue' ? 0 : distance(from, link.to);
    e.travelM += d;
    const arriveT = now + d / metersPerMin;
    log?.push({ t: now, kind: 'move', entity: e.id, from, to: link.to, arriveT });
    events.push(arriveT, { kind: 'arrive', entity: e, block: link.to });
  }

  function depart(e: Entity) {
    inSystem.add(now, -1);
    if (afterWarmup()) sumWAll += now - e.born;
  }

  function startService(st: Station, e: Entity) {
    st.busy++;
    st.busyTA.set(now, st.busy);
    if (afterWarmup()) st.waits.push(now - e.waitStart);
    log?.push({ t: now, kind: 'start', entity: e.id, block: st.block.id });
    events.push(now + sample(st.block.service, rng), { kind: 'serviceEnd', entity: e, station: st });
  }

  function join(st: Station, e: Entity, at: string) {
    e.waitStart = now;
    if (st.busy < st.block.servers && st.line.length === 0) {
      if (afterWarmup()) st.entered++;
      startService(st, e);
      return;
    }
    const q = st.queue;
    const full = q?.capacity !== undefined && st.line.length >= q.capacity;
    const balk = q?.balkThreshold !== undefined && st.line.length >= q.balkThreshold;
    if (full || balk) {
      if (afterWarmup()) {
        st.balked++;
        balks++;
      }
      log?.push({ t: now, kind: 'balk', entity: e.id, block: at });
      depart(e);
      return;
    }
    if (afterWarmup()) st.entered++;
    st.line.push(e);
    st.lineTA.set(now, st.line.length);
    log?.push({ t: now, kind: 'wait', entity: e.id, block: at });
  }

  function arrive(e: Entity, id: string) {
    const b = blocks.get(id)!;
    switch (b.type) {
      case 'queue':
        join(stationOfQueue.get(id)!, e, id);
        break;
      case 'server':
        join(stations.get(id)!, e, id);
        break;
      case 'delay':
        events.push(now + sample(b.time, rng), { kind: 'delayEnd', entity: e, block: id });
        break;
      case 'decision':
        moveOn(e, id);
        break;
      case 'sink':
        log?.push({ t: now, kind: 'exit', entity: e.id, block: id });
        if (afterWarmup()) {
          exits++;
          sumW += now - e.born;
          sumTravel += e.travelM;
        }
        depart(e);
        break;
      default:
        throw new Error(`Entities cannot enter a ${b.type} block`);
    }
  }

  for (const b of model.blocks) {
    if (b.type === 'source') events.push(sample(interarrival(b.arrival), rng), { kind: 'source', block: b.id, count: 0 });
  }
  if (warmup > 0) events.push(warmup, { kind: 'warmupEnd' });

  for (;;) {
    const next = events.pop();
    if (!next || next.t > end) break;
    now = next.t;
    const ev = next.value;
    switch (ev.kind) {
      case 'source': {
        const src = blocks.get(ev.block)!;
        if (src.type !== 'source') break;
        const group = src.groupSize ?? 1;
        let made = ev.count;
        for (let i = 0; i < group && (src.maxArrivals === undefined || made < src.maxArrivals); i++, made++) {
          const e: Entity = { id: nextId++, born: now, waitStart: now, travelM: 0 };
          if (afterWarmup()) arrivals++;
          inSystem.add(now, 1);
          log?.push({ t: now, kind: 'create', entity: e.id, block: src.id });
          moveOn(e, src.id);
        }
        if (src.maxArrivals === undefined || made < src.maxArrivals) {
          events.push(now + sample(interarrival(src.arrival), rng), { kind: 'source', block: src.id, count: made });
        }
        break;
      }
      case 'arrive':
        arrive(ev.entity, ev.block);
        break;
      case 'delayEnd':
        moveOn(ev.entity, ev.block);
        break;
      case 'serviceEnd': {
        const st = ev.station;
        st.busy--;
        st.busyTA.set(now, st.busy);
        if (afterWarmup()) st.served++;
        moveOn(ev.entity, st.block.id);
        if (st.line.length > 0) {
          const e = st.queue?.discipline === 'LIFO' ? st.line.pop()! : st.line.shift()!;
          st.lineTA.set(now, st.line.length);
          startService(st, e);
        }
        break;
      }
      case 'warmupEnd':
        inSystem.reset(now);
        for (const st of stations.values()) {
          st.busyTA.reset(now);
          st.lineTA.reset(now);
        }
        break;
    }
  }

  const span = end - warmup;
  const stationResults: StationResult[] = [...stations.values()].map((st) => {
    const sorted = [...st.waits].sort((a, b) => a - b);
    return {
      id: st.block.id,
      label: st.block.label,
      servers: st.block.servers,
      utilization: st.busyTA.mean(end) / st.block.servers,
      wqMean: sorted.length ? sorted.reduce((s, w) => s + w, 0) / sorted.length : 0,
      wqP90: percentile(sorted, 0.9),
      lqMean: st.lineTA.mean(end),
      lqMax: st.lineTA.max,
      arrivalRate: st.entered / span,
      served: st.served,
      balked: st.balked,
    };
  });
  const departures = exits + balks;
  return {
    stations: stationResults,
    system: {
      L: inSystem.mean(end),
      W: exits ? sumW / exits : 0,
      throughputPerHour: (exits / span) * 60,
      travelMeanM: exits ? sumTravel / exits : 0,
      balkRate: arrivals ? balks / arrivals : 0,
      exits,
      arrivals,
      departureRate: departures / span,
      wAllDepartures: departures ? sumWAll / departures : 0,
    },
  };
}
