import { mean } from '../engine/distributions';
import type { Arrival, Block, Distribution, ModelSpec, Point } from '../model/types';
import { DEFAULT_TRAVEL_SPEED_MPS, NEEDS_INPUT_LABELS, type NeedsInput } from '../model/types';
import { BLOCK_STYLES, metersPerPixel, splitEvenly } from './blocks';
import type { Store } from './store';

type Apply = (m: ModelSpec, value: string, el: HTMLInputElement | HTMLSelectElement) => void;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Parses a number field; blank means "not set". */
const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

const DIST_NAMES: Record<Distribution['dist'], string> = {
  fixed: 'Fixed',
  exponential: 'Exponential',
  normal: 'Normal',
  uniform: 'Uniform',
  triangular: 'Triangular',
};

/** A distribution of the new kind with roughly the same mean as the old one. */
function convert(d: Distribution, kind: Distribution['dist']): Distribution {
  const m = +mean(d).toFixed(2) || 1;
  switch (kind) {
    case 'fixed': return { dist: 'fixed', valueMin: m };
    case 'exponential': return { dist: 'exponential', meanMin: m };
    case 'normal': return { dist: 'normal', meanMin: m, sdMin: +(m / 4).toFixed(2) };
    case 'uniform': return { dist: 'uniform', min: +(m / 2).toFixed(2), max: +(m * 1.5).toFixed(2) };
    case 'triangular': return { dist: 'triangular', min: +(m / 2).toFixed(2), mode: m, max: +(m * 1.5).toFixed(2) };
  }
}

/** FR-11: the side panel for whatever is selected, or the model settings. */
export class Inspector {
  private bindings = new Map<string, Apply>();
  private calibration: { a: Point; b: Point } | null = null;

  constructor(private host: HTMLElement, private store: Store, private onCalibrationDone: () => void) {
    host.addEventListener('change', (e) => this.onChange(e));
    host.addEventListener('click', (e) => this.onClick(e));
    store.subscribe(() => this.render());
    this.render();
  }

  showCalibration(a: Point, b: Point) {
    this.calibration = { a, b };
    this.render();
    this.host.querySelector<HTMLInputElement>('[data-key="calib-m"]')?.focus();
  }

  private bind(key: string, apply: Apply) {
    this.bindings.set(key, apply);
    return `data-key="${key}"`;
  }

  private onChange(e: Event) {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const apply = el.dataset.key && this.bindings.get(el.dataset.key);
    if (!apply) return;
    if (el instanceof HTMLInputElement && el.type === 'number' && el.value !== '' && !el.checkValidity()) {
      el.reportValidity();
      return;
    }
    const key = el.dataset.key ?? '';
    const sel = this.store.selection;
    this.store.commit((m) => {
      apply(m, el.value, el);
      // Editing a value the AI could not read counts as confirming it.
      const flag: NeedsInput | undefined = key.startsWith('arr-') ? 'arrival'
        : key === 'servers' ? 'servers'
        : key.startsWith('svc-') ? 'service'
        : key.startsWith('dly-') ? 'time'
        : key.startsWith('prob-') ? 'routing' : undefined;
      const blockId = sel?.kind === 'block' ? sel.id : sel?.kind === 'link' ? m.links[sel.index]?.from : undefined;
      const b = m.blocks.find((x) => x.id === blockId);
      if (!flag || !b?.needsInput) return;
      if (flag === 'routing') {
        const sum = m.links.filter((l) => l.from === b.id).reduce((s, l) => s + (l.prob ?? 0), 0);
        if (Math.abs(sum - 1) > 1e-6) return;
      }
      b.needsInput = b.needsInput.filter((n) => n !== flag);
      if (!b.needsInput.length) delete b.needsInput;
    });
  }

  private onClick(e: Event) {
    const btn = (e.target as Element).closest<HTMLButtonElement>('button[data-action]');
    if (!btn) return;
    const sel = this.store.selection;
    switch (btn.dataset.action) {
      case 'split':
        if (sel?.kind === 'block') this.store.commit((m) => splitEvenly(m, sel.id));
        break;
      case 'confirm-inputs':
        if (sel?.kind === 'block') {
          this.store.commit((m) => {
            const b = m.blocks.find((x) => x.id === sel.id);
            if (b) delete b.needsInput;
          });
        }
        break;
      case 'delete':
        this.host.dispatchEvent(new CustomEvent('delete-selection', { bubbles: true }));
        break;
      case 'duplicate':
        this.host.dispatchEvent(new CustomEvent('duplicate-selection', { bubbles: true }));
        break;
      case 'calib-apply': {
        const input = this.host.querySelector<HTMLInputElement>('[data-key="calib-m"]')!;
        const meters = Number(input.value);
        if (!this.calibration || !(meters > 0)) {
          input.reportValidity();
          return;
        }
        const { a, b } = this.calibration;
        const px = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (px < 1) return;
        this.store.commit((m) => {
          // Footprints are stored in meters, so they keep their real size under the new scale.
          m.background = { ...(m.background ?? { file: '' }), metersPerPixel: +(meters / px).toPrecision(4), calibrated: true };
        });
        this.calibration = null;
        this.onCalibrationDone();
        this.render();
        break;
      }
      case 'calib-cancel':
        this.calibration = null;
        this.onCalibrationDone();
        this.render();
        break;
    }
  }

