// Generic per-shader motion for the "drift" / "expressive" export modes. There is no authored
// per-shader animation data for the general corpus (the launch-carousel hand-tuned curves in
// marketing/_export-takes.mjs don't generalize — they were tuned per shader by eye), so this
// synthesizes curves from the shader's own float INPUT metadata instead: pick a handful of knobs,
// give each one a motion "archetype" driven by the export's roll seed, and clamp to MIN/MAX.
//
// Design goals (2026-07-23 rework):
//   - MORE ALIVE than a single pure sine per knob (that read mechanical/flat). Each knob draws one of
//     four archetypes — oscillate (sine + harmonic), wander (summed low freqs), sweep (one directional
//     hump), pulse (occasional Gaussian bumps) — so a clip mixes continuous motion with the odd accent
//     instead of everything oscillating in lockstep.
//   - GACHA: every field below (knob count, which knobs, each knob's archetype, amplitude, frequency,
//     phase) is derived from `seed`. The CALLER now passes a fresh per-export roll token (not the shader
//     id), so re-exporting rolls a different clip. Determinism is preserved *given a seed* — same token
//     reproduces the exact motion — which is what makes a roll shareable/pinnable.
//   - NOT CHAOTIC: knob count is capped, motion is phase-staggered so peaks don't align, amplitudes and
//     frequencies are drawn from bands, and at least one knob is guaranteed continuous so no roll comes
//     up nearly-static.
//   - LOOP-SAFE: every archetype closes the loop (value at u=0 equals value at u=1 — integer LFO cycles,
//     endpoints pinned to base for sweep, periodic-distance Gaussians for pulse) so a looping GIF/clip
//     has no seam pop.
//
// Feedback/sim shaders are the hazard: a reaction-diffusion-style shader's feed/kill/trail/speed params
// are tuned to a narrow stable band, and animating them can blow the simulation up (this is exactly why
// the hand-tuned carousel takes hard-exclude those knobs on feedback shaders — see AUTOMATIONS comments
// in _export-takes.mjs). SIM_PARAM_PATTERN is the same idea, applied by name since a generic generator
// has no per-shader knowledge of which knobs feed a simulation.
//
// TIME/SPEED knobs are a second hazard, for a different reason: a shader that exposes its own time or
// speed control already drives its animation from that knob, so *sweeping* it with an LFO fights the
// clip's own timeline and looks bad (Kyle, 2026-07-23, from live testing). We don't animate those — but
// we do give each one a deterministic random CONSTANT within its range (varying per roll), so different
// rolls start at a different phase/speed for variety, without any per-frame motion on them.
import type { ISFInput } from './types';

export type MotionMode = 'drift' | 'expressive';

const TAU = Math.PI * 2;

const SIM_PARAM_PATTERN = /feed|kill|trail|tracelife|simspeed|diffus|decay|viscos|reaction/i;
// Checked AFTER SIM_PARAM_PATTERN — a name like `simSpeed` matches both, and sim-precedence (leave it
// at base entirely) is the safer call than handing it a random constant.
const TIME_SPEED_PATTERN = /time|speed/i;

// Knobs animated per clip: rolled within [min,max] (the jitter is part of the gacha). MAX stays the
// documented ceiling so a clip never turns busy; MIN keeps drift from coming up nearly-static.
const KNOB_RANGE: Record<MotionMode, [min: number, max: number]> = { drift: [2, 5], expressive: [4, 7] };
// Per-knob amplitude BASE as a fraction of the knob's [MIN,MAX] range; the per-knob tier (below) scales
// it. Bumped 2026-07-23 — the old bands read as barely-perceptible on expressive (Kyle, live testing).
const AMP_BASE: Record<MotionMode, number> = { drift: 0.16, expressive: 0.42 };
// Integer LFO cycles over the clip → the loop closes cleanly (u=0 matches u=1, no GIF seam pop). Kept
// low so motion stays calm; expressive gets a couple more for livelier movement over longer clips.
const CYCLE_CHOICES: Record<MotionMode, number[]> = { drift: [1, 2], expressive: [1, 2, 3, 4] };

