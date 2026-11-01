// Rooms from the walls: thicken the walls enough to close doorways, then group the floor
// that is left into connected areas. Each area is a room. Used to keep blocks in their room.
import { metersPerPixel } from '../editor/blocks';
import type { ModelSpec } from '../model/types';
import { buildGrid } from '../routing/pathfinder';

/** Doorways up to about twice this wide are treated as closed when telling rooms apart, meters. */
const CLOSE_DOORS_M = 1.0;

export interface Rooms {
  /** Room number at a plan point (−1 outside any room); 0 when there are no walls. */
  at(x: number, y: number): number;
  count: number;
}

export function findRooms(model: ModelSpec, width: number, height: number): Rooms {
  if (!model.walls?.length) return { at: () => 0, count: 1 };
  const g = buildGrid(model, width, height);
  const mpp = metersPerPixel(model);
  const r = Math.max(1, Math.ceil(CLOSE_DOORS_M / mpp / g.cell));
  // Thicken walls by r cells in every direction (a square brush is enough here).
  const closed = new Uint8Array(g.blocked.length);
  for (let row = 0; row < g.rows; row++) {
    for (let col = 0; col < g.cols; col++) {
      if (!g.blocked[row * g.cols + col]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const y = row + dy;
        if (y < 0 || y >= g.rows) continue;
        for (let dx = -r; dx <= r; dx++) {
          const x = col + dx;
          if (x >= 0 && x < g.cols) closed[y * g.cols + x] = 1;
        }
      }
    }
  }
  // Flood-fill the open floor into numbered areas.
  const room = new Int32Array(g.blocked.length).fill(-1);
  let count = 0;
  const stack: number[] = [];
  for (let start = 0; start < room.length; start++) {
    if (closed[start] || room[start] >= 0) continue;
    room[start] = count;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const c = i % g.cols;
      const rr = (i - c) / g.cols;
      for (const [nc, nr] of [[c + 1, rr], [c - 1, rr], [c, rr + 1], [c, rr - 1]]) {
        if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue;
        const n = nr * g.cols + nc;
        if (!closed[n] && room[n] < 0) {
          room[n] = count;
          stack.push(n);
        }
      }
    }
    count++;
  }
  const at = (x: number, y: number) => {
    const c0 = Math.min(g.cols - 1, Math.max(0, Math.floor(x / g.cell)));
    const r0 = Math.min(g.rows - 1, Math.max(0, Math.floor(y / g.cell)));
    // Points on a thickened wall (e.g. a block hugging a wall) belong to the nearest room.
    for (let ring = 0; ring <= r + 2; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const c = c0 + dx;
          const rr = r0 + dy;
          if (c < 0 || rr < 0 || c >= g.cols || rr >= g.rows) continue;
          const id = room[rr * g.cols + c];
          if (id >= 0) return id;
        }
      }
    }
    return -1;
  };
  return { at, count };
}
