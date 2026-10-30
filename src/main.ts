import './style.css';
import { BLOCK_ORDER, BLOCK_STYLES, planExtent } from './editor/blocks';
import { PlanCanvas, type Tool } from './editor/canvas';
import { Inspector } from './editor/inspector';
import { Store } from './editor/store';
import { loadPlan } from './editor/upload';
import type { WorkerRequest, WorkerResponse } from './engine/worker';
// Vite builds this as a classic worker (see vite.config.ts), so older browsers can run it too.
import SimulationWorker from './engine/worker?worker';
import { DEFAULT_METERS_PER_PIXEL, type BlockType, type ModelSpec } from './model/types';
import { validateModel, type Issue } from './model/validate';
import { setupPicture } from './ai/picture-ui';
import { setupReview, type LastRun } from './ai/review-ui';
import { setupAi } from './ai/ui';
import { linkFlows } from './layout/optimize';
import { Player } from './replay/player';
import { computeRoutes, routeDistances, type Route } from './routing/pathfinder';
import bank from './templates/bank.json';
import bar from './templates/bar.json';
import { resultsHtml } from './ui/results';

const blank: ModelSpec = {
  version: '0.1',
  entityLabel: 'customer',
  blocks: [],
  links: [],
  run: { hours: 8, warmupMin: 60, replications: 30, seed: 42 },
};
const templates: Record<string, unknown> = { blank, bank, bar };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const messageEl = $('message');
function message(text: string, kind: 'info' | 'error' = 'info') {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`;
}

const store = new Store(validateModel(bank).model!);

// Live checks (FR-15): run before the canvas draws so flagged blocks are current.
const flagged = new Set<string>();
const issuesEl = $('issues');
const checkCount = $('check-count');
let lastErrors: Issue[] = [];
let lastWarnings: Issue[] = [];
/** Links with no way around the walls; filled in when routes are computed. */
let routeWarnings: Issue[] = [];

function renderChecks() {
  checkCount.textContent = lastErrors.length ? `${lastErrors.length} to fix` : 'Ready to run';
  checkCount.className = `badge ${lastErrors.length ? 'bad' : 'ok'}`;
  issuesEl.innerHTML = [
    ...lastErrors.map((e) => `<div class="issue error" ${e.blockId ? `data-block="${esc(e.blockId)}"` : ''}>${esc(e.message)}</div>`),
    ...[...lastWarnings, ...routeWarnings].map((w) => `<div class="issue warning" ${w.blockId ? `data-block="${esc(w.blockId)}"` : ''}>${esc(w.message)}</div>`),
  ].join('') || '<p class="note">No problems found.</p>';
}

store.subscribe(() => {
  const v = validateModel(store.model);
  lastErrors = v.errors;
  lastWarnings = v.warnings;
  flagged.clear();
  for (const e of v.errors) if (e.blockId) flagged.add(e.blockId);
  renderChecks();
  // People per hour on each path (drives line thickness); depends on rates and splits, not only positions.
  // Set here, before the canvas redraws (it subscribed later). The store only emits after setup.
  canvas.routeFlows = v.model ? linkFlows(store.model) : new Map();
});

const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-tool]')];
const canvas = new PlanCanvas($('canvas'), store, {
  message,
  calibrationPoints: (a, b) => inspector.showCalibration(a, b),
  toolChanged: (tool: Tool) => toolButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool))),
});
canvas.flagged = flagged;
canvas.routeFlows = linkFlows(store.model);
canvas.render();
const inspector = new Inspector($('inspector'), store, () => {
  canvas.clearCalibration();
  canvas.setTool('select');
});

// ---- walking paths (FR-16, FR-17) ----
let routes = new Map<string, Route>();
let routesFor = '';
let routeTimer = 0;

/** Everything a path depends on; paths are recomputed only when this changes. */
function geometryKey(): string {
  const m = store.model;
  return JSON.stringify([
    m.walls ?? [],
    m.background?.metersPerPixel,
    planExtent(m),
    m.links.map((l) => [l.from, l.to]),
    m.blocks.map((b) => [b.id, b.type, b.x, b.y]),
  ]);
}

function updateRoutes(): Map<string, Route> {
  const key = geometryKey();
  if (key === routesFor) return routes;
  routesFor = key;
  const { width, height } = planExtent(store.model);
  routes = computeRoutes(store.model, width, height);
  const label = (id: string) => store.model.blocks.find((b) => b.id === id)?.label ?? id;
  routeWarnings = [...routes].filter(([, r]) => r.noPath).map(([k]) => {
    const [from, to] = k.split('>');
    return { blockId: from, message: `Walls leave no way to walk from "${label(from)}" to "${label(to)}"; the straight line is used. Leave a door gap.` };
  });
  canvas.routes = routes;
  canvas.render();
  renderChecks();
  return routes;
}

store.subscribe(() => {
  clearTimeout(routeTimer);
  routeTimer = window.setTimeout(updateRoutes, 120);
});

// ---- replay (FR-20, FR-21) ----
const player = new Player($('canvas'), canvas);
let playerVersion = -1;
store.subscribe(() => {
  if (store.version !== playerVersion) player.markStale();
});

// Clicking a check selects the block it is about.
issuesEl.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-block]')?.dataset.block;
  if (id) store.select({ kind: 'block', id });
});

// ---- palette (FR-04) ----
$('palette').innerHTML = BLOCK_ORDER.map((t) => {
  const s = BLOCK_STYLES[t];
  return `<button type="button" class="palette-item" draggable="true" data-type="${t}" style="--c:${s.color}">
    <span class="swatch shape-${s.shape}"></span><span><strong>${s.name}</strong><small>${s.hint}</small></span>
  </button>`;
}).join('');
$('palette').addEventListener('dragstart', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-type]')?.dataset.type;
  if (t && e.dataTransfer) {
    e.dataTransfer.setData('application/x-block-type', t);
    e.dataTransfer.effectAllowed = 'copy';
  }
});
// Touch screens: HTML drag and drop does not work with fingers, so drag a ghost by pointer instead.
let touchDrag: { type: BlockType; ghost: HTMLElement; x0: number; y0: number; moved: boolean } | null = null;
let suppressClick = false;
$('palette').addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  const item = (e.target as HTMLElement).closest<HTMLElement>('[data-type]');
  if (!item) return;
  const ghost = item.cloneNode(true) as HTMLElement;
  ghost.classList.add('drag-ghost');
  ghost.hidden = true;
  document.body.appendChild(ghost);
  touchDrag = { type: item.dataset.type as BlockType, ghost, x0: e.clientX, y0: e.clientY, moved: false };
  item.setPointerCapture(e.pointerId);
});
$('palette').addEventListener('pointermove', (e) => {
  if (!touchDrag) return;
  if (!touchDrag.moved && Math.hypot(e.clientX - touchDrag.x0, e.clientY - touchDrag.y0) < 8) return;
  touchDrag.moved = true;
  touchDrag.ghost.hidden = false;
  touchDrag.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
});
const endTouchDrag = (e: PointerEvent, drop: boolean) => {
  if (!touchDrag) return;
  const { type, ghost, moved } = touchDrag;
  ghost.remove();
  touchDrag = null;
  if (!moved) return; // a tap: the click handler below adds the block
  suppressClick = true;
  if (drop && canvas.containsPoint(e.clientX, e.clientY)) canvas.dropAt(type, e.clientX, e.clientY);
};
$('palette').addEventListener('pointerup', (e) => endTouchDrag(e, true));
$('palette').addEventListener('pointercancel', (e) => endTouchDrag(e, false));

$('palette').addEventListener('click', (e) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-type]')?.dataset.type as BlockType | undefined;
  if (t) canvas.addAtCenter(t);
});

// ---- toolbar ----
toolButtons.forEach((b) => b.addEventListener('click', () => canvas.setTool(b.dataset.tool as Tool)));
$('undo').addEventListener('click', () => store.undo());
$('redo').addEventListener('click', () => store.redo());
$('fit').addEventListener('click', () => canvas.fit());
store.subscribe(() => {
  $<HTMLButtonElement>('undo').disabled = !store.canUndo;
  $<HTMLButtonElement>('redo').disabled = !store.canRedo;
});

const templateSelect = $<HTMLSelectElement>('template');
templateSelect.value = 'bank';
templateSelect.addEventListener('change', () => {
  const t = templates[templateSelect.value];
  if (!t) return;
  store.replace(validateModel(t).model!);
  canvas.fit();
  message('Template loaded. Undo brings back what you had.');
});

// FR-01, FR-02: upload a plan, then calibrate its scale.
const planFile = $<HTMLInputElement>('plan-file');
$('upload').addEventListener('click', () => planFile.click());
planFile.addEventListener('change', async () => {
  const file = planFile.files?.[0];
  planFile.value = '';
  if (!file) return;
  message(`Reading ${file.name}…`);
  try {
    const plan = await loadPlan(file);
    store.commit((m) => {
      m.background = {
        file: plan.dataUrl,
        width: plan.width,
        height: plan.height,
        metersPerPixel: m.background?.metersPerPixel ?? DEFAULT_METERS_PER_PIXEL,
        calibrated: false,
      };
    });
    canvas.fit();
    canvas.setTool('calibrate');
    message('Plan loaded. Now set its scale: click two points whose real distance you know.');
    // Offer to let the AI place the blocks; nothing is sent unless the user says yes.
    ai.offerAfterUpload();
  } catch (e) {
    message((e as Error).message || 'The plan could not be read.', 'error');
  }
});

// FR-30: save and open the model as a JSON file, no account needed.
$('save').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(store.model, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'model.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
const modelFile = $<HTMLInputElement>('model-file');
$('load').addEventListener('click', () => modelFile.click());
modelFile.addEventListener('change', async () => {
  const file = modelFile.files?.[0];
  modelFile.value = '';
  if (!file) return;
  loadModelText(await file.text(), file.name);
});

function loadModelText(text: string, source: string, keepImage?: string) {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    message(`${source} is not valid JSON: ${(e as Error).message}`, 'error');
    return false;
  }
  const v = validateModel(data);
  if (!v.model) {
    message(`${source} is not a model file: ${v.errors[0]?.message ?? 'unknown problem'}`, 'error');
    return false;
  }
  if (keepImage && v.model.background?.file === IMAGE_PLACEHOLDER) v.model.background.file = keepImage;
  store.replace(v.model);
  canvas.fit();
  templateSelect.value = '';
  message(`Loaded ${source}.`);
  return true;
}

// ---- AI (bring your own key) ----
const ai = setupAi({ store, message, afterChange: () => requestAnimationFrame(() => canvas.fit()) });
$('ai-layout').addEventListener('click', () => ai.suggestLayout());
$('ai-fill').addEventListener('click', () => ai.fillFromText());
$('ai-settings').addEventListener('click', () => ai.openSettings());
const picture = setupPicture({
  store,
  getFrame: () => player.currentFrame(),
  clock: Player.clock,
  openSettings: ai.openSettings,
  message,
});
$('ai-picture').addEventListener('click', () => picture.open());

// ---- JSON view ----
const IMAGE_PLACEHOLDER = '(embedded plan image)';
const editor = $<HTMLTextAreaElement>('editor');
function showJson() {
  if (document.activeElement === editor) return;
  const m = store.model;
  // Keep a multi-megabyte image out of the text box.
  const shown = m.background?.file.startsWith('data:') ? { ...m, background: { ...m.background, file: IMAGE_PLACEHOLDER } } : m;
  editor.value = JSON.stringify(shown, null, 2);
}
store.subscribe(showJson);
$('apply-json').addEventListener('click', () => {
  loadModelText(editor.value, 'the JSON', store.model.background?.file);
  editor.blur();
  showJson();
});

// ---- keyboard ----
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('input, textarea, select')) return;
  if (canvas.handleKey(e)) e.preventDefault();
});
$('inspector').addEventListener('delete-selection', () => canvas.deleteSelection());
$('inspector').addEventListener('duplicate-selection', () => canvas.duplicateSelection());

// ---- run ----
const runButton = $<HTMLButtonElement>('run');
const resultsEl = $('results');
let worker: Worker | undefined;
let resultsVersion = -1;
store.subscribe(() => {
  resultsEl.classList.toggle('stale', resultsEl.dataset.ran === 'true' && store.version !== resultsVersion);
});

// AI review of the latest run (explain, suggest, and test each suggestion in the simulator).
let lastRun: LastRun | null = null;
const review = setupReview({
  host: resultsEl,
  store,
  getLastRun: () => lastRun,
  ensureKey: ai.ensureKey,
  message,
  rerun: () => runButton.click(),
  preview: (moves, routes) => {
    previewVersion = store.version;
    canvas.setPreview(moves, routes);
  },
});
// The replay dots belong to the current layout, so hide them while the proposal is shown.
canvas.onModeChange((mode) => $('canvas').classList.toggle('viewing-proposal', mode === 'proposal'));
// A proposed layout is only valid for the model it was made from: drop it on any real edit (not on selection).
let previewVersion = -1;
store.subscribe(() => {
  if (store.version !== previewVersion) canvas.setPreview(null);
});

runButton.addEventListener('click', () => {
  // The run is blocked until the model is valid.
  if (lastErrors.length) {
    message(`Fix ${lastErrors.length} problem${lastErrors.length > 1 ? 's' : ''} in Checks before running.`, 'error');
    if (lastErrors[0].blockId) store.select({ kind: 'block', id: lastErrors[0].blockId });
    $('issues').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  worker?.terminate();
  worker = new SimulationWorker();
  runButton.disabled = true;
  message('Running…');
  const started = performance.now();
  // A JSON round trip rather than structuredClone, which older Safari lacks; the model is plain JSON.
  const model = JSON.parse(JSON.stringify(store.model)) as ModelSpec;
  const runRoutes = updateRoutes();
  const version = store.version;
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      message(`Running replication ${msg.done} of ${msg.total}…`);
      return;
    }
    runButton.disabled = false;
    worker?.terminate();
    worker = undefined;
    if (msg.type === 'error') {
      message(`The run failed: ${msg.message}`, 'error');
      return;
    }
    message(`Done: ${msg.result.replications} replications in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
    resultsEl.innerHTML = `<p class="stale-note">The model changed after this run. Run again to update.</p>`
      + resultsHtml(msg.result, model.entityLabel);
    lastRun = { model, result: msg.result, distances: routeDistances(runRoutes) };
    review.attach(resultsEl);
    resultsEl.dataset.ran = 'true';
    resultsVersion = version;
    resultsEl.classList.toggle('stale', version !== store.version);
    if (msg.result.log) {
      player.load(msg.result.log, model, runRoutes, msg.result.logEnd ?? model.run.hours * 60);
      playerVersion = version;
      if (version !== store.version) player.markStale();
      if ((msg.result.logEnd ?? Infinity) < model.run.hours * 60) {
        message(`Done. The replay covers the first ${(msg.result.logEnd! / 60).toFixed(1)} hours; KPIs cover the whole run.`);
      }
    }
  };
  worker.postMessage({ model, recordLog: true, distances: routeDistances(runRoutes) } satisfies WorkerRequest);
});

// Offline support for the built site; skipped in `npm run dev` so edits always show.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // No offline mode (e.g. a private window); the app works the same online.
    });
  });
}

// First paint.
store.select(null);
requestAnimationFrame(() => canvas.fit());
canvas.setTool('select');
