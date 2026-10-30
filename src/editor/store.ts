import type { ModelSpec } from '../model/types';

export type Selection =
  | { kind: 'block'; id: string }
  | { kind: 'link'; index: number }
  | { kind: 'wall'; index: number }
  | null;

const HISTORY_LIMIT = 200;

/**
 * Deep copy that shares strings, so a large plan image (a data URL) is never
 * duplicated per undo step.
 */
function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = clone(x);
    return out as T;
  }
  return v;
}

/** The model being edited, the selection, and undo/redo history (FR-09). */
export class Store {
  model: ModelSpec;
  selection: Selection = null;
  /** Goes up on every change to the model itself (not on selection changes). */
  version = 0;
  private past: ModelSpec[] = [];
  private future: ModelSpec[] = [];
  private gesture: ModelSpec | null = null;
  private gestureChanged = false;
  private listeners = new Set<() => void>();

  constructor(model: ModelSpec) {
    this.model = clone(model);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(modelChanged = true) {
    if (modelChanged) this.version++;
    for (const fn of this.listeners) fn();
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  private pushPast(snapshot: ModelSpec) {
    this.past.push(snapshot);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  /** One undoable change. */
  commit(change: (m: ModelSpec) => void) {
    this.pushPast(clone(this.model));
    change(this.model);
    this.emit();
  }

  /** Replaces the whole model as one undoable step (template, file load, JSON edit). */
  replace(model: ModelSpec) {
    this.pushPast(this.model);
    this.model = clone(model);
    this.selection = null;
    this.emit();
  }

  /** A drag: many live updates that undo as one step. */
  beginGesture() {
    this.gesture = clone(this.model);
    this.gestureChanged = false;
  }

  live(change: (m: ModelSpec) => void) {
    change(this.model);
    this.gestureChanged = true;
    this.emit();
  }

  endGesture() {
    if (this.gesture && this.gestureChanged) this.pushPast(this.gesture);
    this.gesture = null;
  }

  select(sel: Selection) {
    this.selection = sel;
    this.emit(false);
  }

  undo() {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.model);
    this.model = prev;
    this.fixSelection();
    this.emit();
  }

  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.model);
    this.model = next;
    this.fixSelection();
    this.emit();
  }

  private fixSelection() {
    const s = this.selection;
    if (
      (s?.kind === 'block' && !this.model.blocks.some((b) => b.id === s.id)) ||
      (s?.kind === 'link' && s.index >= this.model.links.length) ||
      (s?.kind === 'wall' && s.index >= (this.model.walls?.length ?? 0))
    ) {
      this.selection = null;
    }
  }
}
