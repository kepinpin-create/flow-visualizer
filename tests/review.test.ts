import { describe, expect, it } from 'vitest';
import { applyChanges } from '../src/ai/describe';
import { compareRuns, parseReviewReply, reviewPrompt, reviewSchema, suggestionChanges, type ReviewReply } from '../src/ai/review';
import { runExperiment } from '../src/engine/experiment';
import bank from '../src/templates/bank.json';
import { valid } from './helpers';

// A busy bank: 40 customers an hour on 3 tellers at 4 minutes each (ρ ≈ 0.89).
const busy = valid({ ...bank, blocks: bank.blocks.map((b) => (b.type === 'source' ? { ...b, arrival: { dist: 'exponential', ratePerHour: 40 } } : b)) });
const before = runExperiment(busy);

const reply: ReviewReply = {
  summary: 'Tellers are busy most of the day.',
  bottleneck: 'The three tellers are about 89% busy.',
  suggestions: [
    { title: 'Open a fourth teller', why: 'More capacity', tradeoff: 'One more staff member', changes: [{ blockId: 'tellers', field: 'servers', value: 4, toBlockId: null }], moves: [] },
    { title: 'Speed up a little', why: 'Shorter service', tradeoff: 'Training', changes: [{ blockId: 'tellers', field: 'serviceMinutes', value: 3.95, toBlockId: null }], moves: [] },
    { title: 'Bad idea', why: '', tradeoff: '', changes: [{ blockId: 'exit', field: 'servers', value: 2, toBlockId: null }], moves: [] },
  ],
};

describe('AI review', () => {
  it('sends numbers and block names, never the plan image', () => {
    const text = reviewPrompt(busy, before);
    expect(text).toMatch(/tellers: server "Tellers", 3 servers, mean service 4 min/);
    expect(text).toMatch(/utilization \d+(\.\d)? ±/);
    expect(text).not.toMatch(/data:image/);
  });

  it('keeps arrivals out of what the AI may change', () => {
    const fields = reviewSchema.properties.suggestions.items.properties.changes.items.properties.field.enum;
    expect(fields).not.toContain('arrivalsPerHour');
    expect(() => parseReviewReply(JSON.stringify({ ...reply, suggestions: [{ ...reply.suggestions[0], changes: [{ blockId: 'entrance', field: 'arrivalsPerHour', value: 10, toBlockId: null }] }] })))
      .toThrow(/expected format/);
  });

  it('refuses a change that does not fit the block, so it is never tested', () => {
    const changes = suggestionChanges(busy, parseReviewReply(JSON.stringify(reply)).suggestions[2]);
    expect(changes[0].problem).toMatch(/is a sink, not a server/);
  });

  it('measures a real improvement as clearly better', () => {
    const trial = JSON.parse(JSON.stringify(busy));
    applyChanges(trial, suggestionChanges(busy, reply.suggestions[0]));
    const c = compareRuns(before, runExperiment(trial), 'customer');
    expect(c.overall).toBe('better');
    expect(c.metrics[0].after.mean).toBeLessThan(c.metrics[0].before.mean);
    expect(c.metrics.find((m) => m.label.startsWith('Busiest'))!.neutral).toBe(true);
  });

  it('calls a tiny change "no clear difference" instead of claiming a win', () => {
    const trial = JSON.parse(JSON.stringify(busy));
    applyChanges(trial, suggestionChanges(busy, reply.suggestions[1]));
    expect(compareRuns(before, runExperiment(trial), 'customer').overall).toBe('unclear');
  });
});
