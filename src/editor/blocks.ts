import { DEFAULT_METERS_PER_PIXEL, type Block, type BlockType, type ModelSpec } from '../model/types';

export interface BlockStyle {
  name: string;
  /** Short hint shown in the palette. */
  hint: string;
  color: string;
  shape: 'rect' | 'circle' | 'diamond' | 'line';
  /** Default footprint in meters. */
  w: number;
  h: number;
}

// FR-10: each type has its own shape and color.
export const BLOCK_STYLES: Record<BlockType, BlockStyle> = {
  source: { name: 'Source', hint: 'Entities arrive', color: '#2e9d5b', shape: 'circle', w: 1.2, h: 1.2 },
  queue: { name: 'Queue', hint: 'Entities wait', color: '#d08a1e', shape: 'line', w: 4, h: 1.2 },
  server: { name: 'Server', hint: 'Entities are served', color: '#2f6fd6', shape: 'rect', w: 2, h: 1.5 },
  resource: { name: 'Resource', hint: 'Shared staff or equipment', color: '#8a55c9', shape: 'circle', w: 0.8, h: 0.8 },
  delay: { name: 'Delay', hint: 'Time without a server', color: '#13a3a3', shape: 'rect', w: 3, h: 3 },
  decision: { name: 'Decision', hint: 'Splits the flow', color: '#d4495a', shape: 'diamond', w: 1.2, h: 1.2 },
  sink: { name: 'Sink', hint: 'Entities leave', color: '#5d6779', shape: 'circle', w: 1.2, h: 1.2 },
};

export const BLOCK_ORDER: BlockType[] = ['source', 'queue', 'server', 'resource', 'delay', 'decision', 'sink'];

export function metersPerPixel(model: ModelSpec): number {
  return model.background?.metersPerPixel ?? DEFAULT_METERS_PER_PIXEL;
}

/** Footprint of a block in plan pixels. */
export function footprintPx(model: ModelSpec, b: Block): { w: number; h: number } {
  const s = BLOCK_STYLES[b.type];
  const mpp = metersPerPixel(model);
  return { w: (b.w ?? s.w) / mpp, h: (b.h ?? s.h) / mpp };
}

export function uniqueId(model: ModelSpec, type: BlockType): string {
  const ids = new Set(model.blocks.map((b) => b.id));
  for (let n = 1; ; n++) {
    const id = `${type}_${n}`;
    if (!ids.has(id)) return id;
  }
}

function uniqueLabel(model: ModelSpec, type: BlockType): string {
  const labels = new Set(model.blocks.map((b) => b.label));
  for (let n = 1; ; n++) {
    const label = `${BLOCK_STYLES[type].name} ${n}`;
    if (!labels.has(label)) return label;
  }
}

/** A new block with sensible defaults (FR-11). */
export function newBlock(model: ModelSpec, type: BlockType, x: number, y: number): Block {
  const base = { id: uniqueId(model, type), label: uniqueLabel(model, type), x: Math.round(x), y: Math.round(y), origin: 'user' as const };
  switch (type) {
    case 'source':
      return { ...base, type, arrival: { dist: 'exponential', ratePerHour: 30 } };
    case 'queue':
      return { ...base, type, discipline: 'FIFO' };
    case 'server':
      return { ...base, type, servers: 1, service: { dist: 'exponential', meanMin: 4 } };
    case 'resource':
      return { ...base, type, count: 1 };
    case 'delay':
      return { ...base, type, time: { dist: 'triangular', min: 5, mode: 10, max: 20 } };
    case 'decision':
      return { ...base, type };
    case 'sink':
      return { ...base, type };
  }
}

/** Why a link from → to is not allowed, or null when it is. */
export function linkProblem(model: ModelSpec, fromId: string, toId: string): string | null {
  const from = model.blocks.find((b) => b.id === fromId);
  const to = model.blocks.find((b) => b.id === toId);
  if (!from || !to) return 'Pick two blocks.';
  if (fromId === toId) return 'A block cannot link to itself.';
  if (from.type === 'resource' || to.type === 'resource') return 'Resources are shared staff, not steps in the flow, so they take no links.';
  if (from.type === 'sink') return 'A Sink is where entities leave; it has no outgoing links.';
  if (to.type === 'source') return 'A Source is where entities enter; nothing links into it.';
  if (model.links.some((l) => l.from === fromId && l.to === toId)) return 'These blocks are already linked.';
  if (from.type === 'queue' && to.type !== 'server') return 'A Queue holds the line for a Server, so it can only link to a Server.';
  if (from.type !== 'decision' && model.links.some((l) => l.from === fromId)) {
    return `${from.label} already has an outgoing link. Add a Decision block to split the flow.`;
  }
  return null;
}

/** Splits a Decision's outputs evenly; the last link takes the rounding remainder so they sum to 1. */
export function splitEvenly(model: ModelSpec, decisionId: string) {
  const outs = model.links.filter((l) => l.from === decisionId);
  const each = Math.floor((1 / outs.length) * 1000) / 1000;
  outs.forEach((l, i) => {
    l.prob = i === outs.length - 1 ? +(1 - each * (outs.length - 1)).toFixed(3) : each;
  });
}

/** Removes a block and every link touching it. */
export function deleteBlock(model: ModelSpec, id: string) {
  model.blocks = model.blocks.filter((b) => b.id !== id);
  model.links = model.links.filter((l) => l.from !== id && l.to !== id);
}

/** Plan size in pixels: the image, or a box around everything drawn. */
export function planExtent(model: ModelSpec): { width: number; height: number } {
  if (model.background?.width && model.background.height) {
    return { width: model.background.width, height: model.background.height };
  }
  let w = 1000;
  let h = 700;
  for (const b of model.blocks) {
    w = Math.max(w, b.x + 100);
    h = Math.max(h, b.y + 100);
  }
  for (const wall of model.walls ?? []) {
    for (const [x, y] of wall) {
      w = Math.max(w, x + 40);
      h = Math.max(h, y + 40);
    }
  }
  return { width: w, height: h };
}
