// Binary min-heap keyed on (time, insertion order), so ties resolve the same way every run.

interface Item<T> {
  t: number;
  seq: number;
  value: T;
}

export class EventQueue<T> {
  private items: Item<T>[] = [];
  private seq = 0;

  get size(): number {
    return this.items.length;
  }

  push(t: number, value: T): void {
    const items = this.items;
    items.push({ t, seq: this.seq++, value });
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(items[i], items[p])) break;
      [items[i], items[p]] = [items[p], items[i]];
      i = p;
    }
  }

  pop(): { t: number; value: T } | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.less(items[l], items[m])) m = l;
        if (r < items.length && this.less(items[r], items[m])) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m], items[i]];
        i = m;
      }
    }
    return { t: top.t, value: top.value };
  }

  private less(a: Item<T>, b: Item<T>): boolean {
    return a.t < b.t || (a.t === b.t && a.seq < b.seq);
  }
}
