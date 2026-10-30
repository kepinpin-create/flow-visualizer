// FR-16: shortest walking paths between blocks around walls (grid + A*).
import { DEFAULT_METERS_PER_PIXEL, type ModelSpec, type Point } from '../model/types';

/** Grid cell size, meters. Small enough for door gaps of about 0.6 m and up. */
export const CELL_M = 0.25;
/** Extra clearance kept from a wall, meters, on top of the cell itself. */
const WALL_CLEARANCE_M = 0.1;
/** Cap on grid cells so huge plans stay fast; cells grow past it. */
const MAX_CELLS = 400_000;

export interface Grid {
  cols: number;
  rows: number;
  /** Cell size in plan pixels. */
  cell: number;
  blocked: Uint8Array;
}

export interface Route {
  /** Plan-pixel points from the start block's center to the end block's center. */
  points: Point[];
  meters: number;
  /** True when walls leave no way through and the straight line is used instead. */
  noPath: boolean;
}

export const routeKey = (from: string, to: string) => `${from}>${to}`;

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function buildGrid(model: ModelSpec, width: number, height: number): Grid {
  const mpp = model.background?.metersPerPixel ?? DEFAULT_METERS_PER_PIXEL;
  let cell = CELL_M / mpp;
  if ((width / cell) * (height / cell) > MAX_CELLS) cell = Math.sqrt((width * height) / MAX_CELLS);
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const blocked = new Uint8Array(cols * rows);
  // A cell is blocked when its center is within ~¾ cell of a wall, so every cell
  // a wall crosses is closed and diagonal steps cannot slip through it.
  const reach = cell * 0.75 + WALL_CLEARANCE_M / mpp;
  for (const wall of model.walls ?? []) {
    for (let i = 1; i < wall.length; i++) {
      const [ax, ay] = wall[i - 1];
      const [bx, by] = wall[i];
      const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach) / cell));
      const c1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + reach) / cell));
      const r0 = Math.max(0, Math.floor((Math.min(ay, by) - reach) / cell));
      const r1 = Math.min(rows - 1, Math.floor((Math.max(ay, by) + reach) / cell));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (segmentDistance((c + 0.5) * cell, (r + 0.5) * cell, ax, ay, bx, by) <= reach) blocked[r * cols + c] = 1;
        }
      }
    }
  }
  return { cols, rows, cell, blocked };
}

function cellOf(g: Grid, [x, y]: Point): number {
  const c = Math.min(g.cols - 1, Math.max(0, Math.floor(x / g.cell)));
  const r = Math.min(g.rows - 1, Math.max(0, Math.floor(y / g.cell)));
  return r * g.cols + c;
}

/** The free cell nearest to `start`, searching outward ring by ring. */
function nearestFree(g: Grid, start: number): number {
  if (!g.blocked[start]) return start;
  const sc = start % g.cols;
  const sr = Math.floor(start / g.cols);
  const maxRing = Math.max(g.cols, g.rows);
  for (let ring = 1; ring < maxRing; ring++) {
    let best = -1;
    let bestD = Infinity;
    for (let r = sr - ring; r <= sr + ring; r++) {
      for (let c = sc - ring; c <= sc + ring; c++) {
        if (Math.max(Math.abs(r - sr), Math.abs(c - sc)) !== ring) continue;
        if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) continue;
        const i = r * g.cols + c;
        const d = (r - sr) ** 2 + (c - sc) ** 2;
        if (!g.blocked[i] && d < bestD) {
          best = i;
          bestD = d;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** Min-heap of cell indices keyed by f-score. */
class OpenSet {
  private ids: number[] = [];
  private keys: number[] = [];

  get size() {
    return this.ids.length;
  }

  push(id: number, key: number) {
    const { ids, keys } = this;
    ids.push(id);
    keys.push(key);
    let i = ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= keys[i]) break;
      [ids[i], ids[p]] = [ids[p], ids[i]];
      [keys[i], keys[p]] = [keys[p], keys[i]];
      i = p;
    }
  }

  pop(): number {
    const { ids, keys } = this;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    if (ids.length) {
      ids[0] = lastId;
      keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < ids.length && keys[l] < keys[m]) m = l;
        if (r < ids.length && keys[r] < keys[m]) m = r;
        if (m === i) break;
        [ids[i], ids[m]] = [ids[m], ids[i]];
        [keys[i], keys[m]] = [keys[m], keys[i]];
        i = m;
      }
    }
    return top;
  }
}

const SQRT2 = Math.SQRT2;
const STEPS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

