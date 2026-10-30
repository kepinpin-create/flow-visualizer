import Ajv, { type ErrorObject } from 'ajv';
import { modelSchema } from './schema';
import type { Block, Distribution, ModelSpec } from './types';

export interface Issue {
  blockId?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  model?: ModelSpec;
}

const ajv = new Ajv({ allErrors: true, discriminator: true });
const checkSchema = ajv.compile<ModelSpec>(modelSchema);

function schemaIssue(e: ErrorObject, data: unknown): Issue {
  const m = /^\/blocks\/(\d+)/.exec(e.instancePath);
  const blocks = (data as { blocks?: { id?: unknown }[] })?.blocks;
  const id = m && blocks?.[Number(m[1])]?.id;
  const where = e.instancePath || '(model)';
  const extra = e.keyword === 'additionalProperties'
    ? ` (${(e.params as { additionalProperty: string }).additionalProperty})`
    : '';
  return { blockId: typeof id === 'string' ? id : undefined, message: `${where} ${e.message}${extra}` };
}

function checkDistribution(d: Distribution, what: string, blockId: string, errors: Issue[]) {
  if (d.dist === 'uniform' && d.min > d.max) {
    errors.push({ blockId, message: `${what}: uniform min must not exceed max` });
  }
  if (d.dist === 'triangular' && !(d.min <= d.mode && d.mode <= d.max)) {
    errors.push({ blockId, message: `${what}: triangular needs min ≤ mode ≤ max` });
  }
  if (d.dist === 'triangular' && d.min === d.max && d.max === 0) {
    errors.push({ blockId, message: `${what}: all values are zero` });
  }
}

