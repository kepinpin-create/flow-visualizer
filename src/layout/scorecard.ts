// Layout scorecard: grades a layout on qualities measured from the model and the simulation,
// not guessed: flow order, crossing paths, queue space at the daily peak, doors kept clear,
// and walking with its detours. Each grade comes with a plain reason and spots on the plan.
import { BLOCK_STYLES, metersPerPixel } from '../editor/blocks';
import type { ExperimentResult } from '../engine/experiment';
import type { Block, ModelSpec, Point } from '../model/types';
import { routeKey, type Route } from '../routing/pathfinder';
import { linkFlows } from './optimize';

export type Grade = 'good' | 'fair' | 'poor';
export type MarkerKind = 'crossing' | 'overflow' | 'door' | 'uturn';

export interface Marker {
  x: number;
  y: number;
  kind: MarkerKind;
  text: string;
}

export interface Criterion {
  id: 'order' | 'crossings' | 'queues' | 'doors' | 'walking';
  label: string;
  grade: Grade;
  /** One or two plain sentences: what was measured and why the grade. */
  detail: string;
  markers: Marker[];
}

export interface Scorecard {
  criteria: Criterion[];
  /** 0–100: good = 100, fair = 60, poor = 20, averaged. */
  score: number;
}

/** Room one waiting person takes in a line, meters. */
const PERSON_M = 0.6;
/** A line or block closer than this to a doorway blocks it, meters. */
const DOOR_CLEAR_M = 1.2;
/** A turn sharper than this is walking back the way you came. */
const UTURN_DEG = 135;

const GRADE_POINTS: Record<Grade, number> = { good: 100, fair: 60, poor: 20 };
const r1 = (n: number) => n.toFixed(1);

function segIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
  // Strictly inside both segments: touching at shared ends is not a crossing.
  if (t <= 0.02 || t >= 0.98 || u <= 0.02 || u >= 0.98) return null;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

function pointSegDist([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Doorways: entrances and exits, plus gaps of 0.7–3 m between wall pieces on one line. */
export function findDoors(model: ModelSpec): Point[] {
  const mpp = metersPerPixel(model);
  const doors: Point[] = model.blocks.filter((b) => b.type === 'source' || b.type === 'sink').map((b) => [b.x, b.y]);
  const segs = (model.walls ?? []).flatMap((w) => w.slice(1).map((p, i) => [w[i], p] as [Point, Point]));
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [a1, a2] = segs[i];
      const [b1, b2] = segs[j];
      for (const p of [a1, a2]) {
        for (const q of [b1, b2]) {
          const gap = Math.hypot(p[0] - q[0], p[1] - q[1]) * mpp;
          // Same straight line: both segments horizontal at one y, or vertical at one x.
          const sameH = a1[1] === a2[1] && b1[1] === b2[1] && a1[1] === b1[1];
          const sameV = a1[0] === a2[0] && b1[0] === b2[0] && a1[0] === b1[0];
          if ((sameH || sameV) && gap >= 0.7 && gap <= 3) doors.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
        }
      }
    }
  }
  return doors;
}

/** Where a queue's line runs at its peak: from the front (by the server) to the back, in plan pixels. */
function lineExtent(model: ModelSpec, q: Block, server: Block | undefined, peakPeople: number) {
  const mpp = metersPerPixel(model);
  const s = BLOCK_STYLES[q.type];
  const w = q.w ?? s.w;
  const h = q.h ?? s.h;
  const alongX = w >= h;
  const len = alongX ? w : h;
  const depth = alongX ? h : w;
  const rows = Math.max(1, Math.floor(depth / PERSON_M));
  const fits = Math.max(1, Math.floor(len / PERSON_M)) * rows;
  const r = ((q.rotation ?? 0) * Math.PI) / 180;
  const axis: Point = alongX ? [Math.cos(r), Math.sin(r)] : [-Math.sin(r), Math.cos(r)];
  // The back of the line is the end farther from the server.
  const endA: Point = [q.x + (axis[0] * len) / 2 / mpp, q.y + (axis[1] * len) / 2 / mpp];
  const endB: Point = [q.x - (axis[0] * len) / 2 / mpp, q.y - (axis[1] * len) / 2 / mpp];
  const backIsA = !server || Math.hypot(server.x - endA[0], server.y - endA[1]) > Math.hypot(server.x - endB[0], server.y - endB[1]);
  const back = backIsA ? endA : endB;
  const dir: Point = backIsA ? axis : [-axis[0], -axis[1]];
  const overflowPeople = Math.max(0, Math.ceil(peakPeople) - fits);
  const overflowM = (overflowPeople * PERSON_M) / rows;
  const spill: Point = [back[0] + (dir[0] * overflowM) / mpp, back[1] + (dir[1] * overflowM) / mpp];
  return { fits, overflowPeople, overflowM, back, spill, front: backIsA ? endB : endA };
}

