// Deterministic, pure-CPU feature extraction from an ISF shader. No renderer, no network, no GPU.
// The programmatic HALF of the corpus feature/pattern index: it reliably pulls out the things you can
// read straight off the source (which GLSL built-ins are called, which ISF uniforms are referenced,
// the INPUT type mix, pass/feedback structure) plus a set of HIGH-PRECISION technique heuristics
// (rotation matrix, iq palette, raymarch, SDF, domain repeat, polar, hash-noise, symmetry fold).
//
// It is intentionally conservative: a technique heuristic only fires on a strong, characteristic idiom,
// and each carries a confidence so the LLM enrichment layer (enrich.ts) can refine/extend the softer
// judgement calls off the same source. Missing a technique here is fine — the LLM catches the rest;
// a false positive is worse, so the regexes lean toward precision.
//
// Bump EXTRACTOR_VERSION whenever the output shape or detection logic changes so the backfill script
// knows which rows to re-derive.
import { parseISF } from './parse';
import type { ISFInputType } from './types';

export const EXTRACTOR_VERSION = 3;

export interface Technique {
  name: string;
  confidence: number; // 0..1 — how sure the heuristic is (structural facts = 1)
}

export interface FeatureRecord {
  builtins: Record<string, number>; // GLSL built-in fn -> call count
  uniforms: string[]; // ISF built-in uniforms + declared INPUT names actually referenced in the body
  inputTypes: Partial<Record<ISFInputType, number>>; // histogram of declared INPUT types
  techniques: Technique[]; // detected art techniques, most-confident first
  passes: number; // number of render passes (1 = single pass)
  feedback: boolean; // any PERSISTENT pass (reads last frame — feedback/simulation)
  loc: number; // non-blank source lines (a cheap complexity proxy)
  extractorVersion: number;
}

// GLSL ES 1.00 built-in functions glslop supports. All are called as `name(` — matching on the call
// form (identifier immediately followed by `(`) avoids counting swizzles/members/variables named alike.
const BUILTINS = [
  // angle & trig
  'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  // exponential
  'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt',
  // common
  'abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep',
  // geometric
  'length', 'distance', 'dot', 'cross', 'normalize', 'faceforward', 'reflect', 'refract',
  // matrix & relational
  'matrixCompMult', 'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual', 'equal', 'notEqual', 'any', 'all', 'not',
  // texture sampling (+ ISF IMG_* macros the runtime injects)
  'texture2D', 'textureCube', 'IMG_NORM_PIXEL', 'IMG_PIXEL', 'IMG_THIS_PIXEL', 'IMG_THIS_NORM_PIXEL', 'IMG_SIZE',
] as const;

// ISF built-in uniforms the runtime provides (declared INPUT names are added dynamically per shader).
const ISF_UNIFORMS = ['TIME', 'RENDERSIZE', 'TIMEDELTA', 'FRAMEINDEX', 'PASSINDEX', 'DATE', 'isf_FragNormCoord', 'gl_FragCoord'];

// Strip line + block comments so identifiers inside comments aren't matched. GLSL has no string
// literals, so we only need to worry about comments.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countCalls(code: string, name: string): number {
  // identifier boundary before the name, then the name, then optional space, then '('
  const re = new RegExp(`(?<![A-Za-z0-9_.])${escapeRe(name)}\\s*\\(`, 'g');
  return (code.match(re) || []).length;
}

