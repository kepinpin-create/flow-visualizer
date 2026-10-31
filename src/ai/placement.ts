// Where a block may stand: inside the plan, clear of walls and other blocks, and still
// reachable on foot. Used to check (and if needed snap) positions the AI suggests.
import { footprintPx, metersPerPixel, planExtent } from '../editor/blocks';
import { isFixed, type Block, type ModelSpec, type Point } from '../model/types';
import { computeRoutes } from '../routing/pathfinder';

/** Gap kept between a block's footprint and any wall, meters. */
const WALL_CLEARANCE_M = 0.2;
/** Gap kept between a moved block and any other block, meters: room for people to walk between areas. */
const BLOCK_GAP_M = 1.0;
/** How far from the AI's spot the checker looks for a valid one, meters. */
const SNAP_RADIUS_M = 5;
const SNAP_STEP_M = 0.25;
/** Spots that pass the geometry check get a path check; at most this many, to stay fast. */
const MAX_PATH_CHECKS = 12;

export interface Placement {
  ok: boolean;
  /** Final position in plan pixels (the AI's spot, or the nearest valid one). */
  x: number;
  y: number;
  /** True when the AI's spot was invalid and a nearby one was used. */
  snapped: boolean;
  /** How far the block moves from where it is now, meters. */
  movedM: number;
  reason?: string;
}

/** The four corners of a block's footprint at (x, y), rotation included. */
function corners(model: ModelSpec, b: Block, x: number, y: number, growPx = 0): Point[] {
  const { w, h } = footprintPx(model, b);
  const hw = w / 2 + growPx;
  const hh = h / 2 + growPx;
  const r = ((b.rotation ?? 0) * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => [x + lx * c - ly * s, y + lx * s + ly * c] as Point);
}

function pointInPoly([px, py]: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointSegDist([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Shortest distance between a wall segment and a footprint polygon (0 when they touch). */
function wallDistance(poly: Point[], a: Point, b: Point): number {
  if (pointInPoly(a, poly) || pointInPoly(b, poly)) return 0;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (segmentsCross(a, b, p, q)) return 0;
    d = Math.min(d, pointSegDist(p, a, b), pointSegDist(q, a, b), pointSegDist(a, p, q), pointSegDist(b, p, q));
  }
  return d;
}

/** Separating-axis test for two convex quads. */
function overlaps(A: Point[], B: Point[]): boolean {
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      const nx = y2 - y1;
      const ny = x1 - x2;
      const proj = (P: Point[]) => P.map(([x, y]) => x * nx + y * ny);
      const a = proj(A);
      const b = proj(B);
      if (Math.max(...a) < Math.min(...b) || Math.max(...b) < Math.min(...a)) return false;
    }
  }
  return true;
}

/** Why a block cannot stand at (x, y), or null when it can (geometry only; paths are checked separately). */
export function spotProblem(model: ModelSpec, b: Block, x: number, y: number): string | null {
  const mpp = metersPerPixel(model);
  const { width, height } = planExtent(model);
  const poly = corners(model, b, x, y);
  if (poly.some(([px, py]) => px < 0 || py < 0 || px > width || py > height)) return 'it would stick out of the plan';
  for (const wall of model.walls ?? []) {
    for (let i = 1; i < wall.length; i++) {
      if (wallDistance(poly, wall[i - 1], wall[i]) < WALL_CLEARANCE_M / mpp) return 'it would hit a wall';
    }
  }
  // A line and the server it feeds belong side by side: between them only actual overlap counts, no aisle.
  const partners = new Set(model.links
    .filter((l) => (l.from === b.id && b.type === 'queue') || (l.to === b.id && b.type === 'server'))
    .map((l) => (l.from === b.id ? l.to : l.from))
    .filter((id) => id !== b.id && (b.type === 'queue' || model.blocks.find((o) => o.id === id)?.type === 'queue')));
  const grown = corners(model, b, x, y, BLOCK_GAP_M / mpp);
  for (const other of model.blocks) {
    if (other.id === b.id) continue;
    const mine = partners.has(other.id) ? poly : grown;
    if (overlaps(mine, corners(model, other, other.x, other.y))) return `it would overlap ${other.label || other.id}`;
  }
  return null;
}

/** Whether every walking path to and from the block still exists with it at (x, y). */
function pathsClear(model: ModelSpec, b: Block, x: number, y: number): boolean {
  const trial: ModelSpec = { ...model, blocks: model.blocks.map((o) => (o.id === b.id ? { ...o, x, y } : o)) };
  const { width, height } = planExtent(model);
  const routes = computeRoutes({ ...trial, links: trial.links.filter((l) => l.from === b.id || l.to === b.id) }, width, height);
  return [...routes.values()].every((r) => !r.noPath);
}

/**
 * Checks the spot the AI picked for a block. If it is not valid, looks outward
 * ring by ring for the nearest spot that is, within a few meters.
 */
export function placeBlock(model: ModelSpec, blockId: string, targetX: number, targetY: number): Placement {
  const b = model.blocks.find((o) => o.id === blockId);
  const mpp = metersPerPixel(model);
  const none = (reason: string): Placement => ({ ok: false, x: b?.x ?? 0, y: b?.y ?? 0, snapped: false, movedM: 0, reason });
  if (!b) return none(`there is no block "${blockId}"`);
  if (isFixed(b)) return none(`${b.label || b.id} is fixed in place`);
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return none('the AI gave no usable position');

  const step = SNAP_STEP_M / mpp;
  const candidates: Point[] = [[targetX, targetY]];
  for (let r = step; r <= SNAP_RADIUS_M / mpp + 1e-9; r += step) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / step));
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      candidates.push([targetX + r * Math.cos(a), targetY + r * Math.sin(a)]);
    }
  }

  let firstProblem: string | null = null;
  let pathChecks = 0;
  for (const [x, y] of candidates) {
    const problem = spotProblem(model, b, x, y);
    if (problem) {
      firstProblem ??= problem;
      continue;
    }
    if (pathChecks++ >= MAX_PATH_CHECKS) break;
    if (!pathsClear(model, b, x, y)) {
      firstProblem ??= 'walls would cut off its walking path';
      continue;
    }
    const rx = Math.round(x);
    const ry = Math.round(y);
    return {
      ok: true, x: rx, y: ry,
      snapped: rx !== Math.round(targetX) || ry !== Math.round(targetY),
      movedM: Math.hypot(rx - b.x, ry - b.y) * mpp,
    };
  }
  return none(`no free spot near there (${firstProblem ?? 'blocked'})`);
}
