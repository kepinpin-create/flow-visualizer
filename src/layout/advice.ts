// AI layout advice: Muse reads the scorecard and the layout and suggests moving or resizing
// areas. Code makes each suggestion precise and legal (placement checks), then it is
// re-scored and re-simulated, so every claim comes with measured before/after grades.
import Ajv from 'ajv';
import { placeBlock, spotProblem, type Placement } from '../ai/placement';
import { BLOCK_STYLES, footprintPx, metersPerPixel, planExtent } from '../editor/blocks';
import type { ExperimentResult } from '../engine/experiment';
import { isFixed, type ModelSpec } from '../model/types';
import { routeKey } from '../routing/pathfinder';
import { linkFlows } from './optimize';
import { findDoors, scorecardText, type Scorecard } from './scorecard';

export const adviceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'suggestions'],
  properties: {
    summary: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'why', 'moves', 'resizes'],
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          moves: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['blockId', 'xM', 'yM'],
              properties: { blockId: { type: 'string' }, xM: { type: 'number' }, yM: { type: 'number' } },
            },
          },
          resizes: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['blockId', 'widthM', 'depthM'],
              properties: { blockId: { type: 'string' }, widthM: { type: 'number' }, depthM: { type: 'number' } },
            },
          },
        },
      },
    },
  },
} as const;

export interface AdviceReply {
  summary: string;
  suggestions: {
    title: string;
    why: string;
    moves: { blockId: string; xM: number; yM: number }[];
    resizes: { blockId: string; widthM: number; depthM: number }[];
  }[];
}

export function adviceSystem(language: 'en' | 'id'): string {
  return `You are a facility-layout expert advising the manager of a space (bank, clinic, café, factory...). A scorecard measured from a simulation grades the current layout.
Suggest up to three layout changes that fix the worst grades. Think like an industrial engineer:
- Flow order: arrange steps in the order people move, so each step leads onward toward the next and the exit; avoid U-turns.
- Crossing paths: separate streams that cross (e.g. put a quick service near the entrance so its users never cross the main line).
- Queue space: give each waiting area room for its peak line (about 0.6 m per person per row); lengthen or move it into open floor.
- Doors kept clear: lines must not reach entrances, exits or doorways.
- Walking: keep steps that follow each other close together, busy ones close to the entrance.
Each suggestion: a short title, why it helps (cite the scorecard), and concrete changes:
- moves: new center (xM, yM) in meters from the plan's top-left corner for movable blocks only.
- resizes: new widthM and depthM in meters (typically to lengthen a waiting line).
Keep blocks inside the plan, clear of walls and other blocks, in sensible rooms. Never move fixed blocks. If the layout is already good, say so and suggest at most one change.${language === 'id' ? '\nWrite title, why and summary in Bahasa Indonesia.' : ''}
summary: two sentences on the layout's main problem and the direction to fix it. The simulator will grade every suggestion.`;
}

const r1 = (n: number) => +n.toFixed(1);

export function advicePrompt(model: ModelSpec, result: ExperimentResult, card: Scorecard): string {
  const mpp = metersPerPixel(model);
  const m = (px: number) => r1(px * mpp);
  const { width, height } = planExtent(model);
  const flows = linkFlows(model);
  const byId = new Map(model.blocks.map((b) => [b.id, b]));
  const peak = new Map(result.stations.map((s) => [s.id, s.lqMax.mean]));
  const blocks = model.blocks.map((b) => {
    const { w, h } = footprintPx(model, b);
    const extra = b.type === 'server' ? `, ${b.servers} servers, peak line about ${Math.round(peak.get(b.id) ?? 0)}` : '';
    return `- ${b.id} (${b.type} "${b.label}"): center (${m(b.x)}, ${m(b.y)}), ${m(w)} x ${m(h)} m, ${isFixed(b) ? 'FIXED' : 'movable'}${extra}`;
  });
  const flow = model.links.map((l) => `${l.from} → ${l.to}: ${r1(flows.get(routeKey(l.from, l.to)) ?? 0)} people/h`);
  const walls = (model.walls ?? []).flatMap((w) => w.slice(1).map((p, i) => `(${m(w[i][0])}, ${m(w[i][1])})-(${m(p[0])}, ${m(p[1])})`));
  const doors = findDoors(model).map(([x, y]) => `(${m(x)}, ${m(y)})`);
  const queueFor = model.links.filter((l) => byId.get(l.from)?.type === 'queue').map((l) => `${l.from} is the line for ${l.to}`);
  return `Plan: ${m(width)} x ${m(height)} m (x to the right, y down).
Blocks:
${blocks.join('\n')}
${queueFor.length ? `Lines: ${queueFor.join('; ')}.` : ''}
Flow (people per hour on each step): ${flow.join(', ')}
Walls: ${walls.length ? walls.join(', ') : 'none drawn'}
Doorways: ${doors.join(', ') || 'none found'}

Layout scorecard (score ${card.score}/100):
${scorecardText(card)}`;
}

