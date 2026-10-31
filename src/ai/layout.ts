// "Suggest layout": the AI reads the floor plan and proposes blocks and links as JSON.
// It never writes or runs simulation code; its reply is schema-checked, cleaned up here,
// and every block it adds keeps an "AI-detected" marker (PRD, Role of AI).
import Ajv from 'ajv';
import { linkProblem, newBlock, splitEvenly } from '../editor/blocks';
import { DEFAULT_METERS_PER_PIXEL, type Block, type BlockType, type Link, type ModelSpec, type NeedsInput } from '../model/types';
import { cleanWalls, cutDoors, segsToWalls } from './walls';

const BLOCK_TYPES: BlockType[] = ['source', 'queue', 'server', 'resource', 'delay', 'decision', 'sink'];
const nullable = (type: 'number' | 'integer' | 'string') => ({ anyOf: [{ type }, { type: 'null' }] });

/** The reply format. Strict-mode friendly: every key required, no additional properties. */
export const layoutSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['blocks', 'links', 'walls', 'doors', 'notes'],
  properties: {
    walls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['x1', 'y1', 'x2', 'y2'],
        properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } },
      },
    },
    doors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y', 'widthM'],
        properties: { x: { type: 'number' }, y: { type: 'number' }, widthM: nullable('number') },
      },
    },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'type', 'label', 'x', 'y', 'widthM', 'depthM', 'servers', 'arrivalsPerHour', 'minutes', 'capacity'],
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: BLOCK_TYPES },
          label: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          widthM: nullable('number'),
          depthM: nullable('number'),
          servers: nullable('integer'),
          arrivalsPerHour: nullable('number'),
          minutes: nullable('number'),
          capacity: nullable('integer'),
        },
      },
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'probability'],
        properties: { from: { type: 'string' }, to: { type: 'string' }, probability: nullable('number') },
      },
    },
    notes: { type: 'string' },
  },
} as const;

export interface LayoutReply {
  blocks: {
    id: string; type: BlockType; label: string; x: number; y: number;
    widthM: number | null; depthM: number | null; servers: number | null;
    arrivalsPerHour: number | null; minutes: number | null; capacity: number | null;
  }[];
  links: { from: string; to: string; probability: number | null }[];
  /** Straight wall segments on the 0-1000 grid, drawn straight through doorways. */
  walls: { x1: number; y1: number; x2: number; y2: number }[];
  /** Doorway centers on the 0-1000 grid; the code cuts these gaps into the walls. */
  doors: { x: number; y: number; widthM: number | null }[];
  notes: string;
}

export const LAYOUT_SYSTEM = `You turn a 2D floor plan image into a queuing-simulation model for a tool with exactly seven block types:
- source: where people or items enter (doors, entrances, loading docks).
- queue: where they wait in line for a server (waiting area, line at a counter, buffer). A queue links only to the server it feeds.
- server: where they are served by one or more parallel servers (counters, teller windows, bar, doctor rooms, machines).
- resource: shared staff or equipment that moves around (waiters, nurses, forklifts). Resources take no links.
- delay: time spent without a server (seating, filling a form, waiting room for results).
- decision: a point where the flow splits between several next steps.
- sink: where they leave (exits, finished goods).

Rules:
- Place each block where that activity happens on the plan. x and y are on a 0-1000 grid over the image: x from the left edge, y from the top edge.
- Link blocks in the order people or items move: every path starts at a source and ends at a sink. Every block except a decision or sink has exactly one outgoing link; use a decision block wherever the flow splits.
- servers: count parallel stations you can see (e.g. three teller windows = 3). Otherwise null.
- arrivalsPerHour, minutes (service time for a server, time spent for a delay), capacity, and probability: give a number only when the plan or the user's notes state it. Otherwise null. Never guess these numbers.
- widthM and depthM: the footprint in meters only if the plan shows dimensions; otherwise null.
- ids: short lowercase words with underscores, unique. Labels: the name used on the plan, or a short plain name.
- walls: the building's walls as straight segments on the same 0-1000 grid, along the middle of each wall: outer walls and walls between rooms.
  Leave out furniture, counters, rope lines, text, dimension lines, scale bars and arrows. Draw walls straight through doorways; list the doorways in doors.
  If the plan is a rough sketch, give your best reading of where the walls are.
- doors: the center of every doorway or opening people walk through (on the grid), with widthM if the plan shows it, otherwise null.
  Include entrances and exits and the doors of inner rooms.
- notes: one to three short sentences on what you assumed and what was unclear.`;

export function layoutPrompt(context: string): string {
  return context.trim()
    ? `Build the model for this floor plan. Notes from the user about how the space works:\n${context.trim()}`
    : 'Build the model for this floor plan.';
}

const ajv = new Ajv({ allErrors: true });
const checkReply = ajv.compile<LayoutReply>(layoutSchema);

/** Parses and schema-checks the AI's reply; throws a readable error when it does not fit. */
export function parseLayoutReply(text: string): LayoutReply {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The AI reply was not valid JSON.');
  }
  if (!checkReply(data)) {
    const e = checkReply.errors?.[0];
    throw new Error(`The AI reply did not match the expected format (${e?.instancePath || 'reply'} ${e?.message}).`);
  }
  return data;
}

export interface AppliedSuggestion {
  model: ModelSpec;
  addedBlocks: number;
  addedLinks: number;
  /** Links the editor would not accept, with the reason. */
  dropped: string[];
  /** Blocks whose numbers the AI could not read. */
  needsInput: number;
  /** Walls added after clean-up, and doorways cut open in them. */
  walls: number;
  doors: number;
  notes: string;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'block';
}

const positive = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;

