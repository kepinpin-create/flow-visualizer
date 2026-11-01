// "Layout scorecard" panel in the results: measured grades, problem spots on the plan,
// and AI layout advice whose every suggestion is re-scored and re-simulated before you apply it.
import { callAi, PROVIDERS } from '../ai/providers';
import { compareRuns } from '../ai/review';
import type { LastRun } from '../ai/review-ui';
import { loadSettings } from '../ai/settings';
import { planExtent } from '../editor/blocks';
import type { Store } from '../editor/store';
import { runInWorker } from '../engine/runner';
import type { ModelSpec, Point } from '../model/types';
import { validateModel } from '../model/validate';
import { computeRoutes, routeDistances, type Route } from '../routing/pathfinder';
import { advicePrompt, adviceSchema, adviceSystem, parseAdvice, planAdvice } from './advice';
import { scoreLayout, type Grade, type Marker, type Scorecard } from './scorecard';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const GRADE_LABEL: Record<Grade, string> = { good: 'Good', fair: 'Fair', poor: 'Poor' };
const GRADE_CLASS: Record<Grade, string> = { good: 'ok', fair: 'warn', poor: 'bad' };
const GRADE_RANK: Record<Grade, number> = { poor: 0, fair: 1, good: 2 };

function cardHtml(card: Scorecard): string {
  return `<div class="scorecard">
    <div class="score-total" aria-label="Layout score ${card.score} out of 100"><strong>${card.score}</strong><span>/100</span></div>
    <ul class="criteria">${card.criteria.map((c) => `
      <li><span class="badge ${GRADE_CLASS[c.grade]}">${GRADE_LABEL[c.grade]}</span>
        <div><strong>${esc(c.label)}</strong><p>${esc(c.detail)}</p></div></li>`).join('')}
    </ul>
  </div>`;
}