  render() {
    // Re-rendering replaces the inputs, so put focus back where it was.
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && this.host.contains(active) ? active.dataset.key : undefined;
    this.bindings.clear();
    const sel = this.store.selection;
    const m = this.store.model;
    let html: string;
    if (this.calibration) html = this.calibrationHtml();
    else if (sel?.kind === 'block') {
      const b = m.blocks.find((x) => x.id === sel.id);
      html = b ? this.blockHtml(b) : this.modelHtml();
    } else if (sel?.kind === 'link' && m.links[sel.index]) html = this.linkHtml(sel.index);
    else if (sel?.kind === 'wall' && m.walls?.[sel.index]) html = this.wallHtml(sel.index);
    else html = this.modelHtml();
    this.host.innerHTML = html;
    if (focusKey) this.host.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
  }

  // ---- field helpers ----

  private field(label: string, input: string, hint = '') {
    return `<label class="field"><span>${label}</span>${input}${hint ? `<small>${hint}</small>` : ''}</label>`;
  }

  private numberInput(key: string, value: number | undefined, apply: Apply, attrs = 'min="0" step="any"', placeholder = '') {
    return `<input type="number" ${attrs} value="${value ?? ''}" placeholder="${placeholder}" ${this.bind(key, apply)}>`;
  }

  private textInput(key: string, value: string, apply: Apply) {
    return `<input type="text" value="${esc(value)}" ${this.bind(key, apply)}>`;
  }

  /** Edits a distribution `d`; `set` writes the new value into the model. */
  private distHtml(prefix: string, d: Distribution, set: (m: ModelSpec, d: Distribution) => void, unit = 'min') {
    const kinds = Object.keys(DIST_NAMES) as Distribution['dist'][];
    const select = `<select ${this.bind(`${prefix}-kind`, (m, v) => set(m, convert(d, v as Distribution['dist'])))}>
      ${kinds.map((k) => `<option value="${k}" ${k === d.dist ? 'selected' : ''}>${DIST_NAMES[k]}</option>`).join('')}
    </select>`;
    const param = (name: string, label: string, value: number) =>
      this.field(`${label} (${unit})`, this.numberInput(`${prefix}-${name}`, value, (m, v) => {
        const n = num(v);
        if (n === undefined) return;
        set(m, { ...d, [name]: n } as Distribution);
      }, 'min="0" step="any" required'));
    let params = '';
    switch (d.dist) {
      case 'fixed': params = param('valueMin', 'Value', d.valueMin); break;
      case 'exponential': params = param('meanMin', 'Mean', d.meanMin); break;
      case 'normal': params = param('meanMin', 'Mean', d.meanMin) + param('sdMin', 'Std. dev.', d.sdMin); break;
      case 'uniform': params = param('min', 'Min', d.min) + param('max', 'Max', d.max); break;
      case 'triangular': params = param('min', 'Min', d.min) + param('mode', 'Most likely', d.mode) + param('max', 'Max', d.max); break;
    }
    return this.field('Distribution', select) + `<div class="params">${params}</div>`;
  }

  private arrivalHtml(b: Block & { type: 'source' }) {
    const a = b.arrival;
    const setArrival = (m: ModelSpec, next: Arrival) => {
      const t = m.blocks.find((x) => x.id === b.id);
      if (t?.type === 'source') t.arrival = next;
    };
    const mode = 'ratePerHour' in a ? (a.dist === 'fixed' ? 'even' : 'poisson') : 'custom';
    const rate = 'ratePerHour' in a ? a.ratePerHour : +(60 / mean(a)).toFixed(2);
    const modeSelect = `<select ${this.bind('arr-mode', (m, v) => {
      if (v === 'poisson') setArrival(m, { dist: 'exponential', ratePerHour: rate });
      else if (v === 'even') setArrival(m, { dist: 'fixed', ratePerHour: rate });
      else setArrival(m, { dist: 'uniform', min: +(30 / rate).toFixed(2), max: +(90 / rate).toFixed(2) });
    })}>
      <option value="poisson" ${mode === 'poisson' ? 'selected' : ''}>Random (Poisson) at a rate</option>
      <option value="even" ${mode === 'even' ? 'selected' : ''}>Evenly spaced at a rate</option>
      <option value="custom" ${mode === 'custom' ? 'selected' : ''}>Time between arrivals…</option>
    </select>`;
    let body: string;
    if ('ratePerHour' in a) {
      body = this.field(`Arrivals per hour`, this.numberInput('arr-rate', a.ratePerHour, (m, v) => {
        const n = num(v);
        if (n) setArrival(m, { ...a, ratePerHour: n });
      }, 'min="0.001" step="any" required'), 'λ, the arrival rate');
    } else {
      body = this.distHtml('arr', a, setArrival);
    }
    return this.field('Arrival pattern', modeSelect) + body;
  }

