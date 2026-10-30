import './style.css';
import { BLOCK_ORDER, BLOCK_STYLES } from './editor/blocks';
import { PlanCanvas, type Tool } from './editor/canvas';
import { Inspector } from './editor/inspector';
import { Store } from './editor/store';
import { loadPlan } from './editor/upload';
import type { WorkerRequest, WorkerResponse } from './engine/worker';
import { DEFAULT_METERS_PER_PIXEL, type BlockType, type ModelSpec } from './model/types';
import { validateModel, type Issue } from './model/validate';
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
store.subscribe(() => {
  const v = validateModel(store.model);
  lastErrors = v.errors;
  flagged.clear();
  for (const e of v.errors) if (e.blockId) flagged.add(e.blockId);
  checkCount.textContent = v.errors.length ? `${v.errors.length} to fix` : 'Ready to run';
  checkCount.className = `badge ${v.errors.length ? 'bad' : 'ok'}`;
  issuesEl.innerHTML = [
    ...v.errors.map((e) => `<div class="issue error" ${e.blockId ? `data-block="${esc(e.blockId)}"` : ''}>${esc(e.message)}</div>`),
    ...v.warnings.map((w) => `<div class="issue warning">${esc(w.message)}</div>`),
  ].join('') || '<p class="note">No problems found.</p>';
});

const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-tool]')];
const canvas = new PlanCanvas($('canvas'), store, {
  message,
  calibrationPoints: (a, b) => inspector.showCalibration(a, b),
  toolChanged: (tool: Tool) => toolButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool))),
});
canvas.flagged = flagged;
const inspector = new Inspector($('inspector'), store, () => {
  canvas.clearCalibration();
  canvas.setTool('select');
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
$('palette').addEventListener('click', (e) => {
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
let runVersion = 0;
store.subscribe(() => {
  runVersion++;
  resultsEl.classList.toggle('stale', resultsEl.dataset.ran === 'true');
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
  worker = new Worker(new URL('./engine/worker.ts', import.meta.url), { type: 'module' });
  runButton.disabled = true;
  message('Running…');
  const started = performance.now();
  const model = structuredClone(store.model);
  const version = runVersion;
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
    resultsEl.dataset.ran = 'true';
    resultsEl.classList.toggle('stale', version !== runVersion);
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  worker.postMessage({ model } satisfies WorkerRequest);
});

// First paint.
store.select(null);
requestAnimationFrame(() => canvas.fit());
canvas.setTool('select');
