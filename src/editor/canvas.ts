import type { Block, BlockType, Point } from '../model/types';
import {
  BLOCK_STYLES, deleteBlock, footprintPx, linkProblem, metersPerPixel, newBlock, planExtent, splitEvenly, uniqueId,
} from './blocks';
import type { Store } from './store';
import { routeKey, type Route } from '../routing/pathfinder';

export type Tool = 'select' | 'link' | 'wall' | 'calibrate';

export interface CanvasHooks {
  /** Short guidance or an error for the status line. */
  message(text: string, kind?: 'info' | 'error'): void;
  /** Two calibration points picked; the caller asks for the real distance. */
  calibrationPoints(a: Point, b: Point): void;
  toolChanged(tool: Tool): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const PLAN_OPACITY_KEY = 'flow-visualizer.planOpacity';
const DEFAULT_PLAN_OPACITY = 40;

function readPlanOpacity(): number {
  try {
    const v = Number(localStorage.getItem(PLAN_OPACITY_KEY));
    if (v >= 10 && v <= 100) return v;
  } catch {
    // storage blocked: use the default
  }
  return DEFAULT_PLAN_OPACITY;
}
const MIN_SIZE_M = 0.3;

type Drag =
  | { kind: 'move'; id: string; startX: number; startY: number; px: number; py: number }
  | { kind: 'resize'; id: string }
  | { kind: 'rotate'; id: string; snap: boolean }
  | { kind: 'pan'; cx: number; cy: number; vx: number; vy: number };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const f = (n: number) => +n.toFixed(2);

/** The floor plan with blocks, links and walls drawn over it (FR-04–FR-10). */
export class PlanCanvas {
  readonly svg: SVGSVGElement;
  private world: SVGGElement;
  private image: SVGImageElement;
  private grid: SVGRectElement;
  private content: SVGGElement;
  private overlay: SVGGElement;
  private view = { x: 20, y: 20, k: 1 };
  private drag: Drag | null = null;
  private linkFrom: string | null = null;
  private wallDraft: Point[] = [];
  private calib: Point[] = [];
  private pointer: Point | null = null;
  private imageHref = '';
  private planControls: HTMLElement;
  /** Plan image visibility, percent. Faded by default so blocks stand out. */
  private planOpacity = readPlanOpacity();
  private planShown = true;
  tool: Tool = 'select';
  /** Blocks to outline in red because validation flagged them. */
  flagged = new Set<string>();
  /** Walking paths per link, drawn faintly under the links. */
  routes = new Map<string, Route>();
  /** People per hour on each link; busier paths are drawn thicker. */
  routeFlows = new Map<string, number>();
  /** A proposed layout (Optimize layout): new spots and the walking paths they give. */
  private preview: { id: string; to: Point }[] = [];
  private previewRoutes: Map<string, Route> | null = null;
  /** Which layout the plan shows while a proposal exists. The proposal view is look-only. */
  private viewing: 'current' | 'proposal' = 'current';
  private viewSwitch!: HTMLElement;
  private modeListeners = new Set<(mode: 'current' | 'proposal') => void>();

  /** Shows a proposed layout and switches the plan to it; null removes it. */
  setPreview(moves: { id: string; to: Point }[] | null, routes?: Map<string, Route>) {
    this.preview = moves ?? [];
    this.previewRoutes = routes ?? null;
    this.setViewing(this.preview.length ? 'proposal' : 'current');
  }

  onModeChange(fn: (mode: 'current' | 'proposal') => void) {
    this.modeListeners.add(fn);
  }

  private setViewing(mode: 'current' | 'proposal') {
    this.viewing = this.preview.length ? mode : 'current';
    this.viewSwitch.hidden = !this.preview.length;
    for (const b of this.viewSwitch.querySelectorAll<HTMLButtonElement>('[data-view]')) {
      b.setAttribute('aria-pressed', String(b.dataset.view === this.viewing));
    }
    this.svg.classList.toggle('proposal', this.viewing === 'proposal');
    for (const fn of this.modeListeners) fn(this.viewing);
    this.render();
  }

