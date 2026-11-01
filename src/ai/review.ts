// "AI review": after a run, the AI explains the results and proposes changes.
// It only suggests. Every suggestion is then run through the real simulator,
// and the user sees measured before/after numbers (PRD: the AI never decides the numbers).
import Ajv from 'ajv';
import { mean } from '../engine/distributions';
import type { ExperimentResult } from '../engine/experiment';
import type { Estimate } from '../engine/stats';
import { footprintPx, metersPerPixel, planExtent } from '../editor/blocks';
import { isFixed, type ModelSpec } from '../model/types';
import { planChanges, type Change, type Field } from './describe';
import { placeBlock, type Placement } from './placement';

/** What the AI may change: things a manager controls. Demand (arrivals) is not on the list. */
export const LEVERS = ['servers', 'serviceMinutes', 'capacity', 'delayMinutes', 'probability'] as const satisfies readonly Field[];

export type ReviewLanguage = 'en' | 'id';

export const reviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'bottleneck', 'suggestions'],
  properties: {
    summary: { type: 'string' },
    bottleneck: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'why', 'tradeoff', 'changes', 'moves'],
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          tradeoff: { type: 'string' },
          moves: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['blockId', 'xM', 'yM'],
              properties: { blockId: { type: 'string' }, xM: { type: 'number' }, yM: { type: 'number' } },
            },
          },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['blockId', 'field', 'value', 'toBlockId'],
              properties: {
                blockId: { type: 'string' },
                field: { type: 'string', enum: LEVERS },
                value: { type: 'number' },
                toBlockId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              },
            },
          },
        },
      },
    },
  },
} as const;

export interface ReviewReply {
  summary: string;
  bottleneck: string;
  suggestions: {
    title: string;
    why: string;
    tradeoff: string;
    changes: { blockId: string; field: (typeof LEVERS)[number]; value: number; toBlockId: string | null }[];
    /** New block centers in meters from the plan's top-left corner. */
    moves: { blockId: string; xM: number; yM: number }[];
  }[];
}

export function reviewSystem(language: ReviewLanguage): string {
  return `You review the results of a queuing simulation of a real space (a bank, clinic, café, factory line, ...) for the person who runs it.
Write for a manager, not a statistician: short sentences, plain words, the key numbers with units.${language === 'id' ? '\nWrite every text field in Bahasa Indonesia.' : ''}
- summary: two or three sentences on how the space performs and what people experience (waits, crowding, people leaving).
- bottleneck: one or two sentences naming the main constraint and why, using utilization and waits.
- suggestions: up to three distinct, realistic changes that address the bottleneck. Each has a short title, why it should help,
  the tradeoff or cost (e.g. one more staff member), and concrete changes using only these fields:
  servers (a server block's parallel servers; usually +1 or +2), serviceMinutes (a server's mean service time; at most 30% faster and only if the process could plausibly be sped up),
  capacity (a queue block's line length), delayMinutes (a delay block's mean time), probability (a decision block's share to toBlockId; give every output of that decision so they sum to 1).
  Use block ids from the model. toBlockId is null except for probability. Do not change arrival rates: demand is not under the manager's control.
  moves: you may also move movable blocks to cut walking or crowding: give the new center (xM, yM) in meters from the plan's top-left corner.
  Keep blocks inside the plan, clear of walls (the wall lines are listed) and of other blocks, and on the same side of walls as their neighbours in the flow.
  Never move fixed blocks. Walking is often a small share of total time; suggest a move only when walking distances are long or paths cross.
  A suggestion may have changes, moves, or both; leave either list empty when not used.
  If the system already performs well, say so and suggest at most one change, or none.
The simulator will test every suggestion and show the measured effect, so suggest what is worth testing, not what you are sure of.`;
}

const r = (n: number, d = 2) => +n.toFixed(d);
const est = (e: Estimate, d = 2) => `${r(e.mean, d)} ±${r(e.half, d)}`;

/** Block positions, walls and walking distances in meters, so the AI can reason about moves. */
function layoutText(model: ModelSpec, distances: Record<string, number>): string {
  const mpp = metersPerPixel(model);
  const m = (px: number) => r(px * mpp, 1);
  const { width, height } = planExtent(model);
  const blocks = model.blocks.map((b) => {
    const { w, h } = footprintPx(model, b);
    return `- ${b.id}: center (${m(b.x)}, ${m(b.y)}) m, ${m(w)} x ${m(h)} m, ${isFixed(b) ? 'fixed' : 'movable'}`;
  });
  const walls = (model.walls ?? []).flatMap((wall) =>
    wall.slice(1).map((p, i) => `(${m(wall[i][0])}, ${m(wall[i][1])})-(${m(p[0])}, ${m(p[1])})`));
  const walks = model.links
    .map((l) => ({ l, d: distances[`${l.from}>${l.to}`] }))
    .filter(({ d }) => d !== undefined && d > 0)
    .map(({ l, d }) => `${l.from} → ${l.to}: ${r(d, 1)} m`);
  return `Layout (meters; x to the right, y down; plan is ${m(width)} x ${m(height)} m):
${blocks.join('\n')}
Walls (straight segments): ${walls.length ? walls.join(', ') : 'none'}
Walking distance along paths around walls: ${walks.length ? walks.join(', ') : 'none'}`;
}