  // ---- panels ----

  private blockHtml(b: Block): string {
    const s = BLOCK_STYLES[b.type];
    const id = b.id;
    const upd = (m: ModelSpec, fn: (t: Block) => void) => {
      const t = m.blocks.find((x) => x.id === id);
      if (t) fn(t);
    };
    const set = <K extends string>(key: K, parse: (v: string) => unknown): Apply => (m, v) => {
      const t = m.blocks.find((x) => x.id === id) as unknown as Record<string, unknown> | undefined;
      if (!t) return;
      const val = parse(v);
      if (val === undefined || val === '') delete t[key];
      else t[key] = val;
    };
    const origin = b.origin === 'ai' ? `<span class="badge warn">AI-detected</span>` : `<span class="badge">User-entered</span>`;

    let body = '';
    switch (b.type) {
      case 'source':
        body = this.arrivalHtml(b)
          + this.field('Group size', this.numberInput('group', b.groupSize, set('groupSize', num), 'min="1" step="1"', '1'), 'Entities per arrival')
          + this.field('Max arrivals', this.numberInput('maxArr', b.maxArrivals, set('maxArrivals', num), 'min="1" step="1"', 'Unlimited'));
        break;
      case 'queue':
        body = this.field('Discipline', `<select ${this.bind('disc', set('discipline', (v) => v))}>
            ${['FIFO', 'LIFO'].map((d) => `<option ${d === (b.discipline ?? 'FIFO') ? 'selected' : ''}>${d}</option>`).join('')}
          </select>`, 'Priority order comes in a later release')
          + this.field('Capacity', this.numberInput('cap', b.capacity, set('capacity', num), 'min="1" step="1"', 'Unlimited'), 'Arrivals to a full line are lost')
          + this.field('Balk when line reaches', this.numberInput('balk', b.balkThreshold, set('balkThreshold', num), 'min="1" step="1"', 'Never'));
        break;
      case 'server':
        body = this.field('Servers (c)', this.numberInput('servers', b.servers, set('servers', num), 'min="1" step="1" required'), 'Tellers, bartenders, machines working in parallel')
          + `<h4>Service time</h4>`
          + this.distHtml('svc', b.service, (m, d) => upd(m, (t) => { if (t.type === 'server') t.service = d; }));
        break;
      case 'resource':
        body = this.field('Count', this.numberInput('count', b.count, set('count', num), 'min="1" step="1" required'))
          + this.field('Speed (m/s)', this.numberInput('speed', b.speedMps, set('speedMps', num), 'min="0.01" step="any"', String(DEFAULT_TRAVEL_SPEED_MPS)))
          + `<p class="note">Resources are placed now and simulated in a later release.</p>`;
        break;
      case 'delay':
        body = `<h4>Time spent</h4>`
          + this.distHtml('dly', b.time, (m, d) => upd(m, (t) => { if (t.type === 'delay') t.time = d; }));
        break;
      case 'decision': {
        const outs = this.store.model.links.map((l, i) => ({ l, i })).filter(({ l }) => l.from === id);
        const sum = outs.reduce((s, { l }) => s + (l.prob ?? 0), 0);
        const label = (bid: string) => this.store.model.blocks.find((x) => x.id === bid)?.label ?? bid;
        body = outs.length
          ? `<h4>Routing probabilities</h4>`
            + outs.map(({ l, i }) => this.field(`→ ${esc(label(l.to))}`, this.numberInput(`prob-${i}`, l.prob, (m, v) => {
                m.links[i].prob = num(v);
              }, 'min="0" max="1" step="0.01" required'))).join('')
            + `<p class="${Math.abs(sum - 1) > 1e-6 ? 'note bad' : 'note'}">Sum: ${+sum.toFixed(4)} (must be 1)</p>
               <button type="button" data-action="split">Split evenly</button>`
          : `<p class="note">Use the Link tool to add the outputs, then set their probabilities here.</p>`;
        break;
      }
      case 'sink':
        body = `<p class="note">Entities leave here and their time in system is recorded.</p>`;
        break;
    }

    return `<h3><span class="swatch" style="--c:${s.color}"></span>${s.name}</h3>
      <p class="origin">${origin}</p>
      ${b.needsInput?.length
        ? `<div class="issue warning">The AI could not read the ${b.needsInput.map((n) => NEEDS_INPUT_LABELS[n]).join(' and ')} from the plan; the value below is a placeholder.
            Change it, or keep it if it is right.
            <div class="actions"><button type="button" data-action="confirm-inputs">Keep these values</button></div></div>`
        : ''}
      ${this.field('Label', this.textInput('label', b.label, set('label', (v) => v)))}
      ${body}
      <details class="footprint"><summary>Footprint and position</summary>
        ${this.field('Width (m)', this.numberInput('w', b.w ?? s.w, set('w', num), 'min="0.1" step="any"'))}
        ${this.field('Depth (m)', this.numberInput('h', b.h ?? s.h, set('h', num), 'min="0.1" step="any"'))}
        ${this.field('Rotation (°)', this.numberInput('rot', b.rotation ?? 0, set('rotation', num), 'step="1"'))}
        <p class="note">Id: <code>${esc(b.id)}</code></p>
      </details>
      <div class="actions">
        <button type="button" data-action="duplicate">Duplicate</button>
        <button type="button" data-action="delete" class="danger">Delete</button>
      </div>`;
  }

