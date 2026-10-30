// FR-20: rebuilds where every entity is at any moment from the first replication's event log.
import { BLOCK_STYLES } from '../editor/blocks';
import type { LogEvent } from '../engine/simulator';
import { DEFAULT_METERS_PER_PIXEL, type Block, type ModelSpec, type Point } from '../model/types';
import { routeKey, type Route } from '../routing/pathfinder';

export type DotState = 'move' | 'wait' | 'service' | 'stay' | 'balk';

export interface Dot {
  id: number;
  x: number;
  y: number;
  state: DotState;
}

export interface Frame {
  t: number;
  dots: Dot[];
  inSystem: number;
  waiting: number;
  inService: number;
}

/** Space each waiting entity takes in a line, meters. */
const SPACING_M = 0.6;
/** How long a balking entity stays visible, minutes. */
const BALK_FLASH_MIN = 2;

type EntityState =
  | { mode: 'at'; block: string }
  | { mode: 'move'; from: string; to: string; t0: number; t1: number }
  | { mode: 'wait'; line: string }
  | { mode: 'service'; server: string; slot: number };

/** Small deterministic hash so each entity sits at its own spot inside a Delay. */
function hash01(n: number, salt: number): number {
  let x = Math.imul(n ^ (salt * 0x9e3779b9), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export class Replay {
  private i = 0;
  private cursor = -Infinity;
  private entities = new Map<number, EntityState>();
  private lines = new Map<string, number[]>();
  private slots = new Map<string, (number | null)[]>();
  private balks: { id: number; at: Point; until: number }[] = [];
  private blocks: Map<string, Block>;
  private serverOfQueue = new Map<string, string>();
  private mpp: number;

  constructor(
    private log: LogEvent[],
    model: ModelSpec,
    private routes: Map<string, Route>,
    /** Last moment the replay covers, minutes. */
    readonly end: number,
  ) {
    this.blocks = new Map(model.blocks.map((b) => [b.id, b]));
    this.mpp = model.background?.metersPerPixel ?? DEFAULT_METERS_PER_PIXEL;
    for (const l of model.links) {
      if (this.blocks.get(l.from)?.type === 'queue') this.serverOfQueue.set(l.from, l.to);
    }
  }

  private reset() {
    this.i = 0;
    this.cursor = -Infinity;
    this.entities.clear();
    this.lines.clear();
    this.slots.clear();
    this.balks = [];
  }

  /** Takes an entity out of whatever line or service slot holds it. */
  private leave(id: number) {
    const s = this.entities.get(id);
    if (s?.mode === 'wait') {
      const line = this.lines.get(s.line)!;
      line.splice(line.indexOf(id), 1);
    } else if (s?.mode === 'service') {
      this.slots.get(s.server)![s.slot] = null;
    }
  }

  private apply(ev: LogEvent) {
    switch (ev.kind) {
      case 'create':
        this.entities.set(ev.entity, { mode: 'at', block: ev.block });
        break;
      case 'move':
        this.leave(ev.entity);
        this.entities.set(ev.entity, { mode: 'move', from: ev.from, to: ev.to, t0: ev.t, t1: ev.arriveT });
        break;
      case 'wait': {
        this.leave(ev.entity);
        const line = this.lines.get(ev.block) ?? [];
        line.push(ev.entity);
        this.lines.set(ev.block, line);
        this.entities.set(ev.entity, { mode: 'wait', line: ev.block });
        break;
      }
      case 'start': {
        this.leave(ev.entity);
        const b = this.blocks.get(ev.block);
        const c = b?.type === 'server' ? b.servers : 1;
        const slots = this.slots.get(ev.block) ?? new Array<number | null>(c).fill(null);
        let slot = slots.indexOf(null);
        if (slot < 0) slot = slots.push(null) - 1;
        slots[slot] = ev.entity;
        this.slots.set(ev.block, slots);
        this.entities.set(ev.entity, { mode: 'service', server: ev.block, slot });
        break;
      }
      case 'balk':
        this.leave(ev.entity);
        this.entities.delete(ev.entity);
        this.balks.push({ id: ev.entity, at: this.center(ev.block), until: ev.t + BALK_FLASH_MIN });
        break;
      case 'exit':
        this.leave(ev.entity);
        this.entities.delete(ev.entity);
        break;
    }
  }

  private center(id: string): Point {
    const b = this.blocks.get(id);
    return b ? [b.x, b.y] : [0, 0];
  }

  /** A point in a block's own frame (meters from its center), turned into plan pixels. */
  private local(b: Block, lxM: number, lyM: number): Point {
    const r = ((b.rotation ?? 0) * Math.PI) / 180;
    const lx = lxM / this.mpp;
    const ly = lyM / this.mpp;
    return [b.x + lx * Math.cos(r) - ly * Math.sin(r), b.y + lx * Math.sin(r) + ly * Math.cos(r)];
  }

  private size(b: Block) {
    const s = BLOCK_STYLES[b.type];
    return { w: b.w ?? s.w, h: b.h ?? s.h };
  }

  /** Where the n-th entity in a line stands (n = 0 is next to be served). */
  private linePosition(lineId: string, n: number): Point {
    const b = this.blocks.get(lineId);
    if (!b) return [0, 0];
    const { w, h } = this.size(b);
    if (b.type === 'queue') {
      const alongX = w >= h;
      const len = alongX ? w : h;
      const depth = alongX ? h : w;
      // The front of the line is the end closest to the server it feeds.
      const server = this.blocks.get(this.serverOfQueue.get(lineId) ?? '');
      const plus = this.local(b, alongX ? len / 2 : 0, alongX ? 0 : len / 2);
      const minus = this.local(b, alongX ? -len / 2 : 0, alongX ? 0 : -len / 2);
      const sign = server && Math.hypot(server.x - plus[0], server.y - plus[1]) > Math.hypot(server.x - minus[0], server.y - minus[1]) ? -1 : 1;
      const perRow = Math.max(1, Math.floor(len / SPACING_M));
      const rows = Math.max(1, Math.floor(depth / SPACING_M));
      const row = Math.floor(n / perRow) % rows;
      const along = sign * (len / 2 - SPACING_M / 2 - (n % perRow) * SPACING_M);
      // Overflow beyond the drawn area keeps stacking behind the back of the line.
      const overflow = Math.floor(n / (perRow * rows));
      const across = (row - (rows - 1) / 2) * SPACING_M;
      const extra = -sign * overflow * perRow * SPACING_M;
      return alongX ? this.local(b, along + extra, across) : this.local(b, across, along + extra);
    }
    // A Server with no Queue block: the line forms to its left.
    return this.local(b, -w / 2 - SPACING_M * (n + 1), 0);
  }

  private slotPosition(serverId: string, slot: number): Point {
    const b = this.blocks.get(serverId);
    if (!b) return [0, 0];
    const { w, h } = this.size(b);
    const c = b.type === 'server' ? b.servers : 1;
    return w >= h ? this.local(b, (slot + 0.5) * (w / c) - w / 2, 0) : this.local(b, 0, (slot + 0.5) * (h / c) - h / 2);
  }

  private stayPosition(blockId: string, id: number): Point {
    const b = this.blocks.get(blockId);
    if (!b) return [0, 0];
    if (b.type !== 'delay') return [b.x, b.y];
    const { w, h } = this.size(b);
    return this.local(b, (hash01(id, 1) - 0.5) * w * 0.8, (hash01(id, 2) - 0.5) * h * 0.8);
  }

  private along(from: string, to: string, frac: number): Point {
    const pts = this.routes.get(routeKey(from, to))?.points ?? [this.center(from), this.center(to)];
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    let d = frac * total;
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (d <= seg && seg > 0) {
        const f = d / seg;
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
      }
      d -= seg;
    }
    return pts[pts.length - 1];
  }

  /** Everyone's position at time t (minutes). Moving forward is incremental; going back replays from the start. */
  at(t: number): Frame {
    if (t < this.cursor) this.reset();
    while (this.i < this.log.length && this.log[this.i].t <= t) this.apply(this.log[this.i++]);
    this.cursor = t;

    const dots: Dot[] = [];
    for (const [id, s] of this.entities) {
      switch (s.mode) {
        case 'move': {
          if (t >= s.t1) {
            const [x, y] = this.stayPosition(s.to, id);
            dots.push({ id, x, y, state: 'stay' });
          } else {
            const span = s.t1 - s.t0;
            const [x, y] = this.along(s.from, s.to, span > 0 ? (t - s.t0) / span : 1);
            dots.push({ id, x, y, state: 'move' });
          }
          break;
        }
        case 'at': {
          const [x, y] = this.stayPosition(s.block, id);
          dots.push({ id, x, y, state: 'stay' });
          break;
        }
        case 'wait': {
          const [x, y] = this.linePosition(s.line, this.lines.get(s.line)!.indexOf(id));
          dots.push({ id, x, y, state: 'wait' });
          break;
        }
        case 'service': {
          const [x, y] = this.slotPosition(s.server, s.slot);
          dots.push({ id, x, y, state: 'service' });
          break;
        }
      }
    }
    this.balks = this.balks.filter((b) => b.until > t);
    for (const b of this.balks) dots.push({ id: b.id, x: b.at[0], y: b.at[1], state: 'balk' });

    let waiting = 0;
    for (const l of this.lines.values()) waiting += l.length;
    let inService = 0;
    for (const s of this.slots.values()) for (const x of s) if (x !== null) inService++;
    return { t, dots, inSystem: this.entities.size, waiting, inService };
  }
}