/** 8-connected A* on cells; diagonals may not cut a blocked corner. Returns cell indices or null. */
function astar(g: Grid, start: number, goal: number): number[] | null {
  const n = g.cols * g.rows;
  const gScore = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const gc = goal % g.cols;
  const gr = Math.floor(goal / g.cols);
  const h = (i: number) => {
    const dx = Math.abs((i % g.cols) - gc);
    const dy = Math.abs(Math.floor(i / g.cols) - gr);
    return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
  };
  const open = new OpenSet();
  gScore[start] = 0;
  open.push(start, h(start));
  while (open.size) {
    const cur = open.pop();
    if (cur === goal) {
      const path = [cur];
      for (let i = came[cur]; i >= 0; i = came[i]) path.push(i);
      return path.reverse();
    }
    if (closed[cur]) continue;
    closed[cur] = 1;
    const c = cur % g.cols;
    const r = Math.floor(cur / g.cols);
    for (const [dc, dr, cost] of STEPS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue;
      const ni = nr * g.cols + nc;
      if (g.blocked[ni] || closed[ni]) continue;
      if (dc && dr && (g.blocked[r * g.cols + nc] || g.blocked[nr * g.cols + c])) continue;
      const t = gScore[cur] + cost;
      if (t < gScore[ni]) {
        gScore[ni] = t;
        came[ni] = cur;
        open.push(ni, t + h(ni));
      }
    }
  }
  return null;
}

/** True when the straight segment a→b stays on free cells. */
function clearLine(g: Grid, [ax, ay]: Point, [bx, by]: Point): boolean {
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / (g.cell / 4));
  for (let i = 0; i <= steps; i++) {
    const t = steps ? i / steps : 0;
    if (g.blocked[cellOf(g, [ax + (bx - ax) * t, ay + (by - ay) * t])]) return false;
  }
  return true;
}

/** Drops corner points the walker can see past, so paths run straight instead of stair-stepping. */
function smooth(g: Grid, pts: Point[]): Point[] {
  if (pts.length <= 2) return pts;
  const out: Point[] = [pts[0]];
  let anchor = 0;
  while (anchor < pts.length - 1) {
    let next = anchor + 1;
    for (let j = pts.length - 1; j > anchor + 1; j--) {
      if (clearLine(g, pts[anchor], pts[j])) {
        next = j;
        break;
      }
    }
    out.push(pts[next]);
    anchor = next;
  }
  return out;
}

const pathLength = (pts: Point[]) => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
};

export function findRoute(g: Grid, a: Point, b: Point, mpp: number): Route {
  const straight: Route = { points: [a, b], meters: Math.hypot(b[0] - a[0], b[1] - a[1]) * mpp, noPath: false };
  if (clearLine(g, a, b)) return straight;
  const s = nearestFree(g, cellOf(g, a));
  const t = nearestFree(g, cellOf(g, b));
  const cells = s >= 0 && t >= 0 ? astar(g, s, t) : null;
  if (!cells) return { ...straight, noPath: true };
  const centers: Point[] = cells.map((i) => [((i % g.cols) + 0.5) * g.cell, (Math.floor(i / g.cols) + 0.5) * g.cell]);
  const points = smooth(g, [a, ...centers, b]);
  return { points, meters: pathLength(points) * mpp, noPath: false };
}

/**
 * Walking route for every link (FR-16). A Queue's step into its Server is
 * zero, since the line ends at the server.
 */
export function computeRoutes(model: ModelSpec, width: number, height: number): Map<string, Route> {
  const mpp = model.background?.metersPerPixel ?? DEFAULT_METERS_PER_PIXEL;
  const grid = buildGrid(model, width, height);
  const pos = new Map(model.blocks.map((b) => [b.id, b]));
  const routes = new Map<string, Route>();
  for (const l of model.links) {
    const a = pos.get(l.from);
    const b = pos.get(l.to);
    if (!a || !b) continue;
    if (a.type === 'queue') {
      routes.set(routeKey(l.from, l.to), { points: [[a.x, a.y], [b.x, b.y]], meters: 0, noPath: false });
      continue;
    }
    routes.set(routeKey(l.from, l.to), findRoute(grid, [a.x, a.y], [b.x, b.y], mpp));
  }
  return routes;
}

/** Plain distances for the engine (it runs in a worker, so no functions cross over). */
export function routeDistances(routes: Map<string, Route>): Record<string, number> {
  return Object.fromEntries([...routes].map(([k, r]) => [k, r.meters]));
}
