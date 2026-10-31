// Turns the AI's rough wall lines into clean walls: straight, joined at corners, merged
// where broken, and with every doorway cut open so walking paths never get sealed off.
// The AI reads the plan; this code supplies the precision it lacks.
import type { Point } from '../model/types';

export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Tolerances in meters. */
const MIN_WALL_M = 0.3;
const STRAIGHTEN_DEG = 8;
const SAME_LINE_M = 0.3;
const JOIN_GAP_M = 0.4;
const CORNER_SNAP_M = 0.6;
/** Doorways are never narrower than this, meters. */
export const MIN_DOOR_M = 0.9;
/** How far from a wall the AI's door may be and still count, meters. */
const DOOR_REACH_M = 1.5;

const len = (s: Seg) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
const isH = (s: Seg) => s.y1 === s.y2 && s.x1 !== s.x2;
const isV = (s: Seg) => s.x1 === s.x2 && s.y1 !== s.y2;

/** Nearly horizontal or vertical segments become exactly so (most buildings are rectangular). */
function straighten(s: Seg): Seg {
  const deg = (Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180) / Math.PI;
  const off = Math.abs(((deg % 180) + 180) % 180);
  if (off <= STRAIGHTEN_DEG || off >= 180 - STRAIGHTEN_DEG) {
    const y = (s.y1 + s.y2) / 2;
    return { x1: Math.min(s.x1, s.x2), y1: y, x2: Math.max(s.x1, s.x2), y2: y };
  }
  if (Math.abs(off - 90) <= STRAIGHTEN_DEG) {
    const x = (s.x1 + s.x2) / 2;
    return { x1: x, y1: Math.min(s.y1, s.y2), x2: x, y2: Math.max(s.y1, s.y2) };
  }
  return s;
}

/** Walls whose lines are within a few centimeters become one line (length-weighted average). */
function alignLines(segs: Seg[], key: 'y' | 'x', tol: number): void {
  const group = segs.filter((s) => (key === 'y' ? isH(s) : isV(s))).sort((a, b) => (key === 'y' ? a.y1 - b.y1 : a.x1 - b.x1));
  let i = 0;
  while (i < group.length) {
    let j = i + 1;
    const v = (s: Seg) => (key === 'y' ? s.y1 : s.x1);
    while (j < group.length && v(group[j]) - v(group[i]) <= tol) j++;
    const cluster = group.slice(i, j);
    const total = cluster.reduce((t, s) => t + len(s), 0);
    const mean = cluster.reduce((t, s) => t + v(s) * len(s), 0) / total;
    for (const s of cluster) {
      if (key === 'y') s.y1 = s.y2 = mean;
      else s.x1 = s.x2 = mean;
    }
    i = j;
  }
}

/** Joins pieces of one wall that overlap or nearly touch. */
function mergeCollinear(segs: Seg[], gap: number): Seg[] {
  const out: Seg[] = segs.filter((s) => !isH(s) && !isV(s));
  for (const horizontal of [true, false]) {
    const lines = new Map<number, Seg[]>();
    for (const s of segs.filter(horizontal ? isH : isV)) {
      const k = Math.round(horizontal ? s.y1 : s.x1);
      lines.set(k, [...(lines.get(k) ?? []), s]);
    }
    for (const group of lines.values()) {
      const lo = (s: Seg) => (horizontal ? s.x1 : s.y1);
      const hi = (s: Seg) => (horizontal ? s.x2 : s.y2);
      group.sort((a, b) => lo(a) - lo(b));
      let cur = { ...group[0] };
      for (const s of group.slice(1)) {
        if (lo(s) <= hi(cur) + gap) {
          if (horizontal) cur.x2 = Math.max(cur.x2, s.x2);
          else cur.y2 = Math.max(cur.y2, s.y2);
        } else {
          out.push(cur);
          cur = { ...s };
        }
      }
      out.push(cur);
    }
  }
  return out;
}

/** Ends that stop just short of (or just past) a crossing wall are moved onto it, closing corners. */
function snapCorners(segs: Seg[], tol: number): void {
  const hs = segs.filter(isH);
  const vs = segs.filter(isV);
  for (const h of hs) {
    for (const end of ['1', '2'] as const) {
      const ex = h[`x${end}`];
      let best: Seg | null = null;
      for (const v of vs) {
        if (Math.abs(v.x1 - ex) <= tol && h.y1 >= v.y1 - tol && h.y1 <= v.y2 + tol && (!best || Math.abs(v.x1 - ex) < Math.abs(best.x1 - ex))) best = v;
      }
      if (best) {
        h[`x${end}`] = best.x1;
        best.y1 = Math.min(best.y1, h.y1);
        best.y2 = Math.max(best.y2, h.y1);
      }
    }
  }
  for (const v of vs) {
    for (const end of ['1', '2'] as const) {
      const ey = v[`y${end}`];
      let best: Seg | null = null;
      for (const h of hs) {
        if (Math.abs(h.y1 - ey) <= tol && v.x1 >= h.x1 - tol && v.x1 <= h.x2 + tol && (!best || Math.abs(h.y1 - ey) < Math.abs(best.y1 - ey))) best = h;
      }
      if (best) {
        v[`y${end}`] = best.y1;
        best.x1 = Math.min(best.x1, v.x1);
        best.x2 = Math.max(best.x2, v.x1);
      }
    }
  }
}

