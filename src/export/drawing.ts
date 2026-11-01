// An exact technical drawing of a layout: walls, labeled blocks with their sizes, overall
// dimensions, a scale bar and a title block. Drawn from the model, so every number is real.
import { BLOCK_STYLES, metersPerPixel, planExtent } from '../editor/blocks';
import type { Block, ModelSpec } from '../model/types';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const m1 = (v: number) => `${v.toFixed(1)} m`;

/** Text and line sizes, in meters on the drawing. */
const LABEL_M = 0.32;
const NOTE_M = 0.24;
const WALL_M = 0.15;
const LINE_M = 0.03;

export interface DrawingInfo {
  title: string;
  subtitle: string;
  date: string;
}

/** The drawing as an SVG document, in meters. `widthPx` is its display width. */
export function technicalDrawingSvg(model: ModelSpec, info: DrawingInfo, widthPx = 1800): string {
  const mpp = metersPerPixel(model);
  const pts = (model.walls ?? []).flat().map(([x, y]) => [x * mpp, y * mpp] as const);
  const extent = planExtent(model);
  // The room is the walls' outline; without walls, the plan's own extent.
  const [x0, y0, x1, y1] = pts.length
    ? [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]
    : [0, 0, extent.width * mpp, extent.height * mpp];
  const w = x1 - x0;
  const h = y1 - y0;
  const pad = 1.6;
  const vx = x0 - pad - 0.6;
  const vy = y0 - pad - 0.4;
  const vw = w + 2 * pad + 0.6;
  const vh = h + 2 * pad + 2.4; // room under the plan for the scale bar and title block
  const parts: string[] = [];

  parts.push(`<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#ffffff"/>`);

  for (const line of model.walls ?? []) {
    const p = line.map(([x, y]) => `${x * mpp},${y * mpp}`).join(' ');
    parts.push(`<polyline points="${p}" fill="none" stroke="#111111" stroke-width="${WALL_M}" stroke-linecap="square" stroke-linejoin="miter"/>`);
  }

  for (const b of model.blocks) {
    if (b.type === 'decision') continue;
    parts.push(blockSvg(b, mpp));
  }

  // Overall dimensions: width along the top, depth along the left.
  parts.push(dimension(x0, y0 - 0.9, x1, y0 - 0.9, m1(w), 'h'));
  parts.push(dimension(x0 - 0.9, y0, x0 - 0.9, y1, m1(h), 'v'));

  // Scale bar under the plan, a round length about a quarter of the width.
  const bar = [1, 2, 5, 10, 20, 50].filter((n) => n <= Math.max(1, w / 4)).pop()!;
  const sy = y1 + 1.4;
  parts.push(`<g stroke="#111111" stroke-width="${LINE_M}">
    <rect x="${x0}" y="${sy}" width="${bar / 2}" height="0.18" fill="#111111"/>
    <rect x="${x0 + bar / 2}" y="${sy}" width="${bar / 2}" height="0.18" fill="#ffffff"/></g>
    ${text(x0, sy - 0.15, '0', NOTE_M, 'middle')}${text(x0 + bar, sy - 0.15, `${bar} m`, NOTE_M, 'middle')}`);

  // Title block, bottom right.
  const tw = Math.min(8, w * 0.55);
  const tx = x1 - tw;
  const ty = y1 + 0.9;
  parts.push(`<rect x="${tx}" y="${ty}" width="${tw}" height="1.7" fill="none" stroke="#111111" stroke-width="${LINE_M}"/>
    ${text(tx + 0.25, ty + 0.5, info.title, LABEL_M * 1.2, 'start', 700)}
    ${text(tx + 0.25, ty + 0.95, info.subtitle, NOTE_M, 'start')}
    ${text(tx + 0.25, ty + 1.4, `Dimensions in meters · ${info.date}`, NOTE_M, 'start')}`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${widthPx}" height="${Math.round((widthPx * vh) / vw)}" font-family="Arial, Helvetica, sans-serif">${parts.join('')}</svg>`;
}

/** One block: its outline, then its name and size under it. */
function blockSvg(b: Block, mpp: number): string {
  const s = BLOCK_STYLES[b.type];
  const bw = b.w ?? s.w;
  const bh = b.h ?? s.h;
  const cx = b.x * mpp;
  const cy = b.y * mpp;
  const rot = b.rotation ?? 0;
  const look = {
    server: 'fill="#e4e4e4" stroke="#111111"',
    delay: 'fill="#f3f3f3" stroke="#111111"',
    queue: `fill="none" stroke="#111111" stroke-dasharray="${LINE_M * 6} ${LINE_M * 4}"`,
    source: 'fill="none" stroke="#111111"',
    sink: 'fill="none" stroke="#111111"',
    resource: 'fill="none" stroke="#111111"',
    decision: '',
  }[b.type];
  const shape = b.type === 'resource'
    ? `<circle cx="${cx}" cy="${cy}" r="${bw / 2}" ${look} stroke-width="${LINE_M}"/>`
    : `<rect x="${cx - bw / 2}" y="${cy - bh / 2}" width="${bw}" height="${bh}" ${look} stroke-width="${LINE_M}" transform="rotate(${rot} ${cx} ${cy})"/>`;
  // Half the height the rotated block takes up, so the text sits just below it.
  const r = (rot * Math.PI) / 180;
  const below = cy + Math.abs(bw * Math.sin(r)) / 2 + Math.abs(bh * Math.cos(r)) / 2;
  const staff = b.type === 'server' ? ` · ${b.servers} staff` : b.type === 'resource' ? ` · ${b.count}` : '';
  return shape
    + text(cx, below + 0.4, (b.label || b.id).toUpperCase(), LABEL_M, 'middle', 700)
    // An entrance or exit is a door marker; its footprint is not a real size.
    + (b.type === 'source' || b.type === 'sink' ? '' : text(cx, below + 0.72, `${bw.toFixed(1)} × ${bh.toFixed(1)} m${staff}`, NOTE_M, 'middle'));
}

/** A dimension line with end ticks and its length written beside it. */
function dimension(xa: number, ya: number, xb: number, yb: number, label: string, dir: 'h' | 'v'): string {
  const t = 0.18;
  const ticks = dir === 'h'
    ? `<line x1="${xa}" y1="${ya - t}" x2="${xa}" y2="${ya + t}"/><line x1="${xb}" y1="${yb - t}" x2="${xb}" y2="${yb + t}"/>`
    : `<line x1="${xa - t}" y1="${ya}" x2="${xa + t}" y2="${ya}"/><line x1="${xb - t}" y1="${yb}" x2="${xb + t}" y2="${yb}"/>`;
  const mx = (xa + xb) / 2;
  const my = (ya + yb) / 2;
  const words = dir === 'h'
    ? text(mx, ya - 0.2, label, NOTE_M, 'middle')
    : `<text x="${mx - 0.2}" y="${my}" font-size="${NOTE_M}" text-anchor="middle" transform="rotate(-90 ${mx - 0.2} ${my})" fill="#111111">${esc(label)}</text>`;
  return `<g stroke="#111111" stroke-width="${LINE_M}"><line x1="${xa}" y1="${ya}" x2="${xb}" y2="${yb}"/>${ticks}</g>${words}`;
}

function text(x: number, y: number, s: string, size: number, anchor: 'start' | 'middle', weight = 400): string {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="#111111">${esc(s)}</text>`;
}
