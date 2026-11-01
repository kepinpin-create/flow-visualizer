// Layout by flow × distance (the idea behind CRAFT-style facility layout): put busy areas
// close together and near the entrance, quiet ones further away. Deterministic; no AI.
import { spotProblem } from '../ai/placement';
import { trafficRates } from '../analysis/queueing';
import { metersPerPixel, planExtent } from '../editor/blocks';
import { isFixed, type Block, type ModelSpec, type Point } from '../model/types';
import { buildGrid, findRoute, routeKey, type Grid } from '../routing/pathfinder';
import { findRooms } from './rooms';

/** Furthest a block may move from where it started, meters: rearranging, not rebuilding. */
export const MAX_MOVE_M = 6;

/** People per hour walking each link, from the long-run traffic through the model. */
export function linkFlows(model: ModelSpec): Map<string, number> {
  // Capped entrances still bring people who walk: count them as an average over the run.
  const rates = trafficRates(model, { averageCapped: true });
  const byId = new Map(model.blocks.map((b) => [b.id, b]));
  const flows = new Map<string, number>();
  for (const l of model.links) {
    const share = byId.get(l.from)?.type === 'decision' ? (l.prob ?? 0) : 1;
    flows.set(routeKey(l.from, l.to), (rates.get(l.from) ?? 0) * 60 * share);
  }
  return flows;
}

/** Total people × meters walked per hour: the number layout changes try to lower. */
export function walkingLoad(flows: Map<string, number>, distances: Record<string, number>): number {
  let total = 0;
  for (const [k, f] of flows) total += f * (distances[k] ?? 0);
  return total;
}

/** Blocks that move together: a server and the queue that feeds it stay side by side. */
interface Unit {
  anchor: Block;
  members: Block[];
}

function movableUnits(model: ModelSpec): Unit[] {
  const byId = new Map(model.blocks.map((b) => [b.id, b]));
  const queueOf = new Map<string, Block>();
  for (const l of model.links) {
    const from = byId.get(l.from);
    if (from?.type === 'queue') queueOf.set(l.to, from);
  }
  const units: Unit[] = [];
  for (const b of model.blocks) {
    // Queues travel with their server; decisions are logical split points, not furniture.
    if (b.type === 'queue' || b.type === 'decision' || b.type === 'resource' || isFixed(b)) continue;
    const q = b.type === 'server' ? queueOf.get(b.id) : undefined;
    if (q && isFixed(q)) continue;
    units.push({ anchor: b, members: q ? [b, q] : [b] });
  }
  return units;
}

export interface LayoutMove {
  id: string;
  label: string;
  from: Point;
  to: Point;
  movedM: number;
}

export interface LayoutResult {
  model: ModelSpec;
  moves: LayoutMove[];
  /** Walking load before and after, people × m per hour. */
  before: number;
  after: number;
  timedOut: boolean;
}

/** Walking distances for links touching the given blocks, with a cache keyed by both endpoints' positions. */
class Distances {
  private cache = new Map<string, number>();
  constructor(private grid: Grid, private mpp: number) {}

  meters(from: Block, to: Block): number {
    if (from.type === 'queue') return 0; // a line ends at its server
    const key = `${from.x},${from.y}>${to.x},${to.y}`;
    let d = this.cache.get(key);
    if (d === undefined) {
      const r = findRoute(this.grid, [from.x, from.y], [to.x, to.y], this.mpp);
      d = r.noPath ? Infinity : r.meters;
      this.cache.set(key, d);
    }
    return d;
  }
}

/** Candidate spots on an even grid over the plan; spacing grows on big plans to keep the search quick. */
function candidateSpots(model: ModelSpec): Point[] {
  const mpp = metersPerPixel(model);
  const { width, height } = planExtent(model);
  const areaM2 = width * height * mpp * mpp;
  const stepM = Math.max(0.75, Math.sqrt(areaM2 / 350));
  const step = stepM / mpp;
  const spots: Point[] = [];
  for (let y = step / 2; y < height; y += step) for (let x = step / 2; x < width; x += step) spots.push([x, y]);
  return spots;
}

/**
 * Greedy relocation: repeatedly make the single move of one movable unit that lowers
 * the walking load most, until no move helps or the time budget runs out. Every spot
 * passes the same checks as AI moves: inside the plan, clear of walls and blocks, reachable.
 */
