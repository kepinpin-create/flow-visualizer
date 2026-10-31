// The "AI review" panel at the top of the results: explain, suggest, and test each suggestion.
import type { Store } from '../editor/store';
import type { ExperimentResult } from '../engine/experiment';
import { runInWorker } from '../engine/runner';
import type { ModelSpec } from '../model/types';
import { validateModel } from '../model/validate';
import { applyChanges, type Change } from './describe';
import { callAi, PROVIDERS } from './providers';
import { planExtent } from '../editor/blocks';
import { computeRoutes, routeDistances, type Route } from '../routing/pathfinder';
import { linkFlows, optimizeLayout, type LayoutResult } from '../layout/optimize';
import {
  applyMoves, compareRuns, layoutExplainPrompt, layoutExplainSchema, layoutExplainSystem, parseReviewReply, reviewPrompt,
  reviewSchema, reviewSystem, suggestionChanges, suggestionMoves,
  type Comparison, type Move, type ReviewLanguage, type ReviewReply,
} from './review';
import { loadSettings } from './settings';

export interface LastRun {
  model: ModelSpec;
  result: ExperimentResult;
  distances: Record<string, number>;
}

const LANG_KEY = 'flow-visualizer.reviewLanguage';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmt = (n: number, unit: string) => (Number.isFinite(n) ? `${n.toFixed(unit === '%' || unit === '/h' ? 1 : 2)}${unit === '%' ? '%' : ` ${unit}`}` : '∞');

function readLanguage(): ReviewLanguage {
  try {
    return localStorage.getItem(LANG_KEY) === 'id' ? 'id' : 'en';
  } catch {
    return 'en';
  }
}

const VERDICT = {
  better: '<span class="badge ok">Tested: clearly better</span>',
  worse: '<span class="badge bad">Tested: worse</span>',
  unclear: '<span class="badge">Tested: no clear difference</span>',
};

/**
 * The headline badge. Time in system decides it; when that does not clearly move,
 * say which other measure did (e.g. a move that shortens walks but not total time).
 */
function verdictHtml(c: Comparison): string {
  if (c.overall !== 'unclear') return VERDICT[c.overall];
  const moved = c.metrics.slice(1).filter((m) => !m.neutral && m.verdict !== 'unclear');
  if (!moved.length) return VERDICT.unclear;
  const parts = moved.map((m) => `${m.verdict === 'better' ? 'better' : 'worse'} ${m.label.toLowerCase()}`);
  const cls = moved.every((m) => m.verdict === 'better') ? 'ok' : moved.every((m) => m.verdict === 'worse') ? 'bad' : '';
  return `<span class="badge ${cls}">Tested: ${esc(parts.join(', '))}; time in system about the same</span>`;
}

