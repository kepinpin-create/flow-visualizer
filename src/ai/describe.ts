// "Fill from description": plain words ("30 customers an hour, 3 tellers, about 4 minutes each")
// become proposed parameter changes. Each one is shown to the user, who ticks what to apply.
import Ajv from 'ajv';
import { mean } from '../engine/distributions';
import type { Block, Distribution, ModelSpec, NeedsInput } from '../model/types';

export const FIELDS = ['arrivalsPerHour', 'servers', 'serviceMinutes', 'delayMinutes', 'capacity', 'probability'] as const;
export type Field = (typeof FIELDS)[number];

export const describeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['updates', 'unmatched'],
  properties: {
    updates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['blockId', 'field', 'value', 'toBlockId', 'evidence'],
        properties: {
          blockId: { type: 'string' },
          field: { type: 'string', enum: FIELDS },
          value: { type: 'number' },
          toBlockId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          evidence: { type: 'string' },
        },
      },
    },
    unmatched: { type: 'string' },
  },
} as const;

export interface DescribeReply {
  updates: { blockId: string; field: Field; value: number; toBlockId: string | null; evidence: string }[];
  unmatched: string;
}

export const DESCRIBE_SYSTEM = `You fill in parameters of an existing queuing-simulation model from the user's description.
Fields you may set:
- arrivalsPerHour: on a source block (arrivals per hour; convert "every 2 minutes" to 30).
- servers: on a server block (number of parallel servers).
- serviceMinutes: on a server block (mean service time in minutes).
- delayMinutes: on a delay block (mean time spent in minutes).
- capacity: on a queue block (most people who fit in the line).
- probability: on a decision block, for the share going to toBlockId (0 to 1; "80%" is 0.8).
Rules:
- Only use numbers the user actually stated or that follow directly from them. Never guess.
- blockId and toBlockId must be ids from the model listed below; toBlockId is null except for probability.
- evidence: the user's words the number came from, quoted briefly.
- unmatched: anything in the description you could not map to a block, or an empty string.`;

export function describePrompt(model: ModelSpec, description: string): string {
  const outs = (id: string) => model.links.filter((l) => l.from === id).map((l) => l.to);
  const lines = model.blocks
    .filter((b) => b.type !== 'resource')
    .map((b) => {
      const extra = b.type === 'decision' ? ` (outputs to: ${outs(b.id).join(', ') || 'none'})` : '';
      return `- ${b.id}: ${b.type} "${b.label}"${extra}`;
    });
  return `Model blocks:\n${lines.join('\n')}\n\nDescription from the user:\n${description.trim()}`;
}

const ajv = new Ajv({ allErrors: true });
const checkReply = ajv.compile<DescribeReply>(describeSchema);

export function parseDescribeReply(text: string): DescribeReply {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The AI reply was not valid JSON.');
  }
  if (!checkReply(data)) throw new Error('The AI reply did not match the expected format.');
  return data;
}

/** One proposed change, ready to show with a checkbox. */
export interface Change {
  blockId: string;
  field: Field;
  value: number;
  toBlockId: string | null;
  evidence: string;
  /** "Tellers: servers 1 → 3" */
  summary: string;
  /** Why it cannot be applied, if so. */
  problem?: string;
}

/** Same kind of distribution with a new mean, so a user's chosen shape is kept. */
export function withMean(d: Distribution, m: number): Distribution {
  const old = mean(d) || 1;
  const f = m / old;
  switch (d.dist) {
    case 'fixed': return { dist: 'fixed', valueMin: m };
    case 'exponential': return { dist: 'exponential', meanMin: m };
    case 'normal': return { dist: 'normal', meanMin: m, sdMin: +(d.sdMin * f).toFixed(3) };
    case 'uniform': return { dist: 'uniform', min: +(d.min * f).toFixed(3), max: +(d.max * f).toFixed(3) };
    case 'triangular': return { dist: 'triangular', min: +(d.min * f).toFixed(3), mode: +(d.mode * f).toFixed(3), max: +(d.max * f).toFixed(3) };
  }
}

const NEEDS: Partial<Record<Field, NeedsInput>> = {
  arrivalsPerHour: 'arrival', servers: 'servers', serviceMinutes: 'service', delayMinutes: 'time', probability: 'routing',
};

const r = (n: number) => +n.toFixed(2);