export function optimizeLayout(
  model: ModelSpec, opts: { timeBudgetMs?: number; maxMoves?: number; maxMoveM?: number } = {},
): LayoutResult {
  const started = performance.now();
  const budget = opts.timeBudgetMs ?? 3000;
  const maxMoves = opts.maxMoves ?? 8;
  const maxMoveM = opts.maxMoveM ?? MAX_MOVE_M;
  const mpp = metersPerPixel(model);
  const { width, height } = planExtent(model);
  // Blocks stay in the room they are in, and within a short distance of where they started.
  const rooms = findRooms(model, width, height);
  const homeRoom = new Map(model.blocks.map((b) => [b.id, rooms.at(b.x, b.y)]));
  const dist = new Distances(buildGrid(model, width, height), mpp);
  const flows = linkFlows(model);
  const work: ModelSpec = JSON.parse(JSON.stringify(model));
  const byId = () => new Map(work.blocks.map((b) => [b.id, b]));

  const linkCost = (blocks: Map<string, Block>, ids: Set<string>) => {
    let c = 0;
    for (const l of work.links) {
      if (!ids.has(l.from) && !ids.has(l.to)) continue;
      const f = flows.get(routeKey(l.from, l.to)) ?? 0;
      if (!f) continue;
      c += f * dist.meters(blocks.get(l.from)!, blocks.get(l.to)!);
    }
    return c;
  };
  const totalCost = () => {
    const blocks = byId();
    return linkCost(blocks, new Set(work.blocks.map((b) => b.id)));
  };

  const before = totalCost();
  const original = new Map(model.blocks.map((b) => [b.id, [b.x, b.y] as Point]));
  const spots = candidateSpots(work);
  let timedOut = false;

  for (let step = 0; step < maxMoves; step++) {
    let best: { unit: string[]; dx: number; dy: number; gain: number } | null = null;
    for (const unit of movableUnits(work)) {
      const ids = new Set(unit.members.map((m) => m.id));
      const blocks = byId();
      const current = linkCost(blocks, ids);
      for (const [sx, sy] of spots) {
        if (performance.now() - started > budget) {
          timedOut = true;
          break;
        }
        const dx = Math.round(sx - unit.anchor.x);
        const dy = Math.round(sy - unit.anchor.y);
        if (!dx && !dy) continue;
        const [ox, oy] = original.get(unit.anchor.id)!;
        if (Math.hypot(sx - ox, sy - oy) * mpp > maxMoveM) continue;
        if (unit.members.some((m) => rooms.at(m.x + dx, m.y + dy) !== homeRoom.get(m.id))) continue;
        // Place the whole unit, then check each member against everything else.
        const moved = work.blocks.map((b) => (ids.has(b.id) ? { ...b, x: b.x + dx, y: b.y + dy } : b));
        // Members of one unit sit side by side on purpose, so each is checked against everything else.
        const clash = unit.members.some((m) => {
          const others = { ...work, blocks: moved.filter((b) => b.id === m.id || !ids.has(b.id)) };
          return spotProblem(others, moved.find((b) => b.id === m.id)!, m.x + dx, m.y + dy);
        });
        if (clash) continue;
        const cost = linkCost(new Map(moved.map((b) => [b.id, b])), ids);
        if (!Number.isFinite(cost)) continue; // walls would cut a path
        const gain = current - cost;
        if (gain > (best?.gain ?? 0.5)) best = { unit: [...ids], dx, dy, gain };
      }
      if (timedOut) break;
    }
    if (!best) break;
    for (const b of work.blocks) {
      if (best.unit.includes(b.id)) {
        b.x += best.dx;
        b.y += best.dy;
      }
    }
    if (timedOut) break;
  }

  const moves: LayoutMove[] = work.blocks
    .filter((b) => {
      const [ox, oy] = original.get(b.id)!;
      return ox !== b.x || oy !== b.y;
    })
    .map((b) => {
      const from = original.get(b.id)!;
      return { id: b.id, label: b.label || b.id, from, to: [b.x, b.y], movedM: Math.hypot(b.x - from[0], b.y - from[1]) * mpp };
    });
  return { model: work, moves, before, after: totalCost(), timedOut };
}