function comparisonHtml(c: Comparison): string {
  return `<div class="table-wrap"><table class="compare">
    <thead><tr><th>Measure</th><th>Now</th><th>With this change</th><th></th></tr></thead>
    <tbody>${c.metrics.map((m) => {
      const arrow = m.neutral ? '' : m.verdict === 'better' ? '<span class="good">▲ better</span>' : m.verdict === 'worse' ? '<span class="bad">▼ worse</span>' : '<span class="ci">≈ same</span>';
      return `<tr><td>${esc(m.label)}</td>
        <td>${fmt(m.before.mean, m.unit)} <span class="ci">±${fmt(m.before.half, m.unit).replace(/ .*$/, '')}</span></td>
        <td><strong>${fmt(m.after.mean, m.unit)}</strong> <span class="ci">±${fmt(m.after.half, m.unit).replace(/ .*$/, '')}</span></td>
        <td>${arrow}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

export function setupReview(opts: {
  host: HTMLElement;
  store: Store;
  getLastRun: () => LastRun | null;
  ensureKey: (then: () => void) => void;
  message: (t: string, kind?: 'info' | 'error') => void;
  rerun: () => void;
  /** Shows proposed block positions (and their walking paths) on the plan; null clears them. */
  preview: (moves: { id: string; to: [number, number] }[] | null, routes?: Map<string, Route>) => void;
  /** The optimized layout's test run, so its replay can play in the Optimized view. */
  onLayoutTested: (model: ModelSpec, result: ExperimentResult, routes: Map<string, Route>) => void;
}) {
  const { host, store } = opts;
  let controller: AbortController | null = null;
  /** Changes and moves per suggestion of the review on screen, kept for Apply. */
  let current: { changes: Change[]; moves: Move[]; tested: boolean }[] = [];

  host.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-review]');
    if (!btn) return;
    if (btn.dataset.review === 'start') opts.ensureKey(() => void start());
    if (btn.dataset.review === 'cancel') controller?.abort();
    if (btn.dataset.review === 'apply') apply(Number(btn.dataset.i));
    if (btn.dataset.review === 'layout') void optimize();
    if (btn.dataset.review === 'layout-apply') applyLayout();
    if (btn.dataset.review === 'layout-explain') opts.ensureKey(() => void explainLayout());
  });
  host.addEventListener('change', (e) => {
    const sel = e.target as HTMLSelectElement;
    if (sel.name !== 'review-lang') return;
    try {
      localStorage.setItem(LANG_KEY, sel.value);
    } catch {
      // per-viewer convenience only
    }
  });

  /** The button row shown above fresh results. */
  function barHtml(): string {
    const lang = readLanguage();
    return `<div class="review-bar">
      <button type="button" class="ai strong" data-review="start"><svg class="i" aria-hidden="true"><use href="#i-sparkles"/></svg><span>AI review: explain and suggest fixes</span></button>
      <label class="inline">in <select name="review-lang">
        <option value="en" ${lang === 'en' ? 'selected' : ''}>English</option>
        <option value="id" ${lang === 'id' ? 'selected' : ''}>Bahasa Indonesia</option>
      </select></label>
      <button type="button" data-score="run" title="Grades flow order, crossing paths, queue space, doors and walking from this run. No AI needed."><svg class="i" aria-hidden="true"><use href="#i-check"/></svg><span>Layout scorecard</span></button>
      <button type="button" data-review="layout" title="Moves busy areas closer together and to the entrance. Runs here, no AI or key needed."><svg class="i" aria-hidden="true"><use href="#i-layout"/></svg><span>Optimize layout</span></button>
      <span class="note">AI review sends only these numbers and the block names, no plan image. Every suggestion is then tested in the simulator.</span>
    </div>
    <div class="score-out"></div>
    <div class="layout-out"></div>
    <div class="review-out"></div>`;
  }

  function out(): HTMLElement {
    return host.querySelector<HTMLElement>('.review-out')!;
  }

  async function start() {
    const run = opts.getLastRun();
    if (!run) return;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const settings = loadSettings();
    const language = (host.querySelector<HTMLSelectElement>('[name="review-lang"]')?.value ?? 'en') as ReviewLanguage;
    const startBtn = host.querySelector<HTMLButtonElement>('[data-review="start"]');
    if (startBtn) startBtn.disabled = true;
    out().innerHTML = `<p class="ai-status">Asking ${esc(PROVIDERS[settings.provider].name)} to review the results…
      <button type="button" class="link-btn" data-review="cancel">Cancel</button></p>`;
    let reply: ReviewReply;
    try {
      reply = parseReviewReply(await callAi(settings, {
        system: reviewSystem(language), text: reviewPrompt(run.model, run.result, run.distances),
        schemaName: 'simulation_review', schema: reviewSchema as unknown as Record<string, unknown>, signal,
      }));
    } catch (err) {
      if (startBtn) startBtn.disabled = false;
      if ((err as Error).name === 'AbortError') {
        out().innerHTML = '';
        return;
      }
      out().innerHTML = `<p class="issue error">${esc((err as Error).message)}</p>`;
      return;
    }

    current = reply.suggestions.map((s) => ({ changes: suggestionChanges(run.model, s), moves: suggestionMoves(run.model, s), tested: false }));
    out().innerHTML = `
      <div class="review">
        <p class="review-summary">${esc(reply.summary)}</p>
        <p><strong>Bottleneck:</strong> ${esc(reply.bottleneck)}</p>
        ${reply.suggestions.length ? '' : '<p class="note">No changes suggested.</p>'}
        ${reply.suggestions.map((s, i) => `
          <article class="suggestion" data-i="${i}">
            <h3>${i + 1}. ${esc(s.title)}</h3>
            <p>${esc(s.why)}</p>
            ${s.tradeoff ? `<p class="note"><strong>Tradeoff:</strong> ${esc(s.tradeoff)}</p>` : ''}
            <ul class="changes">${current[i].changes.map((c) => `<li>${esc(c.summary)}${c.problem ? ` <span class="bad">(${esc(c.problem)})</span>` : ''}</li>`).join('')}${
              current[i].moves.map((mv) => `<li class="${mv.placement.ok ? '' : 'bad'}">↔ ${esc(mv.summary)}</li>`).join('')}</ul>
            <div class="test-result"><p class="ai-status">Waiting to be tested…</p></div>
          </article>`).join('')}
        <p class="note">AI text by ${esc(PROVIDERS[settings.provider].name)}. The before/after numbers come from the simulator
          (same seed and settings as your run, ${run.model.run.replications} replications, ±95% confidence).</p>
      </div>`;
    if (startBtn) startBtn.disabled = false;

    // Test each suggestion in turn; this runs locally and costs no tokens.
    for (let i = 0; i < reply.suggestions.length; i++) {
      if (signal.aborted) return;
      const box = out().querySelector<HTMLElement>(`.suggestion[data-i="${i}"] .test-result`);
      if (!box) return;
      const { changes, moves } = current[i];
      const bad = changes.find((c) => c.problem)?.problem ?? moves.find((mv) => !mv.placement.ok)?.summary;
      if ((!changes.length && !moves.length) || bad) {
        box.innerHTML = `<p class="issue warning">Not tested: ${esc(bad ?? 'the AI gave no concrete change.')}</p>`;
        continue;
      }
      const trial: ModelSpec = JSON.parse(JSON.stringify(run.model));
      applyChanges(trial, changes);
      applyMoves(trial, moves);
      // Moved blocks walk new paths: recompute them around the walls for this trial.
      let distances = run.distances;
      if (moves.length) {
        const { width, height } = planExtent(trial);
        distances = routeDistances(computeRoutes(trial, width, height));
      }
      const v = validateModel(trial);
      if (!v.ok) {
        box.innerHTML = `<p class="issue warning">Not tested: ${esc(v.errors[0].message)}</p>`;
        continue;
      }
      box.innerHTML = '<p class="ai-status">Testing in the simulator…</p>';
      try {
        const after = await runInWorker(trial, {
          distances,
          signal,
          onProgress: (d, t) => {
            box.innerHTML = `<p class="ai-status">Testing in the simulator… replication ${d} of ${t}</p>`;
          },
        });
        const c = compareRuns(run.result, after, run.model.entityLabel);
        current[i].tested = true;
        host.dispatchEvent(new CustomEvent('flow:improved'));
        box.innerHTML = `<p>${verdictHtml(c)}</p>${comparisonHtml(c)}
          <div class="actions"><button type="button" data-review="apply" data-i="${i}">Apply this change and run again</button></div>`;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        box.innerHTML = `<p class="issue error">The test run failed: ${esc((err as Error).message)}</p>`;
      }
    }
  }

  // ---- optimize layout (flow × distance; deterministic) ----

  let layout: {
    result: LayoutResult;
    flows: Map<string, number>;
    before: Record<string, number>;
    after: Record<string, number>;
    comparison: Comparison | null;
  } | null = null;

  async function optimize() {
    const run = opts.getLastRun();
    if (!run) return;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const box = host.querySelector<HTMLElement>('.layout-out')!;
    box.innerHTML = '<p class="ai-status">Searching for a layout with less walking…</p>';
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    opts.preview(null);
    // Let the status paint before the (synchronous, few-second) search. A timer, not
    // requestAnimationFrame, which never fires in a background tab.
    await new Promise((r) => setTimeout(r, 50));
    const result = optimizeLayout(run.model);
    const flows = linkFlows(run.model);
    if (result.before <= 0) {
      layout = null;
      box.innerHTML = `<p class="issue warning">No walking to optimize: the model sends no one between blocks.
        Check that the entrance has an arrival rate and that its links lead somewhere.</p>`;
      return;
    }
    if (!result.moves.length) {
      layout = null;
      box.innerHTML = `<div class="review"><p><span class="badge ok">Layout already fits the flow</span>
        No move of a movable block lowers walking (now ${result.before.toFixed(0)} people·m per hour).
        Unlock blocks with “Fixed in place” to give the optimizer more freedom.</p></div>`;
      return;
    }
    const { width, height } = planExtent(result.model);
    const newRoutes = computeRoutes(result.model, width, height);
    const after = routeDistances(newRoutes);
    layout = { result, flows, before: run.distances, after, comparison: null };
    opts.preview(result.moves.map((m) => ({ id: m.id, to: m.to })), newRoutes);
    const cut = result.before > 0 ? (1 - result.after / result.before) * 100 : 0;
    box.innerHTML = `
      <div class="review">
        <h3>Optimized layout</h3>
        <p><strong>Walking load ${result.before.toFixed(0)} → ${result.after.toFixed(0)} people·m per hour</strong> (${cut.toFixed(0)}% less).
          Busy areas moved closer to the entrance and to each other; quiet ones moved further away.${result.timedOut ? ' (Search stopped at its time limit.)' : ''}</p>
        <ul class="changes">${result.moves.map((m) => `<li>↔ ${esc(m.label)}: moved ${m.movedM.toFixed(1)} m</li>`).join('')}</ul>
        <p class="note">The plan now shows the optimized layout. Use <strong>Current layout / Optimized layout</strong> at the top of the plan
          to compare. Nothing changes until you apply.</p>
        <div class="test-result"><p class="ai-status">Testing in the simulator…</p></div>
        <div class="layout-explain"></div>
      </div>`;
    const test = box.querySelector<HTMLElement>('.test-result')!;
    try {
      const sim = await runInWorker(result.model, { distances: after, signal, recordLog: true });
      const c = compareRuns(run.result, sim, run.model.entityLabel);
      layout.comparison = c;
      opts.onLayoutTested(result.model, sim, newRoutes);
      host.dispatchEvent(new CustomEvent('flow:improved'));
      test.innerHTML = `<p>${verdictHtml(c)}</p>${comparisonHtml(c)}
        <div class="actions">
          <button type="button" data-review="layout-apply">Apply new layout and run again</button>
          <button type="button" data-review="layout-explain">Explain with AI</button>
        </div>`;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      test.innerHTML = `<p class="issue error">The test run failed: ${esc((err as Error).message)}</p>`;
    }
  }

  function applyLayout() {
    if (!layout) return;
    const moved = new Map(layout.result.moves.map((m) => [m.id, m.to]));
    opts.preview(null);
    store.commit((m) => {
      for (const b of m.blocks) {
        const to = moved.get(b.id);
        if (to) [b.x, b.y] = to;
      }
    });
    opts.message('New layout applied. Undo brings back the old one.');
    opts.rerun();
  }

  async function explainLayout() {
    const run = opts.getLastRun();
    if (!run || !layout) return;
    const box = host.querySelector<HTMLElement>('.layout-explain')!;
    const settings = loadSettings();
    const language = (host.querySelector<HTMLSelectElement>('[name="review-lang"]')?.value ?? 'en') as ReviewLanguage;
    box.innerHTML = '<p class="ai-status">Asking the AI to explain…</p>';
    try {
      const text = await callAi(settings, {
        system: layoutExplainSystem(language),
        text: layoutExplainPrompt(run.model, layout.flows, layout.before, layout.after, layout.result.moves,
          { before: layout.result.before, after: layout.result.after }, layout.comparison),
        schemaName: 'layout_explanation', schema: layoutExplainSchema as unknown as Record<string, unknown>,
      });
      const { explanation } = JSON.parse(text) as { explanation: string };
      box.innerHTML = `<p class="review-summary">${esc(explanation)}</p><p class="note">AI text by ${esc(PROVIDERS[settings.provider].name)}; the numbers above come from the simulator.</p>`;
    } catch (err) {
      box.innerHTML = `<p class="issue error">${esc((err as Error).message)}</p>`;
    }
  }

  function apply(i: number) {
    const s = current[i];
    if (!s?.tested) return;
    store.commit((m) => {
      applyChanges(m, s.changes);
      applyMoves(m, s.moves);
    });
    opts.message('Change applied. Undo brings back the previous model.');
    opts.rerun();
  }

  return {
    /** Call after each run so the review button sits above the new results. */
    attach(resultsBody: HTMLElement) {
      controller?.abort();
      current = [];
      layout = null;
      opts.preview(null);
      const wrap = document.createElement('div');
      wrap.className = 'review-wrap';
      wrap.innerHTML = barHtml();
      resultsBody.prepend(wrap);
    },
  };
}
