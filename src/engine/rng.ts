// Seeded random numbers: sfc32 seeded through splitmix32, so a seed and
// replication index always give the same stream (FR-18).

function splitmix32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
}

export function createRng(seed: number, stream = 0): Rng {
  const mix = splitmix32((seed ^ Math.imul(stream + 1, 0x27d4eb2f)) >>> 0);
  let a = mix();
  let b = mix();
  let c = mix();
  let d = mix();
  const next = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t / 4294967296;
  };
  // Discard the first outputs so nearby seeds diverge.
  for (let i = 0; i < 12; i++) next();
  return { next };
}
