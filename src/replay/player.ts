// FR-20, FR-21: animated replay over the floor plan with play, pause, speed and a scrubbable timeline.
import type { PlanCanvas } from '../editor/canvas';
import type { LogEvent } from '../engine/simulator';
import { DEFAULT_METERS_PER_PIXEL, type ModelSpec } from '../model/types';
import type { Route } from '../routing/pathfinder';
import { Replay, type Dot, type DotState } from './replay';

const PLAY_ICON = '<svg class="i" aria-hidden="true"><use href="#i-play"/></svg>';
const PAUSE_ICON = '<svg class="i" aria-hidden="true"><use href="#i-pause"/></svg>';
const SPEEDS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
const DEFAULT_SPEED = 100;
/** Dot radius, meters, with a floor in screen pixels so dots stay visible when zoomed out. */
const DOT_M = 0.3;
const MIN_DOT_PX = 3;

function clock(min: number): string {
  const total = Math.max(0, Math.round(min * 60));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export class Player {
  private canvas: HTMLCanvasElement;
  private bar: HTMLElement;
  private replay: Replay | null = null;
  private t = 0;
  private playing = false;
  private speed = DEFAULT_SPEED;
  private lastFrame = 0;
  private warmup = 0;
  private mpp = DEFAULT_METERS_PER_PIXEL;
  private entity = 'entity';
  private colors: Record<DotState, string> = { move: '', wait: '', service: '', stay: '', balk: '' };
  private els: {
    play: HTMLButtonElement; speed: HTMLSelectElement; range: HTMLInputElement;
    time: HTMLElement; counts: HTMLElement; stale: HTMLElement;
  };

  constructor(host: HTMLElement, private plan: PlanCanvas) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'replay-layer';
    this.canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(this.canvas);

    this.bar = document.createElement('div');
    this.bar.className = 'replay-bar';
    this.bar.hidden = true;
    this.bar.innerHTML = `
      <button type="button" class="play icon-only" aria-label="Play">${PLAY_ICON}</button>
      <label class="inline">Speed
        <select class="speed">${SPEEDS.map((s) => `<option value="${s}" ${s === DEFAULT_SPEED ? 'selected' : ''}>${s}×</option>`).join('')}</select>
      </label>
      <input type="range" class="timeline" min="0" max="1" step="any" value="0" aria-label="Replay time">
      <span class="time" aria-live="off"></span>
      <span class="counts"></span>
      <span class="legend">
        <span><i style="background:var(--dot-move)"></i>Walking</span>
        <span><i style="background:var(--dot-wait)"></i>Waiting</span>
        <span><i style="background:var(--dot-service)"></i>Being served</span>
        <span><i style="background:var(--dot-stay)"></i>In a delay</span>
        <span><i style="background:var(--dot-balk)"></i>Left (line full)</span>
      </span>
      <span class="stale badge warn" hidden>Model changed since this run</span>
      <button type="button" class="close icon-only" aria-label="Hide replay" title="Hide replay"><svg class="i" aria-hidden="true"><use href="#i-x"/></svg></button>`;
    host.appendChild(this.bar);
    const q = <T extends HTMLElement>(s: string) => this.bar.querySelector(s) as T;
    this.els = {
      play: q('.play'), speed: q('.speed'), range: q('.timeline'),
      time: q('.time'), counts: q('.counts'), stale: q('.stale'),
    };

    this.els.play.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    this.els.speed.addEventListener('change', () => { this.speed = Number(this.els.speed.value); });
    this.els.range.addEventListener('input', () => {
      this.t = Number(this.els.range.value);
      this.draw();
    });
    q('.close').addEventListener('click', () => this.hide());
    plan.onViewChange(() => this.draw());
    new ResizeObserver(() => this.draw()).observe(host);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.readColors());
    this.readColors();
  }

  private readColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    this.colors = { move: v('--dot-move'), wait: v('--dot-wait'), service: v('--dot-service'), stay: v('--dot-stay'), balk: v('--dot-balk') };
    this.draw();
  }

  get loaded() {
    return this.replay !== null;
  }

  /** Everyone's position at the moment the replay shows, or null before a run. */
  currentFrame(): { t: number; dots: Dot[]; stale: boolean } | null {
    if (!this.replay) return null;
    return { t: this.t, dots: this.replay.at(this.t).dots, stale: !this.els.stale.hidden };
  }

  /** "6:18:21" for a time in minutes. */
  static clock(min: number): string {
    return clock(min);
  }

  load(log: LogEvent[], model: ModelSpec, routes: Map<string, Route>, end: number) {
    this.replay = new Replay(log, model, routes, end);
    this.warmup = model.run.warmupMin;
    this.mpp = model.background?.metersPerPixel ?? DEFAULT_METERS_PER_PIXEL;
    this.entity = model.entityLabel;
    this.t = 0;
    this.els.range.max = String(end);
    this.els.range.value = '0';
    this.els.stale.hidden = true;
    this.bar.hidden = false;
    this.canvas.hidden = false;
    this.play();
  }

  /** Shown when the model is edited after the run: the replay still shows the old layout. */
  markStale() {
    if (this.replay) this.els.stale.hidden = false;
  }

  hide() {
    this.pause();
    this.bar.hidden = true;
    this.canvas.hidden = true;
  }

  play() {
    if (!this.replay) return;
    if (this.t >= this.replay.end) this.t = 0;
    this.playing = true;
    this.els.play.innerHTML = PAUSE_ICON;
    this.els.play.setAttribute('aria-label', 'Pause');
    this.lastFrame = performance.now();
    requestAnimationFrame((now) => this.tick(now));
  }

  pause() {
    this.playing = false;
    this.els.play.innerHTML = PLAY_ICON;
    this.els.play.setAttribute('aria-label', 'Play');
  }

  private tick(now: number) {
    if (!this.playing || !this.replay) return;
    // 1× is real time: one second on screen is one second (1/60 minute) of simulated time.
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.t = Math.min(this.replay.end, this.t + (dt * this.speed) / 60);
    this.draw();
    if (this.t >= this.replay.end) {
      this.pause();
      return;
    }
    requestAnimationFrame((n) => this.tick(n));
  }

  private draw() {
    const r = this.replay;
    const host = this.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!r || this.canvas.hidden) return;

    const frame = r.at(this.t);
    const view = this.plan.getView();
    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
    const radius = Math.max(DOT_M / this.mpp, MIN_DOT_PX / view.k);
    for (const d of frame.dots) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.state === 'balk' ? radius * 1.3 : radius, 0, Math.PI * 2);
      ctx.fillStyle = this.colors[d.state];
      ctx.fill();
    }

    this.els.range.value = String(this.t);
    this.els.time.textContent = `${clock(this.t)} / ${clock(r.end)}${this.t < this.warmup ? ' (warm-up)' : ''}`;
    this.els.counts.textContent = `${frame.inSystem} ${this.entity}s in system · ${frame.waiting} waiting · ${frame.inService} in service`;
  }
}