function referencesIdent(code: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_.])${escapeRe(name)}(?![A-Za-z0-9_])`).test(code);
}

// --- technique heuristics: each returns 0 (absent) or a confidence 0..1 -----------------------------
// These deliberately favour precision. `code` is comment-stripped GLSL. A couple use the raw
// structural facts (feedback/multipass) passed in.
function detectTechniques(code: string, passes: number, feedback: boolean): Technique[] {
  const out: Technique[] = [];
  const add = (name: string, confidence: number) => {
    if (confidence > 0) out.push({ name, confidence: Math.min(1, confidence) });
  };

  // rotation matrix: the canonical 2D rotate. Three forms, decreasing precision:
  //   (a) cos/sin literally inside the mat2 — mat2(cos(a),sin(a),...)
  //   (b) a 4-arg mat2 of bare/negated identifiers or float literals with a negated off-diagonal
  //       (mat2(c,-s,s,c) / mat2(0.8,0.6,-0.6,0.8)), when the shader also uses cos+sin (the angle).
  const usesTrig = /\bcos\s*\(/.test(code) && /\bsin\s*\(/.test(code);
  const mat2Rot4 = /mat2\s*\(\s*-?[\w.]+\s*,\s*-?[\w.]+\s*,\s*-?[\w.]+\s*,\s*-?[\w.]+\s*\)/;
  const negatedEntry = /mat2\s*\([^)]*,\s*-\s*[\w.]/; // at least one negated entry — the rotation signature
  if (/mat2\s*\(\s*[^)]*\bcos\b[^)]*\bsin\b/.test(code)) add('rotation2d', 0.9);
  else if (usesTrig && mat2Rot4.test(code) && negatedEntry.test(code)) add('rotation2d', 0.75);

  // hash noise: the classic fract(sin(dot(...))) or a big magic multiplier feeding fract.
  if (/fract\s*\(\s*sin\s*\(\s*dot\b/.test(code)) add('hash_noise', 0.95);
  else if (/\b(43758\.5453|43758|12\.9898|78\.233|4375\d)\b/.test(code)) add('hash_noise', 0.8);

  // iq cosine palette: a + b*cos(6.2831*(c*t+d)). Detect a cos() over a TAU-ish constant returning colour.
  if (/\bcos\s*\(\s*(6\.28|6\.2831|2\.0?\s*\*\s*(PI|3\.14)|TAU)/.test(code) && /\bvec3\b/.test(code)) {
    add('palette_cosine', 0.75);
  }

  // polar coordinates: angle from atan + radius from length, the hallmark of radial/kaleidoscope work.
  if (/\batan\s*\(/.test(code) && /\blength\s*\(/.test(code)) add('polar', 0.6);

  // raymarch / SDF march: a loop that steps along a ray accumulating distance. Look for a for-loop plus
  // ray-ish naming or a distance accumulation with an early break.
  const hasLoop = /\bfor\s*\(/.test(code);
  const rayNames = /\b(rd|ro|rayDir|rayOrigin|ray)\b/.test(code);
  const distAccum = /\b([a-zA-Z_]\w*)\s*\+=\s*[^;]*\b(map|sdf|sd[A-Z]\w*|de|dist)\b/.test(code) || /\bt\s*\+=\s*/.test(code);
  if (hasLoop && rayNames && (distAccum || /\bnormalize\s*\(/.test(code))) add('raymarch', 0.8);
  else if (hasLoop && distAccum && /\bbreak\b/.test(code)) add('raymarch', 0.5);

  // SDF combinators: distance-field building blocks (min/max union/intersect over length-based prims).
  if (/\b(sd[A-Z]\w*|sdSphere|sdBox|sdTorus)\b/.test(code) || (/\blength\s*\(/.test(code) && /\bmax\s*\(\s*[^)]*length/.test(code))) {
    add('sdf', 0.6);
  }

  // domain repetition: tiling space with mod/fract applied directly to a coordinate (the tiling idiom
  // `mod(p, ...)` / `fract(uv*n)`) — coordinate as the FIRST arg, so we don't match hashes like
  // fract(sin(dot(p,...))) where the coordinate is buried inside.
  if (/\b(mod|fract)\s*\(\s*[+\-]?\s*(uv|p|pos|st|coord|q|isf_FragNormCoord|fragCoord)\b/.test(code)) add('domain_repeat', 0.55);

  // symmetry fold: abs() applied to a coordinate — mirror/kaleidoscope folds.
  if (/\babs\s*\(\s*(uv|p|pos|st|q|isf_FragNormCoord|fragCoord)\b/.test(code)) add('symmetry_fold', 0.5);

  // thin-film interference — the iridescent oil-slick / soap-bubble / nacre look, and the signature
  // glslop palette. The colour comes from giving each channel a different phase, driven by a
  // view-angle or film-thickness term. A cosine palette alone is NOT evidence (62% of the corpus has
  // one), so the phase build must co-occur with something thin-film specific: Schlick's fresnel (the
  // standard view-angle factor) or explicit film/thickness naming.
  const fresnel = /\bpow\s*\(\s*1\.0?\s*-/.test(code);
  const filmNamed = /\b(thickness\w*|iridescen\w*|film|nacre|interference)/i.test(code);
  const perChannelPhase = /\bcos\s*\([^;]{0,120}\b(vec3\s*\(|phase|shift|offset)/i.test(code);
  if (filmNamed && perChannelPhase && fresnel) add('thin_film', 0.85);
  else if (filmNamed && perChannelPhase) add('thin_film', 0.6);

  // structural, not heuristic — certainties.
  if (feedback) add('feedback', 1);
  if (passes > 1) add('multipass', 1);

  return out.sort((a, b) => b.confidence - a.confidence);
}

export function extractFeatures(isf: string): FeatureRecord {
  const parsed = parseISF(isf);
  // Even if the header is malformed we still want SOME signal: fall back to scanning the whole source.
  const body = parsed.ok ? parsed.isf.body : isf;
  const inputs = parsed.ok ? parsed.isf.inputs : [];
  const passes = parsed.ok ? parsed.isf.passes : [];
  const code = stripComments(body);

  const builtins: Record<string, number> = {};
  for (const fn of BUILTINS) {
    const n = countCalls(code, fn);
    if (n > 0) builtins[fn] = n;
  }

  const inputNames = inputs.map((i) => i.NAME).filter((n): n is string => typeof n === 'string' && !!n);
  const uniforms: string[] = [];
  for (const u of [...ISF_UNIFORMS, ...inputNames]) {
    if (!uniforms.includes(u) && referencesIdent(code, u)) uniforms.push(u);
  }

  const inputTypes: Partial<Record<ISFInputType, number>> = {};
  for (const inp of inputs) {
    if (!inp.TYPE) continue;
    inputTypes[inp.TYPE] = (inputTypes[inp.TYPE] ?? 0) + 1;
  }

  const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true' || v === 'YES';
  const feedback = passes.some((p) => truthy(p.PERSISTENT));
  const passCount = Math.max(1, passes.length);

  const loc = code.split('\n').filter((l) => l.trim().length > 0).length;

  return {
    builtins,
    uniforms,
    inputTypes,
    techniques: detectTechniques(code, passCount, feedback),
    passes: passCount,
    feedback,
    loc,
    extractorVersion: EXTRACTOR_VERSION,
  };
}
