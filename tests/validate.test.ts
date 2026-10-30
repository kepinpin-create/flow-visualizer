import { describe, expect, it } from 'vitest';
import { validateModel } from '../src/model/validate';
import bank from '../src/templates/bank.json';
import bar from '../src/templates/bar.json';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const messages = (data: unknown) => validateModel(data).errors.map((e) => e.message).join('\n');

describe('validateModel (FR-15)', () => {
  it('accepts both templates', () => {
    expect(validateModel(bank).ok).toBe(true);
    expect(validateModel(bar).ok).toBe(true);
  });

  it('rejects a missing required field', () => {
    const m = clone(bank) as { blocks: Record<string, unknown>[] };
    delete m.blocks[2].servers;
    const r = validateModel(m);
    expect(r.ok).toBe(false);
    expect(r.errors[0].blockId).toBe('tellers');
  });

  it('rejects an orphan block', () => {
    const m = clone(bank);
    m.blocks.push({ id: 'lost', type: 'sink', label: 'Lost', x: 0, y: 0, origin: 'user' });
    expect(messages(m)).toMatch(/"Lost" has no incoming link/);
  });

  it('rejects decision probabilities that do not sum to 1', () => {
    const m = clone(bar);
    m.links[2].prob = 0.3;
    expect(messages(m)).toMatch(/sum to 1\.1, not 1/);
  });

  it('rejects a self-link', () => {
    const m = clone(bar);
    m.links.push({ from: 'seats', to: 'seats' });
    expect(messages(m)).toMatch(/cannot link to itself/);
  });

  it('flags a block with no route to any sink', () => {
    const m = clone(bar);
    // Seating loops back to the decision forever instead of leaving.
    m.links[5] = { from: 'seats', to: 'split' };
    m.blocks = m.blocks.filter((b) => b.id !== 'exit');
    expect(messages(m)).toMatch(/needs at least one Sink/);
    expect(messages(m)).toMatch(/No path from "Seating" reaches a Sink/);
  });

  it('requires a queue to feed a server', () => {
    const m = clone(bank);
    m.links[1].to = 'exit';
    m.links.splice(2, 1);
    expect(messages(m)).toMatch(/must feed a Server/);
  });

  it('rejects a triangular with mode outside min..max', () => {
    const m = clone(bar);
    (m.blocks[4] as { time: { mode: number } }).time.mode = 90;
    expect(messages(m)).toMatch(/min ≤ mode ≤ max/);
  });
});