  private linkHtml(i: number): string {
    const m = this.store.model;
    const l = m.links[i];
    const label = (id: string) => esc(m.blocks.find((b) => b.id === id)?.label ?? id);
    const fromDecision = m.blocks.find((b) => b.id === l.from)?.type === 'decision';
    return `<h3>Link</h3>
      <p>${label(l.from)} → ${label(l.to)}</p>
      ${fromDecision
        ? this.field('Probability', this.numberInput(`prob-${i}`, l.prob, (mm, v) => { mm.links[i].prob = num(v); }, 'min="0" max="1" step="0.01" required'), 'Share of entities leaving the Decision this way')
        : ''}
      <div class="actions"><button type="button" data-action="delete" class="danger">Delete link</button></div>`;
  }

  private wallHtml(i: number): string {
    const w = this.store.model.walls![i];
    const mpp = metersPerPixel(this.store.model);
    let len = 0;
    for (let j = 1; j < w.length; j++) len += Math.hypot(w[j][0] - w[j - 1][0], w[j][1] - w[j - 1][1]);
    return `<h3>Wall</h3>
      <p>${w.length} points, ${(len * mpp).toFixed(1)} m long.</p>
      <div class="actions"><button type="button" data-action="delete" class="danger">Delete wall</button></div>`;
  }

  private calibrationHtml(): string {
    const { a, b } = this.calibration!;
    const px = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return `<h3>Calibrate scale</h3>
      <p>The line you drew is ${px.toFixed(0)} pixels long. How long is it in reality?</p>
      ${this.field('Real distance (m)', `<input type="number" min="0.01" step="any" required data-key="calib-m">`)}
      <div class="actions">
        <button type="button" class="primary" data-action="calib-apply">Set scale</button>
        <button type="button" data-action="calib-cancel">Cancel</button>
      </div>`;
  }

  private modelHtml(): string {
    const m = this.store.model;
    const bg = m.background;
    const scale = bg
      ? `${+(1 / bg.metersPerPixel).toFixed(2)} px per meter${bg.calibrated === false ? ' <span class="badge warn">Not calibrated</span>' : ''}`
      : `Not set (assuming ${+(1 / metersPerPixel(m)).toFixed(0)} px per meter)`;
    const run = (key: keyof ModelSpec['run'], parse = num): Apply => (mm, v) => {
      const n = parse(v);
      if (n !== undefined) mm.run[key] = n;
    };
    return `<h3>Model settings</h3>
      <p class="note">Select a block, link or wall to edit it.</p>
      ${this.field('Entities are called', this.textInput('entity', m.entityLabel, (mm, v) => { if (v.trim()) mm.entityLabel = v.trim(); }), 'customer, patient, part, pallet…')}
      ${this.field('Walking speed (m/s)', this.numberInput('speed', m.travelSpeedMps ?? DEFAULT_TRAVEL_SPEED_MPS, (mm, v) => { mm.travelSpeedMps = num(v); }, 'min="0.01" step="any"'))}
      <p class="field"><span>Plan scale</span>${scale}</p>
      <h4>Run settings</h4>
      ${this.field('Length (hours)', this.numberInput('hours', m.run.hours, run('hours'), 'min="0.1" step="any" required'))}
      ${this.field('Warm-up (minutes)', this.numberInput('warmup', m.run.warmupMin, run('warmupMin'), 'min="0" step="any" required'), 'Results before this are discarded')}
      ${this.field('Replications', this.numberInput('reps', m.run.replications, run('replications'), 'min="2" max="1000" step="1" required'))}
      ${this.field('Random seed', this.numberInput('seed', m.run.seed, run('seed'), 'step="1" required'), 'Same seed, same results')}`;
  }
}