const ajv = new Ajv({ allErrors: true });
const check = ajv.compile<AdviceReply>(adviceSchema);

export function parseAdvice(text: string): AdviceReply {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The AI reply was not valid JSON.');
  }
  if (!check(data)) throw new Error('The AI reply did not match the expected format.');
  return data;
}

export interface PlannedChange {
  /** "Ticket kiosk: move 3.2 m" or "Waiting area: 4.0 x 1.2 m → 7.0 x 1.2 m" */
  summary: string;
  problem?: string;
}

export interface PlannedAdvice {
  model: ModelSpec;
  changes: PlannedChange[];
  /** True when every change could be made legally. */
  ok: boolean;
}

/**
 * Applies a suggestion to a copy of the model: resizes first (checked against walls and
 * blocks at the current spot), then moves (checked and snapped by the placement rules).
 */
export function planAdvice(model: ModelSpec, s: AdviceReply['suggestions'][number]): PlannedAdvice {
  const mpp = metersPerPixel(model);
  const trial: ModelSpec = JSON.parse(JSON.stringify(model));
  const changes: PlannedChange[] = [];
  for (const rz of s.resizes) {
    const b = trial.blocks.find((x) => x.id === rz.blockId);
    if (!b) {
      changes.push({ summary: `${rz.blockId}: resize`, problem: 'no such block' });
      continue;
    }
    const st = BLOCK_STYLES[b.type];
    const before = `${r1(b.w ?? st.w)} x ${r1(b.h ?? st.h)} m`;
    if (!(rz.widthM >= 0.3 && rz.depthM >= 0.3 && rz.widthM <= 40 && rz.depthM <= 40)) {
      changes.push({ summary: `${b.label}: resize`, problem: 'the new size is not realistic' });
      continue;
    }
    const old = { w: b.w, h: b.h, x: b.x, y: b.y };
    const oldW = b.w ?? st.w;
    const oldH = b.h ?? st.h;
    b.w = r1(rz.widthM);
    b.h = r1(rz.depthM);
    // A line stays attached to its counter: keep the front end where it is and grow away from it.
    const server = b.type === 'queue'
      ? trial.blocks.find((x) => x.id === trial.links.find((l) => l.from === b.id)?.to)
      : undefined;
    if (server) {
      const rot = ((b.rotation ?? 0) * Math.PI) / 180;
      const alongX = oldW >= oldH;
      const axis = alongX ? [Math.cos(rot), Math.sin(rot)] : [-Math.sin(rot), Math.cos(rot)];
      const toServer = (server.x - b.x) * axis[0] + (server.y - b.y) * axis[1];
      const sign = toServer >= 0 ? 1 : -1;
      const oldLen = alongX ? oldW : oldH;
      const newLen = alongX ? b.w : b.h;
      const shift = (sign * (oldLen - newLen)) / 2 / mpp;
      b.x = Math.round(b.x + axis[0] * shift);
      b.y = Math.round(b.y + axis[1] * shift);
    }
    const problem = spotProblem(trial, b, b.x, b.y);
    if (problem) {
      Object.assign(b, old);
      if (old.w === undefined) delete b.w;
      if (old.h === undefined) delete b.h;
      changes.push({ summary: `${b.label}: ${before} → ${r1(rz.widthM)} x ${r1(rz.depthM)} m`, problem });
      continue;
    }
    changes.push({ summary: `${b.label}: ${before} → ${b.w} x ${b.h} m` });
  }
  for (const mv of s.moves) {
    const b = trial.blocks.find((x) => x.id === mv.blockId);
    const p: Placement = placeBlock(trial, mv.blockId, mv.xM / mpp, mv.yM / mpp);
    if (!b || !p.ok) {
      changes.push({ summary: `${b?.label ?? mv.blockId}: move`, problem: p.reason ?? 'no such block' });
      continue;
    }
    b.x = p.x;
    b.y = p.y;
    changes.push({ summary: `${b.label}: move ${r1(p.movedM)} m${p.snapped ? ' (nearest free spot)' : ''}` });
  }
  return { model: trial, changes, ok: changes.length > 0 && changes.every((c) => !c.problem) };
}