/** Blocks reachable by following links forward (or backward) from the given starts. */
function reach(starts: string[], next: Map<string, string[]>): Set<string> {
  const seen = new Set(starts);
  const stack = [...starts];
  while (stack.length) {
    for (const n of next.get(stack.pop()!) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

/**
 * Checks a model before it may run (FR-15): schema, no orphan blocks,
 * every path reaches a Sink, Decision probabilities sum to 1.
 */
export function validateModel(data: unknown): ValidationResult {
  if (!checkSchema(data)) {
    return { ok: false, errors: (checkSchema.errors ?? []).map((e) => schemaIssue(e, data)), warnings: [] };
  }
  const model = data;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const byId = new Map<string, Block>();
  for (const b of model.blocks) {
    if (byId.has(b.id)) errors.push({ blockId: b.id, message: `Duplicate block id "${b.id}"` });
    byId.set(b.id, b);
  }

  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  const outLinks = new Map<string, typeof model.links>();
  for (const l of model.links) {
    const from = byId.get(l.from);
    const to = byId.get(l.to);
    if (!from) errors.push({ message: `Link from unknown block "${l.from}"` });
    if (!to) errors.push({ message: `Link to unknown block "${l.to}"` });
    if (!from || !to) continue;
    if (l.from === l.to) errors.push({ blockId: l.from, message: 'A block cannot link to itself' });
    if (from.type === 'resource' || to.type === 'resource') {
      errors.push({ blockId: from.type === 'resource' ? from.id : to.id, message: 'Resource blocks are not part of the flow and cannot be linked' });
      continue;
    }
    out.set(l.from, [...(out.get(l.from) ?? []), l.to]);
    into.set(l.to, [...(into.get(l.to) ?? []), l.from]);
    outLinks.set(l.from, [...(outLinks.get(l.from) ?? []), l]);
  }

  const flowBlocks = model.blocks.filter((b) => b.type !== 'resource');
  if (!flowBlocks.some((b) => b.type === 'source')) errors.push({ message: 'The model needs at least one Source' });
  if (!flowBlocks.some((b) => b.type === 'sink')) errors.push({ message: 'The model needs at least one Sink' });

  for (const b of flowBlocks) {
    const nOut = out.get(b.id)?.length ?? 0;
    const nIn = into.get(b.id)?.length ?? 0;
    const name = `"${b.label || b.id}"`;
    if (b.type === 'source' && nIn > 0) errors.push({ blockId: b.id, message: `Source ${name} cannot have incoming links` });
    if (b.type === 'sink' && nOut > 0) errors.push({ blockId: b.id, message: `Sink ${name} cannot have outgoing links` });
    if (b.type !== 'source' && nIn === 0) errors.push({ blockId: b.id, message: `${name} has no incoming link (orphan block)` });
    if (b.type !== 'sink' && nOut === 0) errors.push({ blockId: b.id, message: `${name} has no outgoing link` });
    if (b.type !== 'sink' && b.type !== 'decision' && nOut > 1) {
      errors.push({ blockId: b.id, message: `${name} has ${nOut} outgoing links; use a Decision block to split the flow` });
    }
    if (b.type === 'decision' && nOut > 0) {
      const links = outLinks.get(b.id)!;
      if (links.some((l) => l.prob === undefined)) {
        errors.push({ blockId: b.id, message: `Every output of Decision ${name} needs a probability` });
      } else {
        const sum = links.reduce((s, l) => s + l.prob!, 0);
        if (Math.abs(sum - 1) > 1e-6) {
          errors.push({ blockId: b.id, message: `Probabilities out of Decision ${name} sum to ${+sum.toFixed(4)}, not 1` });
        }
      }
    }
    if (b.type === 'queue') {
      for (const t of out.get(b.id) ?? []) {
        if (byId.get(t)?.type !== 'server') errors.push({ blockId: b.id, message: `Queue ${name} must feed a Server` });
      }
    }
    if (b.type === 'server') {
      const feeders = (into.get(b.id) ?? []).map((id) => byId.get(id)!);
      const queues = feeders.filter((f) => f.type === 'queue');
      if (queues.length > 1) errors.push({ blockId: b.id, message: `Server ${name} is fed by more than one Queue` });
      if (queues.length === 1 && feeders.length > 1) {
        errors.push({ blockId: b.id, message: `Everything entering Server ${name} must pass through its Queue` });
      }
      checkDistribution(b.service, `Service time of ${name}`, b.id, errors);
    }
    if (b.type === 'delay') checkDistribution(b.time, `Delay time of ${name}`, b.id, errors);
    if (b.type === 'source' && !('ratePerHour' in b.arrival)) {
      checkDistribution(b.arrival, `Arrivals of ${name}`, b.id, errors);
    }
  }

  // Every block must be reachable from a Source and able to reach a Sink.
  const fromSources = reach(flowBlocks.filter((b) => b.type === 'source').map((b) => b.id), out);
  const toSinks = reach(flowBlocks.filter((b) => b.type === 'sink').map((b) => b.id), into);
  for (const b of flowBlocks) {
    const name = `"${b.label || b.id}"`;
    if (!fromSources.has(b.id) && (into.get(b.id)?.length ?? 0) > 0) {
      errors.push({ blockId: b.id, message: `${name} cannot be reached from any Source` });
    }
    if (!toSinks.has(b.id) && (out.get(b.id)?.length ?? 0) > 0) {
      errors.push({ blockId: b.id, message: `No path from ${name} reaches a Sink` });
    }
  }

  for (const b of model.blocks) {
    if (b.type === 'resource') {
      warnings.push({ blockId: b.id, message: `Resource "${b.label || b.id}" is placed but not simulated in v0.1` });
    }
  }

  if (model.background?.file.startsWith('data:') && model.background.calibrated === false) {
    warnings.push({
      message: `The plan scale is not calibrated, so walking distances assume ${model.background.metersPerPixel} m per pixel. Use Calibrate to set it.`,
    });
  }

  if (model.run.warmupMin >= model.run.hours * 60) {
    errors.push({ message: 'Warm-up must be shorter than the simulation length' });
  }

  return { ok: errors.length === 0, errors, warnings, model };
}
