// Deterministic, id-seeded "mess". The whole point: the layout looks feral but is
// STABLE across renders (it's a hash, not Math.random), so it never reflows or jumps.
// Pure — safe on server (inline styles) and client.

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rng(seed: string): () => number {
  return mulberry32(hashStr(seed));
}

export interface Jitter {
  rotate: number;
  dx: number;
  dy: number;
  skew: number;
}

// Per-cell jitter for the browse grid. Small but visible.
export function cellJitter(seed: string): Jitter {
  const r = rng(seed + ':cell');
  return {
    rotate: (r() * 2 - 1) * 2.4,
    dx: (r() * 2 - 1) * 6,
    dy: (r() * 2 - 1) * 6,
    skew: (r() * 2 - 1) * 1.1,
  };
}

// Tiny per-number jitter — for stats/ids/timestamps. The numbers wobble.
export function numJitter(seed: string): Jitter {
  const r = rng(seed + ':num');
  return {
    rotate: (r() * 2 - 1) * 5,
    dx: (r() * 2 - 1) * 1.5,
    dy: (r() * 2 - 1) * 2.5,
    skew: 0,
  };
}

export function jitterStyle(j: Jitter): string {
  return `display:inline-block;transform:rotate(${j.rotate.toFixed(2)}deg) translate(${j.dx.toFixed(1)}px,${j.dy.toFixed(1)}px) skew(${j.skew.toFixed(2)}deg);`;
}

// Convenience: a wobbly inline style straight from a seed.
export function wob(seed: string): string {
  return jitterStyle(numJitter(seed));
}