/** The model and its results as compact text. No plan image is sent. */
export function reviewPrompt(model: ModelSpec, result: ExperimentResult, distances: Record<string, number> = {}): string {
  const outs = (id: string) => model.links.filter((l) => l.from === id);
  const blocks = model.blocks.filter((b) => b.type !== 'resource').map((b) => {
    switch (b.type) {
      case 'source':
        return `- ${b.id}: source "${b.label}", ${r('ratePerHour' in b.arrival ? b.arrival.ratePerHour : 60 / mean(b.arrival))} arrivals/h`;
      case 'queue':
        return `- ${b.id}: queue "${b.label}", capacity ${b.capacity ?? 'unlimited'}${b.balkThreshold ? `, people leave if ${b.balkThreshold}+ waiting` : ''}`;
      case 'server':
        return `- ${b.id}: server "${b.label}", ${b.servers} servers, mean service ${r(mean(b.service))} min (${b.service.dist})`;
      case 'delay':
        return `- ${b.id}: delay "${b.label}", mean ${r(mean(b.time))} min`;
      case 'decision':
        return `- ${b.id}: decision "${b.label}", ${outs(b.id).map((l) => `${Math.round((l.prob ?? 0) * 100)}% to ${l.to}`).join(', ')}`;
      case 'sink':
        return `- ${b.id}: sink "${b.label}"`;
    }
  });
  const flow = model.links.filter((l) => model.blocks.find((b) => b.id === l.from)?.type !== 'decision').map((l) => `${l.from} → ${l.to}`);
  const stations = result.stations.map((s) =>
    `- ${s.id} "${s.label}": ${s.servers} servers, utilization ${est({ mean: s.utilization.mean * 100, half: s.utilization.half * 100 }, 1)}%, ` +
    `mean wait ${est(s.wqMean)} min, 90th percentile wait ${est(s.wqP90)} min, mean line ${est(s.lqMean)}, longest line ${est(s.lqMax, 1)}${s.bottleneck ? ' (bottleneck)' : ''}`);
  const s = result.system;
  return `Model (${model.entityLabel}s; ${model.run.hours} h simulated, ${model.run.replications} replications, ±95% confidence):
${blocks.join('\n')}
Flow: ${flow.join(', ')}

Results per station:
${stations.join('\n')}

Whole system: throughput ${est(s.throughputPerHour, 1)}/h, time in system ${est(s.W)} min, ${est(s.L)} in system on average, ` +
    `${est({ mean: s.balkRate.mean * 100, half: s.balkRate.half * 100 }, 1)}% left without service, walking ${est(s.travelMeanM, 1)} m each.
${result.warnings.length ? `Warnings: ${result.warnings.map((w) => w.message).join(' ')}` : ''}

${layoutText(model, distances)}`;
}

export interface Move {
  blockId: string;
  label: string;
  placement: Placement;
  /** "Ticket kiosk: move 3.2 m (nearest free spot to the AI's choice)" */
  summary: string;
}

/** Checks each suggested move against walls, other blocks and walking paths, snapping to a nearby valid spot if needed. */
export function suggestionMoves(model: ModelSpec, s: ReviewReply['suggestions'][number]): Move[] {
  const mpp = metersPerPixel(model);
  return s.moves.map((mv) => {
    const b = model.blocks.find((x) => x.id === mv.blockId);
    const label = b?.label || mv.blockId;
    const placement = placeBlock(model, mv.blockId, mv.xM / mpp, mv.yM / mpp);
    const summary = placement.ok
      ? `${label}: move ${placement.movedM.toFixed(1)} m${placement.snapped ? ' (nearest free spot to the AI’s choice)' : ''}`
      : `${label}: cannot move (${placement.reason})`;
    return { blockId: mv.blockId, label, placement, summary };
  });
}

/** Puts the moved blocks at their checked positions. */
export function applyMoves(model: ModelSpec, moves: Move[]) {
  for (const mv of moves) {
    const b = model.blocks.find((x) => x.id === mv.blockId);
    if (b && mv.placement.ok) {
      b.x = mv.placement.x;
      b.y = mv.placement.y;
    }
  }
}

const ajv = new Ajv({ allErrors: true });
const checkReply = ajv.compile<ReviewReply>(reviewSchema);

export function parseReviewReply(text: string): ReviewReply {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The AI reply was not valid JSON.');
  }
  if (!checkReply(data)) throw new Error('The AI reply did not match the expected format.');
  return data;
}

/** Checks a suggestion's changes against the model, using the same rules as AI fill. */
export function suggestionChanges(model: ModelSpec, s: ReviewReply['suggestions'][number]): Change[] {
  return planChanges(model, {
    updates: s.changes.map((c) => ({ ...c, evidence: s.title })),
    unmatched: '',
  });
}