function grade(value: number, goodMax: number, fairMax: number): Grade {
  return value <= goodMax ? 'good' : value <= fairMax ? 'fair' : 'poor';
}

/**
 * Grades a layout. `routes` are the walking paths (around walls) for this exact layout;
 * `result` is a simulation of it (for peak line lengths).
 */
export function scoreLayout(model: ModelSpec, routes: Map<string, Route>, result: ExperimentResult): Scorecard {
  const mpp = metersPerPixel(model);
  const byId = new Map(model.blocks.map((b) => [b.id, b]));
  const flows = linkFlows(model);
  const entering = model.links.filter((l) => byId.get(l.from)?.type === 'source').reduce((s, l) => s + (flows.get(routeKey(l.from, l.to)) ?? 0), 0) || 1;
  const label = (id: string) => byId.get(id)?.label || id;
  const pathOf = (from: string, to: string): Point[] => routes.get(routeKey(from, to))?.points ?? [[byId.get(from)!.x, byId.get(from)!.y], [byId.get(to)!.x, byId.get(to)!.y]];
  const serverOfQueue = new Map<string, string>();
  for (const l of model.links) if (byId.get(l.from)?.type === 'queue') serverOfQueue.set(l.from, l.to);
  const queueOfServer = new Map([...serverOfQueue].map(([q, s]) => [s, q]));
  const walkLinks = model.links.filter((l) => byId.get(l.from)?.type !== 'queue');

  // ---- 1. flow order: walking back the way you came (U-turns between steps) ----
  const uturns: Marker[] = [];
  let uturnFlow = 0;
  for (const b of model.blocks) {
    if (b.type === 'queue' || b.type === 'source' || b.type === 'sink') continue;
    // A server with a line: people arrive at the line and leave from the server.
    const arrivalId = queueOfServer.get(b.id) ?? b.id;
    for (const lin of walkLinks.filter((l) => l.to === arrivalId)) {
      for (const lout of walkLinks.filter((l) => l.from === b.id)) {
        const pin = pathOf(lin.from, lin.to);
        const pout = pathOf(lout.from, lout.to);
        const vin: Point = [pin[pin.length - 1][0] - pin[pin.length - 2][0], pin[pin.length - 1][1] - pin[pin.length - 2][1]];
        const vout: Point = [pout[1][0] - pout[0][0], pout[1][1] - pout[0][1]];
        const nin = Math.hypot(...vin);
        const nout = Math.hypot(...vout);
        if (nin < 1e-6 || nout < 1e-6) continue;
        const turn = (Math.acos(Math.max(-1, Math.min(1, (vin[0] * vout[0] + vin[1] * vout[1]) / (nin * nout)))) * 180) / Math.PI;
        if (turn < UTURN_DEG) continue;
        const f = Math.min(flows.get(routeKey(lin.from, lin.to)) ?? 0, flows.get(routeKey(lout.from, lout.to)) ?? 0);
        if (f <= 0) continue;
        uturnFlow += f;
        uturns.push({ x: b.x, y: b.y, kind: 'uturn', text: `${Math.round(f)} people/h turn back here: from ${label(lin.from)} to ${label(b.id)}, then back toward ${label(lout.to)}` });
      }
    }
  }
  const uturnShare = uturnFlow / entering;
  const order: Criterion = {
    id: 'order', label: 'Flow order', markers: uturns,
    grade: grade(uturnShare, 0.05, 0.25),
    detail: uturns.length
      ? `${Math.round(uturnShare * 100)}% of visitors walk back the way they came at ${uturns.length} spot${uturns.length > 1 ? 's' : ''}. Steps in a row should lead onward, not back.`
      : 'Every step leads onward toward the next one; nobody has to turn back.',
  };

  // ---- 2. crossing paths ----
  const crossings: Marker[] = [];
  let crossFlow = 0;
  for (let i = 0; i < walkLinks.length; i++) {
    for (let j = i + 1; j < walkLinks.length; j++) {
      const a = walkLinks[i];
      const b = walkLinks[j];
      if (a.from === b.from || a.to === b.to || a.from === b.to || a.to === b.from) continue;
      const fa = flows.get(routeKey(a.from, a.to)) ?? 0;
      const fb = flows.get(routeKey(b.from, b.to)) ?? 0;
      if (fa <= 0 || fb <= 0) continue;
      const pa = pathOf(a.from, a.to);
      const pb = pathOf(b.from, b.to);
      let hit: Point | null = null;
      for (let s = 1; s < pa.length && !hit; s++) for (let t = 1; t < pb.length && !hit; t++) hit = segIntersection(pa[s - 1], pa[s], pb[t - 1], pb[t]);
      if (!hit) continue;
      const f = Math.min(fa, fb);
      crossFlow += f;
      crossings.push({ x: hit[0], y: hit[1], kind: 'crossing', text: `${label(a.from)} → ${label(a.to)} (${Math.round(fa)}/h) crosses ${label(b.from)} → ${label(b.to)} (${Math.round(fb)}/h)` });
    }
  }
  const crossShare = crossFlow / entering;
  const crossingsC: Criterion = {
    id: 'crossings', label: 'Crossing paths', markers: crossings,
    grade: grade(crossShare, 0.05, 0.3),
    detail: crossings.length
      ? `${crossings.length} place${crossings.length > 1 ? 's' : ''} where busy paths cross, involving about ${Math.round(crossShare * 100)}% of visitors. Crossings mean people weaving through each other.`
      : 'No walking paths cross each other.',
  };

  // ---- 3. queue space at the daily peak, and 4. doors kept clear ----
  const doors = findDoors(model);
  const overflow: Marker[] = [];
  const blocked: Marker[] = [];
  const queueNotes: string[] = [];
  for (const st of result.stations) {
    const server = byId.get(st.id);
    if (!server) continue;
    const peak = st.lqMax.mean;
    const qid = queueOfServer.get(st.id);
    const q = qid ? byId.get(qid) : undefined;
    if (!q) {
      if (peak >= 3) {
        overflow.push({ x: server.x, y: server.y, kind: 'overflow', text: `${label(st.id)}: lines of about ${Math.round(peak)} people form with no waiting area` });
        queueNotes.push(`${label(st.id)} has lines of about ${Math.round(peak)} but no waiting area`);
      }
      continue;
    }
    const ext = lineExtent(model, q, server, peak);
    if (ext.overflowPeople > 0) {
      overflow.push({ x: ext.spill[0], y: ext.spill[1], kind: 'overflow', text: `${label(q.id)}: about ${ext.overflowPeople} more people than fit at the peak (${r1(ext.overflowM)} m past its end)` });
      queueNotes.push(`${label(q.id)} holds ${ext.fits} but peaks at ${Math.round(peak)}`);
    }
    // Does the line at its peak reach a doorway?
    for (const d of doors) {
      const dist = Math.min(pointSegDist(d, ext.front, ext.spill), pointSegDist(d, ext.back, ext.spill)) * mpp;
      if (dist < DOOR_CLEAR_M) {
        blocked.push({ x: d[0], y: d[1], kind: 'door', text: `The ${label(q.id)} line reaches this doorway at its peak (${r1(dist)} m away)` });
        break;
      }
    }
  }
  const queues: Criterion = {
    id: 'queues', label: 'Queue space', markers: overflow,
    grade: overflow.length === 0 ? 'good' : overflow.length === 1 ? 'fair' : 'poor',
    detail: overflow.length
      ? `${queueNotes.join('; ')}. A line needs about ${PERSON_M} m per person.`
      : 'Every waiting area holds its line at the daily peak.',
  };
  const doorsC: Criterion = {
    id: 'doors', label: 'Doors kept clear', markers: blocked,
    grade: blocked.length === 0 ? 'good' : blocked.length === 1 ? 'fair' : 'poor',
    detail: blocked.length
      ? `${blocked.length} doorway${blocked.length > 1 ? 's are' : ' is'} reached by a waiting line at the busiest moment.`
      : `Waiting lines stay at least ${DOOR_CLEAR_M} m from every doorway, even at the peak.`,
  };

  // ---- 5. walking and detours ----
  let walked = 0;
  let straight = 0;
  for (const l of walkLinks) {
    const f = flows.get(routeKey(l.from, l.to)) ?? 0;
    const a = byId.get(l.from)!;
    const b = byId.get(l.to)!;
    walked += f * (routes.get(routeKey(l.from, l.to))?.meters ?? Math.hypot(b.x - a.x, b.y - a.y) * mpp);
    straight += f * Math.hypot(b.x - a.x, b.y - a.y) * mpp;
  }
  const detour = straight > 0 ? walked / straight : 1;
  const walking: Criterion = {
    id: 'walking', label: 'Walking & detours', markers: [],
    grade: grade(detour, 1.15, 1.5),
    detail: `${Math.round(walked)} people·m walked per hour; walls make paths ${Math.round((detour - 1) * 100)}% longer than straight lines` +
      ` (${r1(result.system.travelMeanM.mean)} m per visitor).`,
  };

  const criteria = [order, crossingsC, queues, doorsC, walking];
  const score = Math.round(criteria.reduce((s, c) => s + GRADE_POINTS[c.grade], 0) / criteria.length);
  return { criteria, score };
}

/** The scorecard as text for the AI. */
export function scorecardText(card: Scorecard): string {
  return card.criteria.map((c) => {
    const spots = c.markers.slice(0, 4).map((m) => `   · ${m.text}`).join('\n');
    return `- ${c.label}: ${c.grade.toUpperCase()}. ${c.detail}${spots ? `\n${spots}` : ''}`;
  }).join('\n');
}