export function setupScorecard(opts: {
  host: HTMLElement;
  store: Store;
  getLastRun: () => LastRun | null;
  ensureKey: (then: () => void) => void;
  message: (t: string, kind?: 'info' | 'error') => void;
  rerun: () => void;
  markers: (m: Marker[] | null) => void;
  preview: (moves: { id: string; to: Point; w?: number; h?: number }[] | null, routes?: Map<string, Route>) => void;
}) {
  const { host, store } = opts;
  let controller: AbortController | null = null;
  let base: { card: Scorecard; routes: Map<string, Route> } | null = null;
  let trials: { model: ModelSpec; routes: Map<string, Route> }[] = [];

  host.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-score]');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    switch (btn.dataset.score) {
      case 'run': score(); break;
      case 'advise': opts.ensureKey(() => void advise()); break;
      case 'preview': preview(i); break;
      case 'apply': apply(i); break;
    }
  });

  const out = () => host.querySelector<HTMLElement>('.score-out')!;

  function score() {
    const run = opts.getLastRun();
    if (!run) return;
    const { width, height } = planExtent(run.model);
    const routes = computeRoutes(run.model, width, height);
    const card = scoreLayout(run.model, routes, run.result);
    base = { card, routes };
    opts.markers(card.criteria.flatMap((c) => c.markers));
    const spots = card.criteria.reduce((n, c) => n + c.markers.length, 0);
    out().innerHTML = `<div class="review">
      <h3>Layout scorecard</h3>
      <p class="note">Measured from this layout and its simulation, not guessed.${spots ? ` ${spots} problem spot${spots > 1 ? 's are' : ' is'} marked on the plan; hover a marker for details.` : ''}</p>
      ${cardHtml(card)}
      <div class="actions">
        <button type="button" class="ai" data-score="advise"><svg class="i" aria-hidden="true"><use href="#i-sparkles"/></svg><span>AI layout advice</span></button>
        <span class="note">The AI suggests moves and resizes; each one is placed legally, re-scored and simulated before you see it.</span>
      </div>
      <div class="advice-out"></div>
    </div>`;
    out().scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function advise() {
    const run = opts.getLastRun();
    if (!run || !base) return;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const settings = loadSettings();
    const language = (host.querySelector<HTMLSelectElement>('[name="review-lang"]')?.value ?? 'en') as 'en' | 'id';
    const box = out().querySelector<HTMLElement>('.advice-out')!;
    box.innerHTML = `<p class="ai-status">Asking ${esc(PROVIDERS[settings.provider].name)} for layout advice…</p>`;
    let reply;
    try {
      reply = parseAdvice(await callAi(settings, {
        system: adviceSystem(language), text: advicePrompt(run.model, run.result, base.card),
        schemaName: 'layout_advice', schema: adviceSchema as unknown as Record<string, unknown>, signal,
      }));
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      box.innerHTML = `<p class="issue error">${esc((err as Error).message)}</p>`;
      return;
    }
    trials = [];
    box.innerHTML = `<p class="review-summary">${esc(reply.summary)}</p>` + reply.suggestions.map((s, i) => `
      <article class="suggestion" data-i="${i}">
        <h3>${i + 1}. ${esc(s.title)}</h3>
        <p>${esc(s.why)}</p>
        <div class="test-result"><p class="ai-status">Waiting to be checked…</p></div>
      </article>`).join('') + `<p class="note">AI text by ${esc(PROVIDERS[settings.provider].name)}; grades and numbers come from the scorecard and the simulator.</p>`;

    // Check each suggestion locally: legal placement, new paths, new simulation, new grades (no tokens).
    for (let i = 0; i < reply.suggestions.length; i++) {
      if (signal.aborted) return;
      const cell = box.querySelector<HTMLElement>(`.suggestion[data-i="${i}"] .test-result`)!;
      const planned = planAdvice(run.model, reply.suggestions[i]);
      const list = `<ul class="changes">${planned.changes.map((c) => `<li>${esc(c.summary)}${c.problem ? ` <span class="bad">(${esc(c.problem)})</span>` : ''}</li>`).join('')}</ul>`;
      const v = validateModel(planned.model);
      if (!planned.ok || !v.ok) {
        cell.innerHTML = `${list}<p class="issue warning">Not checked: ${esc(planned.changes.find((c) => c.problem)?.problem ?? v.errors[0]?.message ?? 'no concrete change')}.</p>`;
        continue;
      }
      const { width, height } = planExtent(planned.model);
      const routes = computeRoutes(planned.model, width, height);
      cell.innerHTML = `${list}<p class="ai-status">Simulating and re-scoring…</p>`;
      try {
        const sim = await runInWorker(planned.model, { distances: routeDistances(routes), signal });
        const after = scoreLayout(planned.model, routes, sim);
        const cmp = compareRuns(run.result, sim, run.model.entityLabel);
        trials[i] = { model: planned.model, routes };
        const rows = base.card.criteria.map((c, k) => {
          const a = after.criteria[k];
          const delta = GRADE_RANK[a.grade] - GRADE_RANK[c.grade];
          const arrow = delta > 0 ? '<span class="good">▲ better</span>' : delta < 0 ? '<span class="bad">▼ worse</span>' : '<span class="ci">≈ same</span>';
          return `<tr><td>${esc(c.label)}</td><td><span class="badge ${GRADE_CLASS[c.grade]}">${GRADE_LABEL[c.grade]}</span></td>
            <td><span class="badge ${GRADE_CLASS[a.grade]}">${GRADE_LABEL[a.grade]}</span></td><td>${arrow}</td></tr>`;
        }).join('');
        const t = cmp.metrics[0];
        const w = cmp.metrics.find((m) => m.label.startsWith('Walking'))!;
        const better = after.score > base.card.score;
        cell.innerHTML = `${list}
          <p><span class="badge ${better ? 'ok' : after.score < base.card.score ? 'bad' : ''}">Layout score ${base.card.score} → ${after.score}</span>
            <span class="note">Time in system ${t.before.mean.toFixed(1)} → ${t.after.mean.toFixed(1)} min · walking ${w.before.mean.toFixed(1)} → ${w.after.mean.toFixed(1)} m</span></p>
          <div class="table-wrap"><table class="compare"><thead><tr><th>Criterion</th><th>Now</th><th>With this change</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
          <div class="actions">
            <button type="button" data-score="preview" data-i="${i}">Show on plan</button>
            <button type="button" data-score="apply" data-i="${i}">Apply and run again</button>
          </div>`;
        host.dispatchEvent(new CustomEvent('flow:improved'));
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        cell.innerHTML = `${list}<p class="issue error">The check failed: ${esc((err as Error).message)}</p>`;
      }
    }
  }

  function changed(i: number) {
    const t = trials[i];
    if (!t) return [];
    return t.model.blocks
      .map((b) => ({ b, o: store.model.blocks.find((x) => x.id === b.id) }))
      .filter(({ b, o }) => o && (o.x !== b.x || o.y !== b.y || o.w !== b.w || o.h !== b.h))
      .map(({ b }) => ({ id: b.id, to: [b.x, b.y] as Point, w: b.w, h: b.h }));
  }

  function preview(i: number) {
    const t = trials[i];
    if (!t) return;
    opts.markers(null);
    opts.preview(changed(i), t.routes);
    document.getElementById('canvas')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function apply(i: number) {
    const t = trials[i];
    if (!t) return;
    const updates = new Map(t.model.blocks.map((b) => [b.id, b]));
    opts.preview(null);
    opts.markers(null);
    store.commit((m) => {
      for (const b of m.blocks) {
        const u = updates.get(b.id);
        if (u) Object.assign(b, { x: u.x, y: u.y, w: u.w, h: u.h });
      }
    });
    opts.message('Layout change applied. Undo brings back the previous layout.');
    opts.rerun();
  }

  return {
    /** New results: drop the old scorecard and markers. */
    reset() {
      controller?.abort();
      base = null;
      trials = [];
      opts.markers(null);
    },
  };
}
