/**
 * Hero animation: a tiny live queue. People walk in, join the line, move up as it
 * shortens, take a free teller, get served and walk out. Positions are updated every
 * frame, so nothing jumps back to a start point the way a looping animation does.
 */
type P = [number, number];
type Phase = 'in' | 'wait' | 'to-teller' | 'serve' | 'out';
interface Person { el: SVGCircleElement; x: number; y: number; phase: Phase; route: P[]; timer: number; teller: number; age: number }

const NS = 'http://www.w3.org/2000/svg';
const svg = document.querySelector<SVGSVGElement>('.hero-art > svg');
const layer = svg?.querySelector<SVGGElement>('#h-people');

const ENTRANCE: P = [56, 170];
const SLOT_FRONT = 268; // x of the first place in line
const SLOT_GAP = 20;
const MAX_LINE = 7;
const TELLERS: P[] = [[370, 118], [400, 118], [430, 118]];
// People walk in along one lane and out along another, so they never pass through someone being served.
const LANE_IN = 104;
const LANE_OUT = 134;
const SPEED = 70; // walking speed, drawing units per second
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function samplePath(id: string): P[] {
  const p = svg!.querySelector<SVGPathElement>(`#${id}`)!;
  const len = p.getTotalLength();
  const n = Math.ceil(len / 4);
  return Array.from({ length: n + 1 }, (_, i) => {
    const q = p.getPointAtLength((len * i) / n);
    return [q.x, q.y] as P;
  });
}

if (svg && layer) {
  const toTeller = samplePath('hp-teller');
  const toExit = samplePath('hp-exit');
  const line: Person[] = [];
  const people = new Set<Person>();
  const busy = [false, false, false];
  let nextArrival = 1;

  const add = (x: number, y: number, phase: Phase): Person => {
    const el = document.createElementNS(NS, 'circle');
    el.setAttribute('r', '6');
    const p: Person = { el, x, y, phase, route: [], timer: 0, teller: -1, age: phase === 'in' ? 0 : 1 };
    layer.appendChild(el);
    people.add(p);
    return p;
  };
  const startServing = (p: Person, t: number) => {
    busy[t] = true;
    p.teller = t;
    p.phase = 'serve';
    p.timer = rand(3.5, 5.5);
  };

  // Start mid-day: everyone busy and a few people waiting.
  TELLERS.forEach(([x, y], t) => startServing(add(x, y, 'serve'), t));
  for (let i = 0; i < 4; i++) line.push(add(SLOT_FRONT - i * SLOT_GAP, 170, 'wait'));

  /** Moves p along its route; returns true when it arrives. */
  const walk = (p: Person, dist: number) => {
    while (dist > 0 && p.route.length) {
      const [tx, ty] = p.route[0];
      const d = Math.hypot(tx - p.x, ty - p.y);
      if (d <= dist) {
        p.x = tx; p.y = ty; dist -= d;
        p.route.shift();
      } else {
        p.x += ((tx - p.x) / d) * dist; p.y += ((ty - p.y) / d) * dist;
        dist = 0;
      }
    }
    return p.route.length === 0;
  };

  const step = (dt: number) => {
    nextArrival -= dt;
    if (nextArrival <= 0 && line.length < MAX_LINE) {
      line.push(add(ENTRANCE[0], ENTRANCE[1], 'in'));
      nextArrival = rand(1.5, 2.5);
    }
    // The line: everyone eases toward their place, which moves up as people leave the front.
    line.forEach((p, i) => {
      const target = SLOT_FRONT - i * SLOT_GAP;
      const gap = target - p.x;
      p.x += Math.sign(gap) * Math.min(Math.abs(gap), SPEED * dt);
      if (p.phase === 'in' && Math.abs(gap) < 0.5) p.phase = 'wait';
    });
    const front = line[0];
    const free = busy.indexOf(false);
    if (front && front.phase === 'wait' && free >= 0) {
      line.shift();
      busy[free] = true;
      front.teller = free;
      front.phase = 'to-teller';
      front.route = [...toTeller, [TELLERS[free][0], LANE_IN], TELLERS[free]];
    }
    for (const p of people) {
      p.age += dt;
      if (p.phase === 'to-teller' && walk(p, SPEED * dt)) startServing(p, p.teller);
      else if (p.phase === 'serve' && (p.timer -= dt) <= 0) {
        busy[p.teller] = false;
        p.phase = 'out';
        p.route = [[p.x, LANE_OUT], ...toExit, [476, 170]];
      } else if (p.phase === 'out' && walk(p, SPEED * dt)) {
        p.el.remove();
        people.delete(p);
      }
    }
  };

  const draw = () => {
    for (const p of people) {
      p.el.setAttribute('cx', p.x.toFixed(1));
      p.el.setAttribute('cy', p.y.toFixed(1));
      p.el.setAttribute('class', `h-person ${p.phase === 'wait' ? 'wait' : p.phase === 'serve' ? 'serve' : ''}`);
      // Fade in at the entrance and out near the exit.
      const left = p.phase === 'out' ? p.route.length * 4 : Infinity;
      p.el.setAttribute('opacity', Math.min(1, p.age / 0.5, left / 30).toFixed(2));
    }
  };

  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = true;
  let last = 0;
  let raf = 0;
  const frame = (now: number) => {
    step(Math.min(0.05, (now - last) / 1000 || 0));
    last = now;
    draw();
    raf = requestAnimationFrame(frame);
  };
  const sync = () => {
    cancelAnimationFrame(raf);
    if (visible && !still.matches && !document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  draw();
  still.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  // Stop working when the hero is scrolled out of view.
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    sync();
  }).observe(svg);
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
