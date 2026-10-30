import { describe, expect, it } from 'vitest';
import { deleteBlock, linkProblem, newBlock, splitEvenly } from '../src/editor/blocks';
import { Store } from '../src/editor/store';
import { validateModel } from '../src/model/validate';
import bar from '../src/templates/bar.json';
import { valid } from './helpers';

describe('Store undo/redo (FR-09)', () => {
  it('undoes and redoes a commit', () => {
    const s = new Store(valid(bar));
    s.commit((m) => { m.blocks[0].label = 'Front door'; });
    expect(s.model.blocks[0].label).toBe('Front door');
    s.undo();
    expect(s.model.blocks[0].label).toBe('Door');
    s.redo();
    expect(s.model.blocks[0].label).toBe('Front door');
  });

  it('treats a whole drag as one step', () => {
    const s = new Store(valid(bar));
    s.beginGesture();
    for (let i = 1; i <= 5; i++) s.live((m) => { m.blocks[0].x = 100 + i * 10; });
    s.endGesture();
    expect(s.model.blocks[0].x).toBe(150);
    s.undo();
    expect(s.model.blocks[0].x).toBe(100);
    expect(s.canUndo).toBe(false);
  });

  it('records nothing for a click without movement', () => {
    const s = new Store(valid(bar));
    s.beginGesture();
    s.endGesture();
    expect(s.canUndo).toBe(false);
  });

  it('clears a selection that undo removes', () => {
    const s = new Store(valid(bar));
    s.commit((m) => { m.blocks.push(newBlock(m, 'sink', 0, 0)); });
    s.select({ kind: 'block', id: 'sink_1' });
    s.undo();
    expect(s.selection).toBeNull();
  });
});

describe('editing rules', () => {
  const m = valid(bar);

  it('refuses links the engine cannot run', () => {
    expect(linkProblem(m, 'seats', 'bar')).toMatch(/already has an outgoing link/);
    expect(linkProblem(m, 'bar_queue', 'seats')).toMatch(/only link to a Server/);
    expect(linkProblem(m, 'exit', 'door')).toMatch(/no outgoing links/);
    expect(linkProblem(m, 'split', 'split')).toMatch(/itself/);
    expect(linkProblem(m, 'split', 'exit')).toBeNull();
  });

  it('splits a decision evenly with probabilities summing to 1', () => {
    const copy = structuredClone(m);
    copy.links.push({ from: 'split', to: 'exit' });
    splitEvenly(copy, 'split');
    const probs = copy.links.filter((l) => l.from === 'split').map((l) => l.prob!);
    expect(probs).toEqual([0.333, 0.333, 0.334]);
    expect(validateModel(copy).errors.filter((e) => /sum to/.test(e.message))).toHaveLength(0);
  });

  it('removes a block together with its links', () => {
    const copy = structuredClone(m);
    deleteBlock(copy, 'seats');
    expect(copy.links.some((l) => l.from === 'seats' || l.to === 'seats')).toBe(false);
  });

  it('creates new blocks that pass the schema with unique ids', () => {
    const copy = structuredClone(m);
    for (const t of ['source', 'queue', 'server', 'resource', 'delay', 'decision', 'sink'] as const) {
      copy.blocks.push(newBlock(copy, t, 10, 10));
    }
    copy.blocks.push(newBlock(copy, 'server', 20, 20));
    expect(new Set(copy.blocks.map((b) => b.id)).size).toBe(copy.blocks.length);
    expect(validateModel(copy).model).toBeDefined();
  });
});
