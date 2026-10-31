import { describe, expect, it } from 'vitest';
import { applySuggestion, type LayoutReply } from '../src/ai/layout';
import { cleanWalls, cutDoorAt, cutDoors, MIN_DOOR_M, type Seg } from '../src/ai/walls';
import { validateModel } from '../src/model/validate';
import { computeRoutes, routeKey } from '../src/routing/pathfinder';
import bank from '../src/templates/bank.json';

const MPP = 0.02; // 50 px per meter
const m = (meters: number) => meters / MPP;

describe('cleaning the AI’s wall lines', () => {
  it('straightens a slightly tilted wall', () => {
    const [w] = cleanWalls([{ x1: 100, y1: 100, x2: 600, y2: 112 }], MPP);
    expect(w.y1).toBe(w.y2);
    expect(w.y1).toBeCloseTo(106, 6);
  });

  it('leaves a clearly diagonal wall alone', () => {
    const [w] = cleanWalls([{ x1: 100, y1: 100, x2: 400, y2: 400 }], MPP);
    expect([w.x1, w.y1, w.x2, w.y2]).toEqual([100, 100, 400, 400]);
  });

  it('joins a wall the AI drew in broken pieces', () => {
    const walls = cleanWalls([
      { x1: 100, y1: 200, x2: 300, y2: 203 },
      { x1: 310, y1: 198, x2: 600, y2: 200 }, // 10 px = 0.2 m gap, a few px off line
    ], MPP);
    expect(walls).toHaveLength(1);
    expect([walls[0].x1, walls[0].x2]).toEqual([100, 600]);
  });

  it('closes corners that stop just short', () => {
    const walls = cleanWalls([
      { x1: 100, y1: 100, x2: 580, y2: 100 }, // stops 20 px (0.4 m) before the right wall
      { x1: 600, y1: 110, x2: 600, y2: 500 }, // starts 10 px below the top wall
    ], MPP);
    const top = walls.find((w) => w.y1 === w.y2)!;
    const right = walls.find((w) => w.x1 === w.x2)!;
    expect(top.x2).toBe(600);
    expect(right.y1).toBe(100);
  });

  it('drops scraps shorter than 30 cm', () => {
    expect(cleanWalls([{ x1: 0, y1: 0, x2: 10, y2: 0 }], MPP)).toHaveLength(0);
  });
});

describe('doorways', () => {
  const wall: Seg = { x1: 0, y1: 300, x2: 1000, y2: 300 };

  it('opens a gap of at least 0.9 m where the AI saw a door, even if it was a little off', () => {
    const { walls, opened } = cutDoors([wall], [{ x: 500, y: 320, widthM: 0.6 }], MPP); // 0.4 m off the wall, too narrow
    expect(opened).toBe(1);
    expect(walls).toHaveLength(2);
    const gap = walls[1].x1 - walls[0].x2;
    expect(gap).toBeCloseTo(m(MIN_DOOR_M), 6);
    expect((walls[0].x2 + walls[1].x1) / 2).toBeCloseTo(500, 6);
  });

  it('ignores a "door" far from any wall', () => {
    expect(cutDoors([wall], [{ x: 500, y: 600, widthM: null }], MPP).opened).toBe(0);
  });

  it('lets the Door tool split a wall polyline where you click', () => {
    const walls = cutDoorAt([[[0, 0], [1000, 0], [1000, 600]]], [400, 5], m(1), m(0.6))!;
    expect(walls).toHaveLength(2);
    expect(walls[0]).toEqual([[0, 0], [375, 0]]);
    expect(walls[1]).toEqual([[425, 0], [1000, 0], [1000, 600]]);
    expect(cutDoorAt([[[0, 0], [1000, 0]]], [400, 300], m(1), m(0.6))).toBeNull();
  });
});

describe('AI layout with walls', () => {
  // A rough room: four walls slightly off, a gap-less left wall with a door the AI listed.
  const reply: LayoutReply = {
    blocks: [
      { id: 'door', type: 'source', label: 'Door', x: 30, y: 500, widthM: null, depthM: null, servers: null, arrivalsPerHour: 20, minutes: null, capacity: null },
      { id: 'desk', type: 'server', label: 'Desk', x: 500, y: 500, widthM: null, depthM: null, servers: 1, arrivalsPerHour: null, minutes: 2, capacity: null },
      { id: 'out', type: 'sink', label: 'Out', x: 30, y: 600, widthM: null, depthM: null, servers: null, arrivalsPerHour: null, minutes: null, capacity: null },
    ],
    links: [{ from: 'door', to: 'desk', probability: null }, { from: 'desk', to: 'out', probability: null }],
    walls: [
      { x1: 100, y1: 100, x2: 905, y2: 104 },
      { x1: 902, y1: 98, x2: 898, y2: 900 },
      { x1: 900, y1: 903, x2: 100, y2: 897 },
      { x1: 101, y1: 900, x2: 99, y2: 100 },
    ],
    doors: [{ x: 100, y: 550, widthM: null }],
    notes: '',
  };
  const base = validateModel({ ...bank, blocks: [], links: [], background: { file: '', metersPerPixel: 0.02, width: 1000, height: 1000 } }).model!;
  const applied = applySuggestion(base, reply, { width: 1000, height: 1000 }, 'replace', { withWalls: true });

  it('adds clean walls with the door open', () => {
    expect(applied.doors).toBe(1);
    expect(applied.walls).toBe(5); // four walls, the left one split by the doorway
    for (const [[x1, y1], [x2, y2]] of applied.model.walls!) expect(x1 === x2 || y1 === y2).toBe(true);
  });

  it('lets people walk in through the doorway', () => {
    const routes = computeRoutes(applied.model, 1000, 1000);
    expect(routes.get(routeKey('door', 'desk'))!.noPath).toBe(false);
  });

  it('leaves walls alone when wall detection is off', () => {
    const noWalls = applySuggestion(base, reply, { width: 1000, height: 1000 }, 'replace', { withWalls: false });
    expect(noWalls.walls).toBe(0);
    expect(noWalls.model.walls ?? []).toHaveLength(0);
  });
});