// ---- explaining an optimized layout ----

export const layoutExplainSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['explanation'],
  properties: { explanation: { type: 'string' } },
} as const;

export function layoutExplainSystem(language: ReviewLanguage): string {
  return `You explain a proposed rearrangement of a floor layout to the manager of the space, in three to five short sentences of plain words.
The layout was optimized by an algorithm that lowers walking load (people per hour × meters walked): busy areas move closer together and to the entrance, quiet areas move further away.
Explain which blocks moved and why, using the flows (people per hour) and distances given, and what the simulator measured. Be honest when the effect on waiting is small.${language === 'id' ? '\nWrite in Bahasa Indonesia.' : ''}`;
}

export function layoutExplainPrompt(
  model: ModelSpec,
  flows: Map<string, number>,
  before: Record<string, number>,
  after: Record<string, number>,
  moves: { label: string; movedM: number }[],
  load: { before: number; after: number },
  comparison: Comparison | null,
): string {
  const label = (id: string) => model.blocks.find((b) => b.id === id)?.label ?? id;
  const links = model.links
    .map((l) => ({ l, k: `${l.from}>${l.to}` }))
    .filter(({ k }) => (flows.get(k) ?? 0) > 0 && (before[k] ?? 0) > 0)
    .map(({ l, k }) => `- ${label(l.from)} → ${label(l.to)}: ${r(flows.get(k)!, 1)} people/h, ${r(before[k], 1)} m → ${r(after[k] ?? before[k], 1)} m`);
  const measured = comparison
    ? comparison.metrics.map((m) => `${m.label}: ${r(m.before.mean)} → ${r(m.after.mean)} ${m.unit} (${m.neutral ? 'context' : m.verdict})`).join('; ')
    : 'not measured';
  return `Moves: ${moves.map((m) => `${m.label} moved ${r(m.movedM, 1)} m`).join('; ')}
Walking load: ${r(load.before)} → ${r(load.after)} people·m per hour
Paths (flow, distance before → after):
${links.join('\n')}
Simulator, before → after: ${measured}`;
}

export type Verdict = 'better' | 'worse' | 'unclear';

export interface MetricChange {
  label: string;
  unit: string;
  before: Estimate;
  after: Estimate;
  /** Whether a lower value is better for this metric. */
  lowerIsBetter: boolean;
  /** Shown for context only (e.g. utilization: lower means idler staff, not simply better). */
  neutral: boolean;
  verdict: Verdict;
}

export interface Comparison {
  metrics: MetricChange[];
  /** Judged on time in system, the number every visitor feels. */
  overall: Verdict;
}

/** Non-overlapping 95% intervals count as a clear change; overlapping ones as "unclear". */
function judge(before: Estimate, after: Estimate, lowerIsBetter: boolean): Verdict {
  const bh = Number.isFinite(before.half) ? before.half : 0;
  const ah = Number.isFinite(after.half) ? after.half : 0;
  if (after.mean + ah < before.mean - bh) return lowerIsBetter ? 'better' : 'worse';
  if (after.mean - ah > before.mean + bh) return lowerIsBetter ? 'worse' : 'better';
  return 'unclear';
}

/** Before/after on the measures a manager cares about. Both runs use the same seed, so differences come from the change. */
export function compareRuns(before: ExperimentResult, after: ExperimentResult, entity: string): Comparison {
  const worst = (r: ExperimentResult) => r.stations.reduce((a, s) => (s.utilization.mean > a.utilization.mean ? s : a), r.stations[0]);
  const pct = (e: Estimate): Estimate => ({ mean: e.mean * 100, half: e.half * 100 });
  const metric = (label: string, unit: string, b: Estimate, a: Estimate, lowerIsBetter = true, neutral = false): MetricChange =>
    ({ label, unit, before: b, after: a, lowerIsBetter, neutral, verdict: neutral ? 'unclear' : judge(b, a, lowerIsBetter) });
  const metrics: MetricChange[] = [
    metric('Time in system', 'min', before.system.W, after.system.W),
    metric('Longest average wait at a station', 'min',
      before.stations.reduce((a, s) => (s.wqMean.mean > a.mean ? s.wqMean : a), { mean: 0, half: 0 }),
      after.stations.reduce((a, s) => (s.wqMean.mean > a.mean ? s.wqMean : a), { mean: 0, half: 0 })),
    metric('Busiest station utilization', '%', pct(worst(before).utilization), pct(worst(after).utilization), true, true),
    metric(`Walking per ${entity}`, 'm', before.system.travelMeanM, after.system.travelMeanM),
    metric(`${entity[0].toUpperCase()}${entity.slice(1)}s leaving without service`, '%', pct(before.system.balkRate), pct(after.system.balkRate)),
    metric('Throughput', '/h', before.system.throughputPerHour, after.system.throughputPerHour, false),
  ];
  return { metrics, overall: metrics[0].verdict };
}
