import { describe, expect, it } from 'vitest';
import { placeBlock, spotProblem } from '../src/ai/placement';
import { applyMoves, compareRuns, suggestionMoves } from '../src/ai/review';
import { runExperiment } from '../src/engine/experiment';
import { isFixed, type ModelSpec } from '../src/model/types';
import { computeRoutes, routeDistances } from '../src/routing/pathfinder';
import bar from '../src/templates/bar.json';
import { valid } from './helpers';

// Bar template: 50 px per meter, an outer wall box from (40, 40) to (900, 700) px.
const model = valid(bar);
const block = (id: string) => model.blocks.find((b) => b.id === id)!;

describe('where the AI may put a block', () => {
  it('keeps entrances and exits in place by default, and respects the user lock', () => {
    expect(isFixed(block('door'))).toBe(true);
    expect(isFixed(block('seats'))).toBe(false);
    expect(placeBlock(model, 'door', 300, 300)).toMatchObject({ ok: false, reason: expect.stringMatching(/fixed in place/) });
    const locked: ModelSpec = { ...model, blocks: model.blocks.map((b) => (b.id === 'seats' ? { ...b, fixed: true } : b)) };
    expect(placeBlock(locked, 'seats', 300, 300).ok).toBe(false);
  });

  it('accepts a free spot as given', () => {
    const p = placeBlock(model, 'seats', 700, 500);
    expect(p).toMatchObject({ ok: true, x: 700, y: 500, snapped: false });
    expect(p.movedM).toBeCloseTo(6, 1); // 300 px down at 50 px/m
  });

  it('refuses a spot on a wall and snaps to the nearest clear one inside', () => {
    expect(spotProblem(model, block('seats'), 890, 400)).toMatch(/hit a wall|stick out/);
    const p = placeBlock(model, 'seats', 890, 400);
    expect(p.ok && p.snapped).toBe(true);
    expect(spotProblem(model, block('seats'), p.x, p.y)).toBeNull();
    expect(p.x).toBeLessThan(900);
  });

  it('refuses a spot on top of another block', () => {
    const bartender = block('bar');
    // With a 1 m aisle kept around every block, the bar's line beside it clashes too.
    expect(spotProblem(model, block('seats'), bartender.x, bartender.y)).toMatch(/overlap (Bartender|Bar line)/);
    const p = placeBlock(model, 'seats', bartender.x, bartender.y);
    expect(p.ok && p.snapped).toBe(true);
  });

  it('never leaves a block sealed off by walls', () => {
    // A closed room around (300, 200); the AI asks for its middle.
    const room: ModelSpec = { ...model, walls: [...(model.walls ?? []), [[220, 120], [380, 120], [380, 280], [220, 280], [220, 120]]] };
    const p = placeBlock(room, 'seats', 300, 200);
    if (p.ok) {
      const inside = p.x > 220 && p.x < 380 && p.y > 120 && p.y < 280;
      expect(inside).toBe(false);
    } else {
      expect(p.reason).toMatch(/no free spot/);
    }
  });
});

describe('testing a move', () => {
  it('measures shorter walking when the seats move next to the exit', () => {
    const before = runExperiment(model, { distance: (a, b) => routeDistances(computeRoutes(model, 1000, 750))[`${a}>${b}`] });
    const moves = suggestionMoves(model, { title: 'Seats by the door', why: '', tradeoff: '', changes: [], moves: [{ blockId: 'seats', xM: 5, yM: 11 }] });
    expect(moves[0].placement.ok).toBe(true);
    const trial: ModelSpec = JSON.parse(JSON.stringify(model));
    applyMoves(trial, moves);
    const dist = routeDistances(computeRoutes(trial, 1000, 750));
    const after = runExperiment(trial, { distance: (a, b) => dist[`${a}>${b}`] });
    const walking = compareRuns(before, after, 'customer').metrics.find((m) => m.label.startsWith('Walking'))!;
    expect(walking.verdict).toBe('better');
    expect(walking.after.mean).toBeLessThan(walking.before.mean);
  });
});
