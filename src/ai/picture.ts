// "AI picture": an illustration of the current layout (optionally with the people at a
// replay moment) drawn by Muse Image from a clean plan drawing we render ourselves.
// It is an illustration only: the numbers always come from the simulator.
import { BLOCK_STYLES, footprintPx, planExtent } from '../editor/blocks';
import type { BlockType, ModelSpec } from '../model/types';
import type { Dot } from '../replay/replay';
import { AiError, type AiSettings } from './providers';

export type PictureStyle = 'interior' | 'topdown' | 'sketch';

export const PICTURE_STYLES: Record<PictureStyle, { name: string; ask: string }> = {
  interior: {
    name: 'Realistic interior (3/4 view)',
    ask: 'a photorealistic interior photograph from a raised three-quarter angle, natural lighting, real furniture and materials',
  },
  topdown: {
    name: 'Realistic top-down',
    ask: 'a photorealistic top-down (bird’s-eye) view of the furnished space, as if the roof were removed',
  },
  sketch: {
    name: 'Architect sketch',
    ask: 'an architect’s isometric presentation sketch with soft watercolor shading',
  },
};

/** Longest side of the picture we send, in pixels. */
const PICTURE_PX = 1536;

const WHAT_EACH_TYPE_IS: Record<BlockType, string> = {
  source: 'an entrance door',
  queue: 'a waiting line (rope barriers or floor markings)',
  server: 'a service point (counter, desk, kiosk or machine), with one staff position per server',
  resource: 'staff or equipment that moves around',
  delay: 'an area where people spend time (seating, tables, forms)',
  decision: 'nothing (it is only where the flow splits; do not draw it)',
  sink: 'an exit door',
};

const DOT_COLORS: Record<Dot['state'], string> = {
  move: '#2357d9', wait: '#e08a00', service: '#1f9d4d', stay: '#13a3a3', balk: '#d92d20',
};

/**
 * Draws the plan as a clean reference picture: the uploaded plan faintly, walls in black,
 * each block as a colored, labeled footprint, and people as dots. Browser only.
 */
export async function renderPlanPicture(model: ModelSpec, people: Dot[] = []): Promise<{ dataUrl: string; width: number; height: number }> {
  const { width, height } = planExtent(model);
  const k = PICTURE_PX / Math.max(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * k);
  canvas.height = Math.round(height * k);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(k, k);

  const bg = model.background?.file;
  if (bg?.startsWith('data:')) {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new AiError('The plan image could not be read.'));
      el.src = bg;
    });
    ctx.globalAlpha = 0.35;
    ctx.drawImage(img, 0, 0, width, height);
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = '#111111';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 6 / k;
  for (const wall of model.walls ?? []) {
    ctx.beginPath();
    wall.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }

  for (const b of model.blocks) {
    if (b.type === 'decision') continue;
    const s = BLOCK_STYLES[b.type];
    const { w, h } = footprintPx(model, b);
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(((b.rotation ?? 0) * Math.PI) / 180);
    ctx.fillStyle = s.color + '55';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 3 / k;
    ctx.beginPath();
    if (s.shape === 'circle') ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    else ctx.rect(-w / 2, -h / 2, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Large, haloed labels right under each area, so the image model can read them.
    const r = ((b.rotation ?? 0) * Math.PI) / 180;
    const halfH = (Math.abs(w * Math.sin(r)) + Math.abs(h * Math.cos(r))) / 2;
    ctx.font = `bold ${Math.round(24 / k)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 6 / k;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(b.label || b.id, b.x, b.y + halfH + 6 / k);
    ctx.fillStyle = '#111111';
    ctx.fillText(b.label || b.id, b.x, b.y + halfH + 6 / k);
  }

  for (const d of people) {
    ctx.fillStyle = DOT_COLORS[d.state];
    ctx.beginPath();
    ctx.arc(d.x, d.y, 6 / k, 0, Math.PI * 2);
    ctx.fill();
  }
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

/** The instruction for Muse Image: what the drawing shows and what to keep exactly. */
export function picturePrompt(model: ModelSpec, style: PictureStyle, people: Dot[], context: string): string {
  const blocks = model.blocks
    .filter((b) => b.type !== 'decision')
    .map((b) => {
      const extra = b.type === 'server' ? ` with ${b.servers} staffed position${b.servers > 1 ? 's' : ''}` : '';
      return `- "${b.label || b.id}": ${WHAT_EACH_TYPE_IS[b.type]}${extra}`;
    });
  const counts = people.reduce<Record<string, number>>((c, d) => ({ ...c, [d.state]: (c[d.state] ?? 0) + 1 }), {});
  const crowd = people.length
    ? `Draw one ${model.entityLabel} at each colored dot: orange dots wait in line (${counts.wait ?? 0}), green dots are being served (${counts.service ?? 0}), ` +
      `teal dots are seated or busy in an area (${counts.stay ?? 0}), blue dots are walking (${counts.move ?? 0}). Keep the crowd where the dots are.`
    : `Show the space with only a few ${model.entityLabel}s and staff.`;
  return `This is a floor plan of ${context.trim() || `a space where ${model.entityLabel}s are served`}, drawn from above.
Black lines are walls; gaps in them are doorways. Each colored, labeled shape is an area:
${blocks.join('\n')}
Render it as ${PICTURE_STYLES[style].ask}.
Keep the room shape, walls, doorways and the position and size of every area exactly as in the plan. Do not add or remove areas.
${crowd}
Do not include the colored shapes, dots, labels or any text in the result.`;
}

/** Picture aspect for the request, as Meta's "WxH" (it sets the ratio, not exact pixels). */
export function pictureSize(width: number, height: number): string {
  const r = width / height;
  if (r > 1.3) return '1536x1024';
  if (r < 0.77) return '1024x1536';
  return '1024x1024';
}

/** Calls Muse Image's edit endpoint with our plan drawing as the reference. Returns a PNG data URL. */
export async function generatePicture(s: AiSettings, prompt: string, reference: string, size: string, signal?: AbortSignal): Promise<string> {
  if (s.provider !== 'meta') throw new AiError('AI pictures use Meta’s Muse Image. Choose Meta in AI settings and add your Meta key.');
  if (!s.apiKey.trim()) throw new AiError('Add your Meta API key in AI settings first.');
  let res: Response;
  try {
    res = await fetch(`${s.baseUrl.replace(/\/+$/, '')}/images/edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify({ model: 'muse-image-1.0', prompt, images: [{ image_url: reference }], n: 1, size, output_format: 'png' }),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new AiError('Could not reach Meta. Check your internet connection.');
  }
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 300);
    try {
      detail = JSON.parse(body).error?.message ?? detail;
    } catch {
      // keep raw text
    }
    if (res.status === 401 || res.status === 403) throw new AiError('Meta rejected the API key. Check it in AI settings.');
    if (res.status === 429) throw new AiError('Meta is rate-limiting this key or it is out of credit. Try again shortly.');
    throw new AiError(`Meta could not make the picture (${res.status}): ${detail}`);
  }
  const b64 = JSON.parse(body).data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !b64) throw new AiError('Meta sent back no picture.');
  return `data:image/png;base64,${b64}`;
}