  /** The model as drawn: with the proposed positions while viewing the proposal. */
  private displayModel() {
    const m = this.store.model;
    if (this.viewing !== 'proposal' || !this.preview.length) return m;
    const to = new Map(this.preview.map((p) => [p.id, p.to]));
    return { ...m, blocks: m.blocks.map((b) => (to.has(b.id) ? { ...b, x: to.get(b.id)![0], y: to.get(b.id)![1] } : b)) };
  }
  private viewListeners = new Set<() => void>();
  /** Fingers currently on the plan, by pointer id, in client pixels. */
  private touches = new Map<number, Point>();
  private pinch: { dist: number; mx: number; my: number; view: { x: number; y: number; k: number } } | null = null;

  constructor(host: HTMLElement, private store: Store, private hooks: CanvasHooks) {
    host.innerHTML = `
      <svg class="plan" xmlns="${SVG_NS}" tabindex="0" aria-label="Floor plan editor">
        <defs>
          <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
            <path d="M50 0H0V50" fill="none" class="grid-line"/>
          </pattern>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" class="arrow-head"/>
          </marker>
        </defs>
        <g class="world">
          <rect class="plan-bg" x="0" y="0"/>
          <image class="plan-image" x="0" y="0" preserveAspectRatio="none"/>
          <rect class="plan-grid" x="0" y="0" fill="url(#grid)"/>
          <g class="content"></g>
          <g class="overlay"></g>
        </g>
      </svg>`;
    this.svg = host.querySelector('svg')!;
    this.world = this.svg.querySelector('.world')!;
    this.image = this.svg.querySelector('.plan-image')!;
    this.grid = this.svg.querySelector('.plan-grid')!;
    this.content = this.svg.querySelector('.content')!;
    this.overlay = this.svg.querySelector('.overlay')!;

    // Switch between the current layout and a proposed one, over the same floor plan.
    this.viewSwitch = document.createElement('div');
    this.viewSwitch.className = 'view-switch';
    this.viewSwitch.hidden = true;
    this.viewSwitch.setAttribute('role', 'group');
    this.viewSwitch.setAttribute('aria-label', 'Layout shown');
    this.viewSwitch.innerHTML = `
      <button type="button" data-view="current">Current layout</button>
      <button type="button" data-view="proposal">Optimized layout</button>`;
    host.appendChild(this.viewSwitch);
    this.viewSwitch.addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).closest<HTMLElement>('[data-view]')?.dataset.view;
      if (v === 'current' || v === 'proposal') this.setViewing(v);
    });

    // Fade or hide the uploaded plan so the blocks on top stay readable.
    this.planControls = document.createElement('div');
    this.planControls.className = 'plan-controls';
    this.planControls.innerHTML = `
      <label class="inline">Plan <input type="range" min="10" max="100" step="5" aria-label="Plan visibility"></label>
      <label class="inline"><input type="checkbox" checked> Show</label>`;
    host.appendChild(this.planControls);
    const [fade, show] = this.planControls.querySelectorAll('input');
    fade.value = String(this.planOpacity);
    fade.addEventListener('input', () => {
      this.planOpacity = Number(fade.value);
      show.checked = true;
      this.planShown = true;
      this.applyPlanLook();
      try {
        localStorage.setItem(PLAN_OPACITY_KEY, fade.value);
      } catch {
        // per-viewer convenience only
      }
    });
    show.addEventListener('change', () => {
      this.planShown = show.checked;
      this.applyPlanLook();
    });

    this.svg.addEventListener('pointerdown', (e) => this.onDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onMove(e));
    this.svg.addEventListener('pointerup', (e) => this.onUp(e));
    this.svg.addEventListener('pointercancel', (e) => this.onUp(e));
    this.svg.addEventListener('dblclick', () => this.tool === 'wall' && this.finishWall());
    this.svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.svg.addEventListener('dragover', (e) => e.preventDefault());
    this.svg.addEventListener('drop', (e) => this.onDrop(e));
    store.subscribe(() => this.render());
    this.render();
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.linkFrom = null;
    this.wallDraft = [];
    this.calib = [];
    this.svg.dataset.tool = tool;
    this.hooks.toolChanged(tool);
    const help: Record<Tool, string> = {
      select: matchMedia('(pointer: coarse)').matches
        ? 'Drag blocks to move them. Drag empty space to pan; pinch with two fingers to zoom.'
        : 'Drag blocks to move them. Use the corner handle to resize and the top handle to rotate. Drag empty space to pan; scroll to zoom.',
      link: 'Click the block the flow leaves, then the block it goes to.',
      wall: 'Click to add wall points. Double-click or press Enter to finish; Esc cancels.',
      calibrate: 'Click two points whose real distance you know, such as the ends of a wall or a door.',
    };
    this.hooks.message(help[tool]);
    this.render();
  }

  clearCalibration() {
    this.calib = [];
    this.render();
  }

  /** Zooms so the whole plan fits the view. */
  fit() {
    const { width, height } = planExtent(this.store.model);
    const r = this.svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const k = Math.min(r.width / (width + 40), r.height / (height + 40));
    this.view = { k, x: (r.width - width * k) / 2, y: (r.height - height * k) / 2 };
    this.render();
  }

  /** Keyboard shortcuts; returns true when the key was handled. */
  handleKey(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) this.store.redo();
      else this.store.undo();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      this.store.redo();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'd') {
      this.duplicateSelection();
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelection();
      return true;
    }
    if (e.key === 'Enter' && this.tool === 'wall') {
      this.finishWall();
      return true;
    }
    if (e.key === 'Escape') {
      if (this.tool !== 'select') this.setTool('select');
      else this.store.select(null);
      return true;
    }
    return false;
  }

  deleteSelection() {
    const s = this.store.selection;
    if (!s) return;
    this.store.commit((m) => {
      if (s.kind === 'block') deleteBlock(m, s.id);
      if (s.kind === 'link') m.links.splice(s.index, 1);
      if (s.kind === 'wall') m.walls?.splice(s.index, 1);
    });
    this.store.select(null);
  }

  duplicateSelection() {
    const s = this.store.selection;
    if (s?.kind !== 'block') return;
    const src = this.store.model.blocks.find((b) => b.id === s.id);
    if (!src) return;
    let id = '';
    this.store.commit((m) => {
      id = uniqueId(m, src.type);
      // A JSON round trip rather than structuredClone, which older Safari lacks; blocks are plain JSON.
      const copy = { ...(JSON.parse(JSON.stringify(src)) as typeof src), id, label: `${src.label} copy`, x: src.x + 30, y: src.y + 30, origin: 'user' as const };
      m.blocks.push(copy);
    });
    this.store.select({ kind: 'block', id });
  }

  // ---- coordinates ----

  private toWorld(e: { clientX: number; clientY: number }): Point {
    const ctm = this.world.getScreenCTM();
    if (!ctm) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return [p.x, p.y];
  }

  private block(id: string): Block | undefined {
    return this.store.model.blocks.find((b) => b.id === id);
  }

  // ---- pointer handling ----

  private onDown(e: PointerEvent) {
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.touches.size === 2) {
        // A second finger turns whatever the first one started into a pinch.
        if (this.drag && this.drag.kind !== 'pan') this.store.endGesture();
        this.drag = null;
        this.startPinch();
        return;
      }
      if (this.touches.size > 2) return;
    }
    if (e.button !== 0 && e.button !== 1) return;
    this.svg.focus();
    if (this.viewing === 'proposal') {
      // The proposal is to look at, not edit: only panning works here.
      this.hooks.message('This is the proposed layout. Switch to “Current layout” to edit, or apply it from the results.');
      this.startPan(e);
      return;
    }
    const target = e.target as Element;
    const p = this.toWorld(e);
    const blockEl = target.closest<SVGElement>('[data-block]');
    const handle = target.closest<SVGElement>('[data-handle]');
    const linkEl = target.closest<SVGElement>('[data-link]');
    const wallEl = target.closest<SVGElement>('[data-wall]');

    if (e.button === 1) {
      this.startPan(e);
      return;
    }

    if (this.tool === 'link') {
      if (!blockEl) {
        this.linkFrom = null;
        this.render();
        return;
      }
      const id = blockEl.dataset.block!;
      if (!this.linkFrom) {
        this.linkFrom = id;
        this.hooks.message(`From ${this.block(id)?.label}. Now click where the flow goes.`);
        this.render();
        return;
      }
      const problem = linkProblem(this.store.model, this.linkFrom, id);
      if (problem) {
        this.hooks.message(problem, 'error');
        return;
      }
      const from = this.linkFrom;
      this.store.commit((m) => {
        m.links.push({ from, to: id });
        if (m.blocks.find((b) => b.id === from)?.type === 'decision') splitEvenly(m, from);
      });
      this.linkFrom = null;
      this.hooks.message(`Linked. Click the next block the flow leaves, or press Esc.`);
      this.render();
      return;
    }

    if (this.tool === 'wall') {
      this.wallDraft.push([f(p[0]), f(p[1])]);
      this.render();
      return;
    }

    if (this.tool === 'calibrate') {
      this.calib.push(p);
      if (this.calib.length === 2) this.hooks.calibrationPoints(this.calib[0], this.calib[1]);
      if (this.calib.length > 2) this.calib = [p];
      this.render();
      return;
    }

    // Select tool.
    if (handle) {
      const id = handle.dataset.id!;
      this.store.beginGesture();
      this.drag = handle.dataset.handle === 'resize' ? { kind: 'resize', id } : { kind: 'rotate', id, snap: !e.altKey };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (blockEl) {
      const id = blockEl.dataset.block!;
      const b = this.block(id)!;
      this.store.select({ kind: 'block', id });
      this.store.beginGesture();
      this.drag = { kind: 'move', id, startX: b.x, startY: b.y, px: p[0], py: p[1] };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (linkEl) {
      this.store.select({ kind: 'link', index: Number(linkEl.dataset.link) });
      return;
    }
    if (wallEl) {
      this.store.select({ kind: 'wall', index: Number(wallEl.dataset.wall) });
      return;
    }
    this.store.select(null);
    this.startPan(e);
  }

  private startPan(e: PointerEvent) {
    this.drag = { kind: 'pan', cx: e.clientX, cy: e.clientY, vx: this.view.x, vy: this.view.y };
    this.svg.setPointerCapture(e.pointerId);
  }

  private startPinch() {
    const [[ax, ay], [bx, by]] = [...this.touches.values()];
    const r = this.svg.getBoundingClientRect();
    this.pinch = {
      dist: Math.hypot(bx - ax, by - ay) || 1,
      mx: (ax + bx) / 2 - r.left,
      my: (ay + by) / 2 - r.top,
      view: { ...this.view },
    };
  }

  /** Two-finger zoom and pan for touch screens, which have no scroll wheel. */
  private movePinch() {
    const pin = this.pinch!;
    const [[ax, ay], [bx, by]] = [...this.touches.values()];
    const r = this.svg.getBoundingClientRect();
    const mx = (ax + bx) / 2 - r.left;
    const my = (ay + by) / 2 - r.top;
    const k = Math.min(20, Math.max(0.05, (pin.view.k * Math.hypot(bx - ax, by - ay)) / pin.dist));
    // Keep the plan point that was under the fingers' midpoint under it now.
    const wx = (pin.mx - pin.view.x) / pin.view.k;
    const wy = (pin.my - pin.view.y) / pin.view.k;
    this.view = { k, x: mx - wx * k, y: my - wy * k };
    this.render();
  }

  private onMove(e: PointerEvent) {
    if (this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.pinch && this.touches.size >= 2) {
        this.movePinch();
        return;
      }
    }
    const p = this.toWorld(e);
    this.pointer = p;
    const d = this.drag;
    if (!d) {
      if (this.linkFrom || this.wallDraft.length || this.calib.length === 1) this.renderOverlay();
      return;
    }
    if (d.kind === 'pan') {
      this.view.x = d.vx + e.clientX - d.cx;
      this.view.y = d.vy + e.clientY - d.cy;
      this.applyView();
      return;
    }
    const b = this.block(d.id);
    if (!b) return;
    if (d.kind === 'move') {
      this.store.live(() => {
        b.x = Math.round(d.startX + p[0] - d.px);
        b.y = Math.round(d.startY + p[1] - d.py);
      });
    } else if (d.kind === 'resize') {
      // Distance from the center, measured along the block's own (rotated) axes.
      const r = ((b.rotation ?? 0) * Math.PI) / 180;
      const dx = p[0] - b.x;
      const dy = p[1] - b.y;
      const lx = dx * Math.cos(r) + dy * Math.sin(r);
      const ly = -dx * Math.sin(r) + dy * Math.cos(r);
      const mpp = metersPerPixel(this.store.model);
      this.store.live(() => {
        b.w = f(Math.max(MIN_SIZE_M, 2 * Math.abs(lx) * mpp));
        b.h = f(Math.max(MIN_SIZE_M, 2 * Math.abs(ly) * mpp));
      });
    } else if (d.kind === 'rotate') {
      let deg = (Math.atan2(p[1] - b.y, p[0] - b.x) * 180) / Math.PI + 90;
      deg = d.snap ? Math.round(deg / 15) * 15 : Math.round(deg);
      deg = ((deg % 360) + 360) % 360;
      this.store.live(() => {
        b.rotation = deg;
      });
    }
  }

  private onUp(e: PointerEvent) {
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.pinch = null;
    if (!this.drag) return;
    if (this.drag.kind !== 'pan') this.store.endGesture();
    this.drag = null;
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = this.svg.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k = Math.min(20, Math.max(0.05, this.view.k * Math.exp(-e.deltaY * 0.0015)));
    // Keep the point under the cursor fixed.
    this.view.x = mx - ((mx - this.view.x) * k) / this.view.k;
    this.view.y = my - ((my - this.view.y) * k) / this.view.k;
    this.view.k = k;
    this.render();
  }

  /** FR-04: blocks dragged in from the palette. */
  private onDrop(e: DragEvent) {
    e.preventDefault();
    const type = e.dataTransfer?.getData('application/x-block-type') as BlockType | '';
    if (!type || !(type in BLOCK_STYLES)) return;
    this.dropAt(type, e.clientX, e.clientY);
  }

  /** True when a screen point is over the plan, so a dragged palette block may land there. */
  containsPoint(clientX: number, clientY: number): boolean {
    const r = this.svg.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  /** Adds a block of `type` at a screen point (mouse drop or touch drag from the palette). */
  dropAt(type: BlockType, clientX: number, clientY: number) {
    const [x, y] = this.toWorld({ clientX, clientY });
    let id = '';
    this.store.commit((m) => {
      const b = newBlock(m, type, x, y);
      id = b.id;
      m.blocks.push(b);
    });
    this.store.select({ kind: 'block', id });
    this.setTool('select');
  }

  /** Adds a block at the middle of the current view (keyboard / click alternative to dragging). */
  addAtCenter(type: BlockType) {
    const r = this.svg.getBoundingClientRect();
    const [x, y] = this.toWorld({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
    let id = '';
    this.store.commit((m) => {
      const b = newBlock(m, type, x, y);
      id = b.id;
      m.blocks.push(b);
    });
    this.store.select({ kind: 'block', id });
  }

  private finishWall() {
    const pts = this.wallDraft;
    this.wallDraft = [];
    if (pts.length >= 2) {
      this.store.commit((m) => {
        m.walls = [...(m.walls ?? []), pts];
      });
      this.hooks.message('Wall added. Click to start another, or press Esc.');
    }
    this.render();
  }

  // ---- drawing ----

  private applyPlanLook() {
    this.image.style.display = this.imageHref && this.planShown ? '' : 'none';
    this.image.style.opacity = String(this.planOpacity / 100);
  }

  private applyView() {
    this.world.setAttribute('transform', `translate(${this.view.x} ${this.view.y}) scale(${this.view.k})`);
    for (const fn of this.viewListeners) fn();
  }

  /** Current pan and zoom: screen = world × k + (x, y), in CSS pixels relative to the plan's box. */
  getView() {
    return { ...this.view };
  }

  onViewChange(fn: () => void) {
    this.viewListeners.add(fn);
  }

  render() {
    const m = this.displayModel();
    const proposal = this.viewing === 'proposal';
    const { width, height } = planExtent(m);
    for (const el of [this.svg.querySelector('.plan-bg')!, this.image, this.grid]) {
      el.setAttribute('width', String(width));
      el.setAttribute('height', String(height));
    }
    const href = m.background?.file.startsWith('data:') ? m.background.file : '';
    if (href !== this.imageHref) {
      this.imageHref = href;
      this.image.setAttribute('href', href);
    }
    this.grid.style.display = href ? 'none' : '';
    this.planControls.hidden = !href;
    this.applyPlanLook();
    this.applyView();

    const k = this.view.k;
    const sel = proposal ? null : this.store.selection;
    const byId = new Map(m.blocks.map((b) => [b.id, b]));
    const routes = proposal && this.previewRoutes ? this.previewRoutes : this.routes;
    const parts: string[] = [];

    (m.walls ?? []).forEach((w, i) => {
      const pts = w.map(([x, y]) => `${x},${y}`).join(' ');
      const on = sel?.kind === 'wall' && sel.index === i;
      parts.push(`<g data-wall="${i}"><polyline class="wall-hit" points="${pts}" style="stroke-width:${12 / k}"/>
        <polyline class="wall${on ? ' selected' : ''}" points="${pts}"/></g>`);
    });

    // Walking paths first, so links draw on top of them. Width shows how many people use each one.
    const maxFlow = Math.max(0, ...this.routeFlows.values());
    for (const l of m.links) {
      const key = routeKey(l.from, l.to);
      const r = routes.get(key);
      if (!r || r.meters === 0) continue;
      const flow = this.routeFlows.get(key) ?? 0;
      const width = maxFlow > 0 ? 2 + 10 * (flow / maxFlow) : 3;
      parts.push(`<polyline class="route${r.noPath ? ' no-path' : ''}" style="stroke-width:${width.toFixed(1)}" points="${r.points.map(([x, y]) => `${x},${y}`).join(' ')}"><title>${Math.round(flow)} people/h walk ${r.meters.toFixed(1)} m</title></polyline>`);
    }

    m.links.forEach((l, i) => {
      const a = byId.get(l.from);
      const b = byId.get(l.to);
      if (!a || !b) return;
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const ra = this.edgeDistance(a, ux, uy);
      const rb = this.edgeDistance(b, -ux, -uy) + 3 / k;
      const x1 = a.x + ux * ra;
      const y1 = a.y + uy * ra;
      const x2 = b.x - ux * rb;
      const y2 = b.y - uy * rb;
      const on = sel?.kind === 'link' && sel.index === i;
      const label = a.type === 'decision'
        ? `<text class="link-label" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6 / k}" style="font-size:${12 / k}px">${l.prob === undefined ? '?' : Math.round(l.prob * 1000) / 10 + '%'}</text>`
        : '';
      parts.push(`<g data-link="${i}"><line class="link-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="stroke-width:${12 / k}"/>
        <line class="link${on ? ' selected' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#arrow)"/>${label}</g>`);
    });

    // In the proposal view, blocks that moved are marked so the change is easy to spot.
    const movedIds = new Set(proposal ? this.preview.map((p) => p.id) : []);
    for (const b of m.blocks) {
      parts.push(this.blockSvg(b, k, sel?.kind === 'block' && sel.id === b.id).replace(
        'class="block"', movedIds.has(b.id) ? 'class="block moved"' : 'class="block"'));
    }
    this.content.innerHTML = parts.join('');
    this.renderOverlay();
  }

  /** Half the height of a block's rotated bounding box, for placing its label below it. */
  private halfHeight(b: Block, w: number, h: number): number {
    const r = ((b.rotation ?? 0) * Math.PI) / 180;
    return (Math.abs(w * Math.sin(r)) + Math.abs(h * Math.cos(r))) / 2;
  }

  /** Distance from a block's center to its outline along the unit direction (ux, uy). */
  private edgeDistance(b: Block, ux: number, uy: number): number {
    const { w, h } = footprintPx(this.store.model, b);
    const r = ((b.rotation ?? 0) * Math.PI) / 180;
    // Direction in the block's own frame.
    const lx = Math.abs(ux * Math.cos(r) + uy * Math.sin(r));
    const ly = Math.abs(-ux * Math.sin(r) + uy * Math.cos(r));
    switch (BLOCK_STYLES[b.type].shape) {
      case 'circle':
        return 1 / Math.sqrt((lx / (w / 2)) ** 2 + (ly / (h / 2)) ** 2);
      case 'diamond':
        return 1 / (lx / (w / 2) + ly / (h / 2));
      default:
        return Math.min(lx > 1e-9 ? w / 2 / lx : Infinity, ly > 1e-9 ? h / 2 / ly : Infinity);
    }
  }

  private blockSvg(b: Block, k: number, selected: boolean): string {
    const m = this.store.model;
    const s = BLOCK_STYLES[b.type];
    const { w, h } = footprintPx(m, b);
    const cls = `shape${this.flagged.has(b.id) ? ' flagged' : ''}${this.linkFrom === b.id ? ' link-from' : ''}`;
    let shape: string;
    switch (s.shape) {
      case 'circle':
        shape = `<ellipse class="${cls}" rx="${w / 2}" ry="${h / 2}"/>`;
        break;
      case 'diamond':
        shape = `<polygon class="${cls}" points="0,${-h / 2} ${w / 2},0 0,${h / 2} ${-w / 2},0"/>`;
        break;
      case 'line':
        shape = `<rect class="${cls} dashed" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${Math.min(w, h) / 2}"/>`;
        break;
      default:
        shape = `<rect class="${cls}" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${2 / k}"/>`;
    }
    const extra = b.type === 'server' ? ` ×${b.servers}` : b.type === 'resource' ? ` ×${b.count}` : '';
    const ai = b.origin === 'ai' ? ` <tspan class="ai">AI</tspan>` : '';
    const handles = selected
      ? `<rect class="sel-outline" x="${-w / 2 - 4 / k}" y="${-h / 2 - 4 / k}" width="${w + 8 / k}" height="${h + 8 / k}"/>
         <line class="sel-outline" x1="0" y1="${-h / 2 - 4 / k}" x2="0" y2="${-h / 2 - 22 / k}"/>
         <circle class="handle" data-handle="rotate" data-id="${esc(b.id)}" cx="0" cy="${-h / 2 - 22 / k}" r="${6 / k}"/>
         <rect class="handle" data-handle="resize" data-id="${esc(b.id)}" x="${w / 2 - 2 / k}" y="${h / 2 - 2 / k}" width="${10 / k}" height="${10 / k}"/>`
      : '';
    return `<g class="block" data-block="${esc(b.id)}" style="--c:${s.color}">
      <g transform="translate(${b.x} ${b.y}) rotate(${b.rotation ?? 0})">${shape}${handles}</g>
      <text class="block-label" x="${b.x}" y="${b.y + this.halfHeight(b, w, h) + 14 / k}" style="font-size:${12 / k}px">${esc(b.label || b.id)}${extra}${ai}</text>
    </g>`;
  }

  private renderOverlay() {
    const k = this.view.k;
    const parts: string[] = [];
    const p = this.pointer;
    if (this.linkFrom && p) {
      const a = this.block(this.linkFrom);
      if (a) parts.push(`<line class="draft" x1="${a.x}" y1="${a.y}" x2="${p[0]}" y2="${p[1]}" marker-end="url(#arrow)"/>`);
    }
    if (this.wallDraft.length) {
      const pts = [...this.wallDraft, ...(p ? [p] : [])].map(([x, y]) => `${x},${y}`).join(' ');
      parts.push(`<polyline class="wall draft-wall" points="${pts}"/>`);
    }
    if (this.calib.length) {
      const pts = this.calib.length === 1 && p ? [...this.calib, p] : this.calib;
      if (pts.length === 2) {
        parts.push(`<line class="calib" x1="${pts[0][0]}" y1="${pts[0][1]}" x2="${pts[1][0]}" y2="${pts[1][1]}"/>`);
      }
      for (const [x, y] of this.calib) parts.push(`<circle class="calib-pt" cx="${x}" cy="${y}" r="${5 / k}"/>`);
    }
    this.overlay.innerHTML = parts.join('');
  }
}
