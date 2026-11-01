// The "AI picture" dialog: pick a style, optionally include the people at the replay moment,
// and get a Muse Image illustration of the layout to view and download.
import type { ModelSpec } from '../model/types';
import type { Dot } from '../replay/replay';
import { generatePicture, PICTURE_STYLES, picturePrompt, pictureSize, renderPlanPicture, type PictureStyle } from './picture';
import { technicalDrawingSvg } from '../export/drawing';
import { loadSettings } from './settings';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function setupPicture(opts: {
  /** The layout the plan shows: the optimized one while that view has its own replay. */
  layout: () => { model: ModelSpec; optimized: boolean };
  getFrame: () => { t: number; dots: Dot[]; stale: boolean } | null;
  clock: (min: number) => string;
  openSettings: () => void;
  message: (t: string, kind?: 'info' | 'error') => void;
}) {
  const dlg = document.createElement('dialog');
  dlg.id = 'ai-picture-dialog';
  dlg.className = 'ai-dialog wide';
  dlg.setAttribute('aria-labelledby', 'ai-picture-title');
  dlg.innerHTML = `<form method="dialog" class="ai-form"><h2 id="ai-picture-title">AI picture of this layout</h2><div class="ai-body"></div></form>`;
  document.body.appendChild(dlg);
  let controller: AbortController | null = null;
  /** Newest first. An exact drawing also keeps its SVG for sharp printing. */
  let gallery: { url: string; caption: string; svg?: string }[] = [];

  function open() {
    const { model, optimized } = opts.layout();
    if (!model.blocks.length) {
      opts.message('Add or suggest blocks first; the picture shows your layout.', 'error');
      return;
    }
    dlg.querySelector('#ai-picture-title')!.textContent = optimized ? 'AI picture of the optimized layout' : 'AI picture of this layout';
    const frame = opts.getFrame();
    const meta = loadSettings('meta');
    dlg.querySelector('.ai-body')!.innerHTML = `
      <p class="note">Muse Image turns a clean drawing of your plan into an illustration, for slides and reports.
        It is an <strong>AI illustration</strong>: it may change details. The numbers always come from the simulator.</p>
      <label class="field"><span>Style</span>
        <select name="style">${(Object.keys(PICTURE_STYLES) as PictureStyle[]).map((k) => `<option value="${k}">${PICTURE_STYLES[k].name}</option>`).join('')}</select>
      </label>
      <label class="field"><span>What is this space? (optional)</span>
        <input name="context" type="text" placeholder="e.g. a small bank branch in Jakarta, modern interior">
      </label>
      <label class="check"><input type="checkbox" name="people" ${frame ? 'checked' : 'disabled'}>
        <span>Show the people at the replay moment
          <small>${frame
            ? `${opts.clock(frame.t)}: ${frame.dots.length} people${frame.stale ? ' (from the last run; the model changed since)' : ''}. Pause the replay where you want it.`
            : 'Run the simulation first to include people.'}</small></span></label>
      <p class="note">Costs $0.01 per picture on your Meta key${meta.apiKey ? '' : ' — <strong>add a Meta key in AI settings first</strong>'}.
        Sends the plan drawing and block names, not your numbers.</p>
      <p class="ai-status" role="status"></p>
      <div class="picture-out">${galleryHtml()}</div>
      <div class="actions">
        <button type="button" data-act="settings">AI settings</button>
        <span class="grow"></span>
        <button value="close" formnovalidate>Close</button>
        <button type="button" data-act="drawing" title="Exact plan with labels, sizes and dimensions, drawn by the app. Free, no key needed.">Technical drawing</button>
        <button type="button" class="primary" data-act="make">Make picture</button>
      </div>`;
    dlg.showModal();
  }

  function galleryHtml(): string {
    return gallery.map((g, i) => g.svg
      ? `
      <figure class="picture">
        <img src="${g.url}" alt="Technical drawing of the layout">
        <figcaption><span class="badge ok">Exact drawing</span> ${esc(g.caption)}
          <a href="${g.url}" download="layout-drawing-${i + 1}.png">PNG</a>
          <a href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(g.svg)}" download="layout-drawing-${i + 1}.svg">SVG</a></figcaption>
      </figure>`
      : `
      <figure class="picture">
        <img src="${g.url}" alt="AI illustration of the layout">
        <figcaption><span class="badge warn">AI illustration</span> ${esc(g.caption)}
          <a href="${g.url}" download="layout-illustration-${i + 1}.png">Download</a></figcaption>
      </figure>`).join('');
  }

  /** Draws the exact technical drawing, rasterized to PNG for slides; the SVG stays for printing. */
  async function addDrawing() {
    const { model, optimized } = opts.layout();
    const context = dlg.querySelector<HTMLInputElement>('[name="context"]')!.value.trim();
    const title = optimized ? 'Optimized layout' : 'Current layout';
    const svg = technicalDrawingSvg(model, {
      title,
      subtitle: context || `Floor plan for ${model.entityLabel}s`,
      date: new Date().toLocaleDateString('en-CA'), // YYYY-MM-DD in the viewer's own time zone
    });
    // The load event, not img.decode(), which stalls while the tab is in the background.
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('the drawing could not be rendered'));
      el.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    gallery = [{ url: canvas.toDataURL('image/png'), caption: `${title}, exact technical drawing`, svg }, ...gallery].slice(0, 6);
    dlg.querySelector('.picture-out')!.innerHTML = galleryHtml();
  }

  dlg.addEventListener('close', () => controller?.abort());
  dlg.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'settings') {
      dlg.close();
      opts.openSettings();
      return;
    }
    if (act === 'drawing') {
      const status = dlg.querySelector<HTMLElement>('.ai-status')!;
      try {
        await addDrawing();
        status.className = 'ai-status';
        status.textContent = 'Technical drawing added. Every label and size comes from the model.';
      } catch (err) {
        status.className = 'ai-status bad';
        status.textContent = `The drawing could not be made: ${(err as Error).message}`;
      }
      return;
    }
    if (act !== 'make') return;
    const status = dlg.querySelector<HTMLElement>('.ai-status')!;
    const btn = dlg.querySelector<HTMLButtonElement>('[data-act="make"]')!;
    const style = dlg.querySelector<HTMLSelectElement>('[name="style"]')!.value as PictureStyle;
    const context = dlg.querySelector<HTMLInputElement>('[name="context"]')!.value;
    const withPeople = dlg.querySelector<HTMLInputElement>('[name="people"]')!.checked;
    const frame = withPeople ? opts.getFrame() : null;
    const people = frame?.dots ?? [];
    btn.disabled = true;
    status.className = 'ai-status';
    status.textContent = 'Drawing the plan and asking Muse Image… this can take up to a minute.';
    controller = new AbortController();
    try {
      const { model, optimized } = opts.layout();
      const ref = await renderPlanPicture(model, people, !optimized);
      const url = await generatePicture(loadSettings('meta'), picturePrompt(model, style, people, context), ref.dataUrl,
        pictureSize(ref.width, ref.height), controller.signal);
      gallery = [{ url, caption: `${optimized ? 'Optimized layout, ' : ''}${PICTURE_STYLES[style].name}${frame ? `, people at ${opts.clock(frame.t)}` : ''}` }, ...gallery].slice(0, 6);
      dlg.querySelector('.picture-out')!.innerHTML = galleryHtml();
      status.textContent = 'Done. Make another, or download it.';
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      status.className = 'ai-status bad';
      status.textContent = (err as Error).message;
    } finally {
      btn.disabled = false;
      controller = null;
    }
  });

  return { open };
}