type Archetype = 'oscillate' | 'wander' | 'sweep' | 'pulse';
// oscillate/wander never fully rest — used to guarantee at least one knob is always in motion.
const CONTINUOUS: Archetype[] = ['oscillate', 'wander'];
// Weighted archetype tables per mode. drift favors calm continuous motion; expressive leans into
// directional sweeps and pulsed accents for a livelier read.
const ARCHETYPE_WEIGHTS: Record<MotionMode, Record<Archetype, number>> = {
  drift: { oscillate: 5, wander: 4, sweep: 2, pulse: 1 },
  expressive: { oscillate: 3, wander: 2, sweep: 4, pulse: 3 },
};

// FNV-1a — deterministic, no Math.random (motion must be reproducible from a roll token across
// exports/tests). Returns a float in [0,1).
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function pickInt(h: number, choices: number[]): number {
  return choices[Math.min(choices.length - 1, Math.floor(h * choices.length))];
}

function pickWeighted<T extends string>(h: number, weights: Record<T, number>): T {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = h * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r < 0) return k;
  }
  return entries[entries.length - 1][0];
}

interface KnobCurve {
  name: string;
  center: number;
  min: number;
  max: number;
  arch: Archetype;
  // Displacement from center in [-amp, amp]-ish, guaranteed equal at u=0 and u=1 (loop-safe).
  disp: (u: number) => number;
}

// Circular distance on the unit loop — |u-c| wrapped, so a Gaussian built on it is exactly periodic
// (f(0) === f(1)), which is what keeps the pulse archetype seam-free.
function circDist(u: number, c: number): number {
  const d = Math.abs(u - c);
  return Math.min(d, 1 - d);
}

// Build the per-knob displacement function for a rolled archetype. `h(salt)` yields an independent
// deterministic stream for this knob so every parameter is its own dice throw.
function buildDisp(
  arch: Archetype,
  amp: number,
  phase: number,
  cycles: number[],
  h: (salt: string) => number,
): (u: number) => number {
  switch (arch) {
    case 'oscillate': {
      // Fundamental + a weaker integer harmonic → organic wobble instead of a pure tone. Both terms are
      // integer-cycle sines, so the sum still closes the loop. Normalized to stay within ±amp.
      const k = pickInt(h('cyc'), cycles);
      const harm = h('harmpick') < 0.5 ? 2 : 3;
      const a2 = 0.3 + 0.3 * h('harmamp'); // 0.3–0.6
      const p2 = h('harmphase') * TAU;
      const norm = 1 / (1 + a2);
      return (u) => amp * norm * (Math.sin(TAU * k * u + phase) + a2 * Math.sin(TAU * harm * k * u + p2));
    }
    case 'wander': {
      // 2–3 low-frequency sines at distinct integer rates with descending weight → a slow meander that
      // doesn't read as one obvious cycle. Integer rates keep it loop-safe.
      const n = h('wn') < 0.5 ? 2 : 3;
      const freqs: number[] = [];
      const phases: number[] = [];
      const weights: number[] = [];
      let total = 0;
      for (let i = 0; i < n; i++) {
        freqs.push(pickInt(h('wf' + i), cycles));
        phases.push(h('wp' + i) * TAU);
        const w = 1 / (i + 1);
        weights.push(w);
        total += w;
      }
      return (u) => {
        let s = 0;
        for (let i = 0; i < n; i++) s += weights[i] * Math.sin(TAU * freqs[i] * u + phases[i]);
        return (amp * s) / total;
      };
    }
    case 'sweep': {
      // One smooth directional hump: eases out to a signed offset and settles back, zero at both ends.
      // The clearest contrast to the oscillators — reads as an intentional move, not a wobble.
      const dir = h('dir') < 0.5 ? 1 : -1;
      const skew = 0.7 + 0.6 * h('skew'); // 0.7–1.3, shifts where the peak lands
      return (u) => dir * amp * Math.pow(Math.sin(Math.PI * u), skew);
    }
    case 'pulse': {
      // Mostly rests at base, with 1–2 Gaussian bumps → accents/events rather than constant motion.
      // Periodic-distance Gaussians are exactly loop-safe; the sum is bounded to ±1 before scaling.
      const nb = h('pn') < 0.4 ? 1 : 2;
      const w = 0.05 + 0.05 * h('pw'); // bump width
      const bumps = Array.from({ length: nb }, (_, i) => ({
        c: 0.2 + 0.6 * h('pc' + i), // interior center, away from the seam
        dir: h('pd' + i) < 0.5 ? 1 : -1,
      }));
      return (u) => {
        let s = 0;
        for (const b of bumps) {
          const d = circDist(u, b.c) / w;
          s += b.dir * Math.exp(-d * d);
        }
        return amp * clamp(s, -1, 1);
      };
    }
  }
}