/** Checks each proposed update against the model and words it for review. */
export function planChanges(model: ModelSpec, reply: DescribeReply): Change[] {
  const byId = new Map(model.blocks.map((b) => [b.id, b]));
  return reply.updates.map((u) => {
    const b = byId.get(u.blockId);
    const name = b?.label || u.blockId;
    const c: Change = { ...u, summary: '' };
    const need = (type: Block['type']) => {
      if (!b) c.problem = `There is no block "${u.blockId}".`;
      else if (b.type !== type) c.problem = `${name} is a ${b.type}, not a ${type}.`;
      return !c.problem;
    };
    const positive = () => {
      if (!(u.value > 0)) c.problem = 'The value must be above zero.';
      return !c.problem;
    };
    switch (u.field) {
      case 'arrivalsPerHour':
        if (need('source') && positive() && b?.type === 'source') {
          const now = 'ratePerHour' in b.arrival ? b.arrival.ratePerHour : 60 / mean(b.arrival);
          c.summary = `${name}: arrivals ${r(now)}/h → ${r(u.value)}/h`;
        }
        break;
      case 'servers':
        if (need('server') && positive() && b?.type === 'server') {
          if (!Number.isInteger(u.value)) c.problem = 'Servers must be a whole number.';
          c.summary = `${name}: servers ${b.servers} → ${u.value}`;
        }
        break;
      case 'serviceMinutes':
        if (need('server') && positive() && b?.type === 'server') c.summary = `${name}: mean service ${r(mean(b.service))} → ${r(u.value)} min`;
        break;
      case 'delayMinutes':
        if (need('delay') && positive() && b?.type === 'delay') c.summary = `${name}: mean time ${r(mean(b.time))} → ${r(u.value)} min`;
        break;
      case 'capacity':
        if (need('queue') && positive() && b?.type === 'queue') {
          if (!Number.isInteger(u.value)) c.problem = 'Capacity must be a whole number.';
          c.summary = `${name}: line capacity ${b.capacity ?? 'unlimited'} → ${u.value}`;
        }
        break;
      case 'probability': {
        if (!need('decision')) break;
        const link = model.links.find((l) => l.from === u.blockId && l.to === u.toBlockId);
        if (!link) c.problem = `${name} has no output to "${u.toBlockId}".`;
        else if (u.value < 0 || u.value > 1) c.problem = 'A probability must be between 0 and 1.';
        const to = byId.get(u.toBlockId ?? '')?.label ?? u.toBlockId;
        c.summary = `${name} → ${to}: ${link?.prob === undefined ? '?' : Math.round(link.prob * 100) + '%'} → ${Math.round(u.value * 100)}%`;
        break;
      }
    }
    if (!c.summary) c.summary = `${name}: ${u.field} → ${u.value}`;
    // The old number was only the AI's placeholder, so "4 → 4" would mislead; say what really happens.
    const flag = NEEDS[u.field];
    if (!c.problem && flag && b?.needsInput?.includes(flag) && flag !== 'routing') {
      c.summary = c.summary.replace(/ [^ ]+ → /, ' → ').replace(/$/, ' (replaces the placeholder)');
    }
    return c;
  });
}

/** Applies the chosen changes in place and clears the matching "needs input" flags. */
export function applyChanges(model: ModelSpec, changes: Change[]) {
  for (const c of changes) {
    if (c.problem) continue;
    const b = model.blocks.find((x) => x.id === c.blockId);
    if (!b) continue;
    switch (c.field) {
      case 'arrivalsPerHour':
        if (b.type === 'source') b.arrival = { dist: b.arrival.dist === 'fixed' && 'ratePerHour' in b.arrival ? 'fixed' : 'exponential', ratePerHour: c.value };
        break;
      case 'servers':
        if (b.type === 'server') b.servers = c.value;
        break;
      case 'serviceMinutes':
        if (b.type === 'server') b.service = withMean(b.service, c.value);
        break;
      case 'delayMinutes':
        if (b.type === 'delay') b.time = withMean(b.time, c.value);
        break;
      case 'capacity':
        if (b.type === 'queue') b.capacity = c.value;
        break;
      case 'probability': {
        const link = model.links.find((l) => l.from === c.blockId && l.to === c.toBlockId);
        if (link) link.prob = c.value;
        break;
      }
    }
    const flag = NEEDS[c.field];
    // Routing is only settled once the probabilities add up; other fields are settled by one value.
    if (flag && b.needsInput && flag !== 'routing') b.needsInput = b.needsInput.filter((n) => n !== flag);
    if (flag === 'routing' && b.needsInput) {
      const sum = model.links.filter((l) => l.from === b.id).reduce((s, l) => s + (l.prob ?? 0), 0);
      if (Math.abs(sum - 1) < 1e-6) b.needsInput = b.needsInput.filter((n) => n !== 'routing');
    }
    if (b.needsInput && !b.needsInput.length) delete b.needsInput;
  }
}