/** Straighten, align, merge and join the AI's segments. All lengths in plan pixels; `mpp` = meters per pixel. */
export function cleanWalls(raw: Seg[], mpp: number): Seg[] {
  const px = (m: number) => m / mpp;
  let segs = raw
    .map((s) => ({ ...s }))
    .filter((s) => len(s) >= px(MIN_WALL_M))
    .map(straighten);
  alignLines(segs, 'y', px(SAME_LINE_M));
  alignLines(segs, 'x', px(SAME_LINE_M));
  segs = mergeCollinear(segs, px(JOIN_GAP_M));
  snapCorners(segs, px(CORNER_SNAP_M));
  segs = mergeCollinear(segs, px(JOIN_GAP_M));
  return segs.filter((s) => len(s) >= px(MIN_WALL_M));
}

function project(s: Seg, x: number, y: number): { t: number; dist: number } {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / l2));
  return { t, dist: Math.hypot(x - (s.x1 + t * dx), y - (s.y1 + t * dy)) };
}

/** Cuts a gap of `widthPx` centered on the point nearest (x, y) on segment s; returns the pieces left. */
function cut(s: Seg, t: number, widthPx: number): Seg[] {
  const L = len(s);
  const half = widthPx / 2 / L;
  const a = Math.max(0, t - half);
  const b = Math.min(1, t + half);
  const at = (u: number) => [s.x1 + (s.x2 - s.x1) * u, s.y1 + (s.y2 - s.y1) * u];
  const pieces: Seg[] = [];
  if (a * L > 1) {
    const [x, y] = at(a);
    pieces.push({ x1: s.x1, y1: s.y1, x2: x, y2: y });
  }
  if ((1 - b) * L > 1) {
    const [x, y] = at(b);
    pieces.push({ x1: x, y1: y, x2: s.x2, y2: s.y2 });
  }
  return pieces;
}

/** Opens every doorway: the nearest wall within reach gets a gap of at least MIN_DOOR_M. Returns walls and doors opened. */
export function cutDoors(segs: Seg[], doors: { x: number; y: number; widthM: number | null }[], mpp: number): { walls: Seg[]; opened: number } {
  let walls = segs.map((s) => ({ ...s }));
  let opened = 0;
  for (const d of doors) {
    let best = -1;
    let bestHit = { t: 0, dist: Infinity };
    walls.forEach((s, i) => {
      const hit = project(s, d.x, d.y);
      if (hit.dist < bestHit.dist) {
        best = i;
        bestHit = hit;
      }
    });
    if (best < 0 || bestHit.dist > DOOR_REACH_M / mpp) continue;
    const widthPx = Math.max(MIN_DOOR_M, d.widthM && d.widthM > 0 ? d.widthM : MIN_DOOR_M) / mpp;
    walls = [...walls.slice(0, best), ...cut(walls[best], bestHit.t, widthPx), ...walls.slice(best + 1)];
    opened++;
  }
  return { walls, opened };
}

export const segsToWalls = (segs: Seg[]): Point[][] =>
  segs.map((s) => [[Math.round(s.x1), Math.round(s.y1)], [Math.round(s.x2), Math.round(s.y2)]] as Point[]);

/**
 * The Door tool: cuts a doorway into whichever wall polyline passes nearest to `p`
 * (within `reachPx`). Returns the new walls, or null when no wall is close enough.
 */
export function cutDoorAt(walls: Point[][], p: Point, widthPx: number, reachPx: number): Point[][] | null {
  let hit: { wall: number; seg: number; t: number; dist: number } | null = null;
  walls.forEach((w, wi) => {
    for (let i = 1; i < w.length; i++) {
      const s = { x1: w[i - 1][0], y1: w[i - 1][1], x2: w[i][0], y2: w[i][1] };
      const h = project(s, p[0], p[1]);
      if (h.dist <= reachPx && (!hit || h.dist < hit.dist)) hit = { wall: wi, seg: i, t: h.t, dist: h.dist };
    }
  });
  if (!hit) return null;
  const { wall, seg, t } = hit as { wall: number; seg: number; t: number };
  const w = walls[wall];
  const s = { x1: w[seg - 1][0], y1: w[seg - 1][1], x2: w[seg][0], y2: w[seg][1] };
  const pieces = cut(s, t, widthPx);
  // The polyline splits into the part before the gap and the part after it.
  const before: Point[] = [...w.slice(0, seg - 1), w[seg - 1]];
  const after: Point[] = [w[seg], ...w.slice(seg + 1)];
  const out: Point[][] = [];
  const startPiece = pieces.find((pc) => pc.x1 === s.x1 && pc.y1 === s.y1);
  const endPiece = pieces.find((pc) => pc.x2 === s.x2 && pc.y2 === s.y2);
  if (startPiece) before.push([Math.round(startPiece.x2), Math.round(startPiece.y2)]);
  if (endPiece) after.unshift([Math.round(endPiece.x1), Math.round(endPiece.y1)]);
  if (before.length >= 2) out.push(before);
  if (after.length >= 2) out.push(after);
  return [...walls.slice(0, wall), ...out, ...walls.slice(wall + 1)];
}