/**
 * Turns a schema-valid reply into model changes. `mode: 'replace'` swaps out the
 * current blocks and links (and walls, when `withWalls`); 'add' keeps them.
 */
export function applySuggestion(
  base: ModelSpec, reply: LayoutReply, plan: { width: number; height: number }, mode: 'replace' | 'add',
  opts: { withWalls?: boolean } = {},
): AppliedSuggestion {
  const model: ModelSpec = JSON.parse(JSON.stringify(base));
  if (mode === 'replace') {
    model.blocks = [];
    model.links = [];
  }

  // Walls: rough AI lines → straight, joined walls with every doorway open.
  let wallCount = 0;
  let doorCount = 0;
  if (opts.withWalls && reply.walls.length) {
    const mpp = model.background?.metersPerPixel ?? DEFAULT_METERS_PER_PIXEL;
    const gx = (v: number) => (Math.min(1000, Math.max(0, v)) / 1000) * plan.width;
    const gy = (v: number) => (Math.min(1000, Math.max(0, v)) / 1000) * plan.height;
    const cleaned = cleanWalls(reply.walls.map((w) => ({ x1: gx(w.x1), y1: gy(w.y1), x2: gx(w.x2), y2: gy(w.y2) })), mpp);
    const { walls, opened } = cutDoors(cleaned, reply.doors.map((d) => ({ x: gx(d.x), y: gy(d.y), widthM: d.widthM })), mpp);
    const fresh = segsToWalls(walls);
    model.walls = mode === 'replace' ? fresh : [...(model.walls ?? []), ...fresh];
    wallCount = fresh.length;
    doorCount = opened;
  }
  const taken = new Set(model.blocks.map((b) => b.id));
  const idMap = new Map<string, string>();
  let needsInput = 0;

  for (const s of reply.blocks) {
    let id = slug(s.id || s.label);
    for (let n = 2; taken.has(id); n++) id = `${slug(s.id || s.label)}_${n}`;
    taken.add(id);
    if (!idMap.has(s.id)) idMap.set(s.id, id);

    const x = (Math.min(1000, Math.max(0, s.x)) / 1000) * plan.width;
    const y = (Math.min(1000, Math.max(0, s.y)) / 1000) * plan.height;
    const b = { ...newBlock(model, s.type, x, y), id, label: s.label.trim() || id } as Block;
    b.origin = 'ai';
    const missing: NeedsInput[] = [];
    if (positive(s.widthM)) b.w = +s.widthM.toFixed(2);
    if (positive(s.depthM)) b.h = +s.depthM.toFixed(2);
    switch (b.type) {
      case 'source':
        if (positive(s.arrivalsPerHour)) b.arrival = { dist: 'exponential', ratePerHour: s.arrivalsPerHour };
        else missing.push('arrival');
        break;
      case 'server':
        if (positive(s.servers)) b.servers = Math.round(s.servers);
        else missing.push('servers');
        if (positive(s.minutes)) b.service = { dist: 'exponential', meanMin: s.minutes };
        else missing.push('service');
        break;
      case 'delay':
        if (positive(s.minutes)) b.time = { dist: 'triangular', min: +(s.minutes / 2).toFixed(2), mode: s.minutes, max: +(s.minutes * 1.5).toFixed(2) };
        else missing.push('time');
        break;
      case 'queue':
        if (positive(s.capacity)) b.capacity = Math.round(s.capacity);
        break;
      case 'resource':
        if (positive(s.servers)) b.count = Math.round(s.servers);
        break;
    }
    if (missing.length) {
      b.needsInput = missing;
      needsInput++;
    }
    model.blocks.push(b);
  }

  const dropped: string[] = [];
  const label = (id: string) => model.blocks.find((b) => b.id === id)?.label ?? id;
  let addedLinks = 0;
  for (const l of reply.links) {
    const from = idMap.get(l.from);
    const to = idMap.get(l.to);
    if (!from || !to) {
      dropped.push(`${l.from} → ${l.to}: refers to a block the AI did not create`);
      continue;
    }
    const problem = linkProblem(model, from, to);
    if (problem) {
      dropped.push(`${label(from)} → ${label(to)}: ${problem}`);
      continue;
    }
    const link: Link = { from, to };
    if (l.probability !== null && Number.isFinite(l.probability)) link.prob = Math.min(1, Math.max(0, l.probability));
    model.links.push(link);
    addedLinks++;
  }

  // Decisions: keep stated probabilities only if they are complete and sum to 1; otherwise split evenly and flag.
  const created = new Set(idMap.values());
  for (const b of model.blocks) {
    if (b.type !== 'decision' || !created.has(b.id)) continue;
    const outs = model.links.filter((l) => l.from === b.id);
    if (!outs.length) continue;
    const sum = outs.reduce((s, l) => s + (l.prob ?? NaN), 0);
    if (!(Math.abs(sum - 1) < 0.01)) {
      splitEvenly(model, b.id);
      b.needsInput = [...(b.needsInput ?? []), 'routing'];
      needsInput++;
    }
  }

  return { model, addedBlocks: reply.blocks.length, addedLinks, dropped, needsInput, walls: wallCount, doors: doorCount, notes: reply.notes.trim() };
}

/** Longest side of the image sent to the AI, in pixels: enough to read labels, cheap in tokens. */
const AI_IMAGE_PX = 1568;

/** Shrinks the plan to a JPEG data URL for the AI request. Browser only. */
export async function planForAi(dataUrl: string): Promise<string> {
  // The load event rather than img.decode(): decode() can wait for a paint that a background tab never does.
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('The plan image could not be read.'));
    el.src = dataUrl;
  });
  const scale = Math.min(1, AI_IMAGE_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}