/**
 * Build a deterministic automate(frameIndex, u) function that animates a subset of a shader's own
 * float knobs. `seed` is the export's ROLL TOKEN — pass a fresh random token per export for gacha
 * variety, or a saved token to reproduce a specific clip (motion is fully determined by the seed).
 * Returns null when the shader has no eligible float knobs (nothing to animate).
 */
export function buildAutoMotion(
  inputs: ISFInput[],
  baseValues: Record<string, number>,
  mode: MotionMode,
  seed: string,
): ((frameIndex: number, u: number) => Record<string, number>) | null {
  const floats = inputs.filter(
    (i) => i.TYPE === 'float' && typeof i.MIN === 'number' && typeof i.MAX === 'number' && i.MAX > i.MIN && !SIM_PARAM_PATTERN.test(i.NAME),
  );
  const eligible = floats.filter((i) => !TIME_SPEED_PATTERN.test(i.NAME));
  // time/speed knobs: held at a deterministic random constant (see header), never swept.
  const staticKnobs = floats.filter((i) => TIME_SPEED_PATTERN.test(i.NAME));
  if (!eligible.length && !staticKnobs.length) return null;

  const H = (salt: string) => hash(seed + ':' + salt);

  const staticValues: Record<string, number> = {};
  for (const input of staticKnobs) {
    const min = input.MIN!;
    const max = input.MAX!;
    // Inner half of the range — avoids the extreme ends (e.g. speed=0 → frozen clip) while still
    // varying per roll. Deterministic, so re-exporting with the same token is reproducible.
    staticValues[input.NAME] = min + (0.25 + 0.5 * H(input.NAME + ':static')) * (max - min);
  }

  // Knob count is rolled within the mode's band, then that many are chosen by hashed rank so the same
  // roll always picks the same knobs in the same order rather than always the first N declared.
  const [kMin, kMax] = KNOB_RANGE[mode];
  const count = Math.min(eligible.length, kMin + Math.floor(H('count') * (kMax - kMin + 1)));
  const ranked = [...eligible].sort((a, b) => H(a.NAME) - H(b.NAME));
  const picked = ranked.slice(0, count);

  // Roll each knob's archetype first, then guarantee at least one is continuous so a roll can't come up
  // all-rest (every knob a pulse/sweep sitting near base for most of the clip).
  const archetypes = picked.map((input) => pickWeighted(H(input.NAME + ':arch'), ARCHETYPE_WEIGHTS[mode]));
  if (picked.length && !archetypes.some((a) => CONTINUOUS.includes(a))) archetypes[0] = 'oscillate';

  const cycles = CYCLE_CHOICES[mode];
  const ampBase = AMP_BASE[mode];

  const curves: KnobCurve[] = picked.map((input, idx) => {
    const min = input.MIN!;
    const max = input.MAX!;
    const range = max - min;
    const base = typeof baseValues[input.NAME] === 'number' ? baseValues[input.NAME] : (min + max) / 2;
    const h = (salt: string) => hash(seed + ':' + input.NAME + ':' + salt);
    // Amplitude tiering: spread WIDE so a clip mixes bold movers with subtle ones — a flat band across
    // every knob read as barely-there (Kyle, 2026-07-23). The lead knob (top-ranked, also the guaranteed-
    // continuous one) is always a bold mover so there's clear action even on a quiet roll.
    const ampScale = idx === 0 ? 0.9 + 0.4 * h('amp') : 0.3 + 0.8 * h('amp');
    const amp = range * ampBase * ampScale;
    // Evenly spread the base phase across the picked knobs, plus a small hashed jitter within each
    // knob's slot — keeps peaks from all landing together (reads coordinated, not busy).
    const phase = (idx / picked.length) * TAU + h('phase') * (TAU / picked.length);
    return {
      name: input.NAME,
      center: base,
      min,
      max,
      arch: archetypes[idx],
      disp: buildDisp(archetypes[idx], amp, phase, cycles, h),
    };
  });

  return (_frameIndex: number, u: number) => {
    const out: Record<string, number> = { ...staticValues };
    for (const c of curves) out[c.name] = clamp(c.center + c.disp(u), c.min, c.max);
    return out;
  };
}
