import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePicture, PICTURE_STYLES, picturePrompt, pictureSize } from '../src/ai/picture';
import type { Dot } from '../src/replay/replay';
import bar from '../src/templates/bar.json';
import { valid } from './helpers';

const model = valid(bar);
const meta = { provider: 'meta' as const, apiKey: 'k', model: 'muse-spark-1.3', baseUrl: 'https://api.meta.ai/v1' };

describe('AI picture prompt', () => {
  it('describes every area, skips the split point, and asks to keep the layout', () => {
    const p = picturePrompt(model, 'interior', [], 'a cocktail bar');
    expect(p).toMatch(/floor plan of a cocktail bar/);
    expect(p).toMatch(/"Bartender": a service point .* with 2 staffed positions/);
    expect(p).toMatch(/"Bar line": a waiting line/);
    expect(p).not.toMatch(/Order or sit/);
    expect(p).toMatch(/Keep the room shape, walls, doorways and the position and size of every area exactly/);
    expect(p).toMatch(/photorealistic interior/);
  });

  it('places people where the replay has them', () => {
    const dots: Dot[] = [
      { id: 1, x: 0, y: 0, state: 'wait' }, { id: 2, x: 0, y: 0, state: 'wait' }, { id: 3, x: 0, y: 0, state: 'service' },
    ];
    expect(picturePrompt(model, 'topdown', dots, '')).toMatch(/orange dots wait in line \(2\), green dots are being served \(1\)/);
  });

  it('sends every rule of the chosen style guide, so pictures in one style stay consistent', () => {
    for (const style of Object.keys(PICTURE_STYLES) as (keyof typeof PICTURE_STYLES)[]) {
      const p = picturePrompt(model, style, [], '');
      for (const rule of PICTURE_STYLES[style].guide) expect(p).toContain(`- ${rule}`);
    }
    const plan = picturePrompt(model, 'sketch', [], '');
    expect(plan).toMatch(/2D architectural floor plan/);
    expect(plan).toMatch(/exactly top-down and flat .* no isometric angle/);
  });

  it('writes area names from the model on the 2D plan only, never numbers', () => {
    const plan = picturePrompt(model, 'sketch', [], '');
    expect(plan).toMatch(/"Bartender"/);
    expect(plan).toMatch(/Write each area's name, exactly as quoted/);
    expect(plan).toMatch(/no other text, numbers or measurements|any other text, numbers or measurements/);
    expect(picturePrompt(model, 'interior', [], '')).toMatch(/Do not include the colored shapes, dots, labels, text/);
  });

  it('matches the plan shape', () => {
    expect(pictureSize(1500, 1000)).toBe('1536x1024');
    expect(pictureSize(800, 1200)).toBe('1024x1536');
    expect(pictureSize(1000, 1000)).toBe('1024x1024');
  });
});

describe('Muse Image request', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the plan drawing to the edit endpoint and returns a PNG', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgo=' }], output_format: 'png' })));
    vi.stubGlobal('fetch', fetchMock);
    const url = await generatePicture(meta, 'draw it', 'data:image/png;base64,AAA', '1536x1024');
    expect(url).toBe('data:image/png;base64,iVBORw0KGgo=');
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe('https://api.meta.ai/v1/images/edits');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'muse-image-1.0', prompt: 'draw it', images: [{ image_url: 'data:image/png;base64,AAA' }], n: 1, size: '1536x1024', output_format: 'png',
    });
  });

  it('only works with Meta, and says so', async () => {
    await expect(generatePicture({ ...meta, provider: 'anthropic' }, 'x', 'y', '1024x1024')).rejects.toThrow(/Muse Image/);
  });
});
