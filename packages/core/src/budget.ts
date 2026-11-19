// @ts-nocheck
// Ported verbatim from glslop/scripts/glslop.mjs (loopBudget, compileAdvice). Keep in sync, or replace
// it from a mod: studio.tools.wrap('advise', ...). Calibrated on D3D11/FXC, RTX 3090, 2026-09.
// ---- compile budget (static) ---------------------------------------------
// Windows visitors compile through ANGLE -> HLSL -> FXC, which inlines every call and whose time grows
// faster than linearly with the straight-line code it ends up holding. Loops mostly stay loops: a body
// inside a loop is compiled about once, however many trips it has, while every call site OUTSIDE a loop
// is another full copy of everything that call reaches. So the predictor is `inlined`: statements with
// every call expanded and each loop body counted once. Across 213 measured corpus shaders (RTX 3090,
// D3D11, 2026-09-18) it ranks compile time at Spearman 0.95 where the unrolled count manages 0.83;
// >= 400 separates the 500ms autoplay bar at 95% precision / 92% recall. Loops are not free, though:
// FXC does unroll some (small bodies especially), and the minutes-long compiles all have huge fully
// unrolled counts, so `unrolled` (every constant trip multiplied through) stays as the tail signal.
// This is a heuristic, not a compiler: it resolves integer #defines and expands user-function calls one
// level at a time (GLSL has no recursion). See craft.txt, "The compile budget".
export const INLINED_WARN = 400; // median 634ms at 400-1,000; below 400, none of 152 shaders passed 2s
export const INLINED_SECONDS = 1000; // median 3.6s at 1,000-2,000
export const INLINED_HEAVY = 4000; // every measured shader past this took over 10s
export const UNROLLED_TAIL = 200000; // all five compiles over 100s sit past this
// Stamped on every result, because an estimate without the estimator's version is a number nobody can
// check. 2026-09-06's notes recorded `5t6dnxo6 ≈ 815,000`; the committed function has always returned
// 1,183,462 for it, on two independently baked copies of a source that never changed, so that figure
// came from an uncommitted prototype and was indistinguishable from a real reading for five days.
// Bump whenever the estimate for unchanged source could move. v2: `inlined`, `repeated`, `matArrayWrite`
// and new warnings; `unrolled` and the per-loop records are unchanged from v1.
export const BUDGET_VERSION = 2;
const GLSL_KEYWORDS = new Set(['if', 'for', 'while', 'return', 'discard', 'else', 'do', 'switch']);
export function loopBudget(isf) {
  const defs = {};
  for (const m of isf.matchAll(/^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]+\(?[ \t]*(-?\d+)[ \t]*\)?[ \t]*(?:\/\/.*)?$/gm)) defs[m[1]] = Number(m[2]);
  const value = (text) => {
    const s = text.trim().replace(/^\((.*)\)$/, '$1').trim();
    if (/^-?\d+$/.test(s)) return Number(s);
    if (s in defs) return defs[s];
    const m = s.match(/^([A-Za-z_]\w*)[ \t]*([+-])[ \t]*(\d+)$/);
    if (m && m[1] in defs) return m[2] === '+' ? defs[m[1]] + Number(m[3]) : defs[m[1]] - Number(m[3]);
    return null;
  };
  // Strip comments and preprocessor lines but keep newlines so line numbers survive.
  const code = isf
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/^[ \t]*#[^\n]*/gm, (c) => c.replace(/[^\n]/g, ' '));
  const fnNames = new Set();
  for (const m of code.matchAll(/(?:^|[\n;}])[ \t]*(?:float|int|bool|void|[ib]?vec[234]|mat[234])[ \t]+([A-Za-z_]\w*)[ \t]*\(/g)) fnNames.add(m[1]);
  const matArrays = new Set([...code.matchAll(/\bmat[234][ \t]+([A-Za-z_]\w*)[ \t]*\[/g)].map((m) => m[1]));
  let matArrayWrite = null; // line of the first `if (…) m[k] = …` into a mat2/3/4 array
  // name -> { statements (loop-weighted), calls: [{ name, mult }], flat (each loop body once), sites: [name] }
  const fns = {};
  const loops = []; // { line, name, trip, nested, statements, calls }
  const open = []; // enclosing loops in the current function
  let fn = null, fnDepth = 0, depth = 0, pending = null;
  const mult = (from = 0) => open.slice(from).reduce((p, l) => p * (l.trip ?? 1), 1);
  const line = (i) => code.slice(0, i).split('\n').length;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') {
      depth++;
      if (pending) { pending.depth = depth; open.push(pending); pending = null; }
      continue;
    }
    if (ch === '}') {
      while (open.length && open[open.length - 1].depth === depth) open.pop();
      depth--;
      if (fn && depth < fnDepth) fn = null;
      continue;
    }
    if (ch === ';') {
      // A braceless loop body is one statement that still runs `trip` times.
      const braceless = pending ? (pending.trip ?? 1) : 1;
      if (pending) { pending.statements += braceless; pending = null; }
      if (fn) { fn.statements += mult() * braceless; fn.flat++; }
      open.forEach((l, k) => { l.statements += mult(k) * braceless; });
      continue;
    }
    if (!/[A-Za-z_]/.test(ch) || /\w/.test(code[i - 1] || ' ')) continue;
    let j = i; while (j < code.length && /\w/.test(code[j])) j++;
    const word = code.slice(i, j);
    let k = j; while (code[k] === ' ' || code[k] === '\t') k++;
    if (word === 'for' && code[k] === '(') {
      let level = 0, close = -1;
      for (let q = k; q < code.length; q++) {
        if (code[q] === '(') level++;
        else if (code[q] === ')' && --level === 0) { close = q; break; }
      }
      if (close < 0) break;
      const parts = code.slice(k + 1, close).split(';');
      let trip = null, name = null;
      if (parts.length >= 2) {
        const init = parts[0].match(/(?:int|float)?[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*(.+)$/);
        const cond = parts[1].match(/^[ \t]*([A-Za-z_]\w*)[ \t]*(<=|>=|<|>|!=)[ \t]*(.+)$/);
        if (init && cond && init[1] === cond[1]) {
          name = init[1];
          const from = value(init[2]), to = value(cond[3]);
          if (from !== null && to !== null) {
            const op = cond[2];
            trip = op === '<' || op === '!=' ? to - from : op === '<=' ? to - from + 1 : op === '>' ? from - to : from - to + 1;
            if (!(trip > 0)) trip = 0;
          }
        }
      }
      const loop = { line: line(i), name, trip, nested: trip === null ? null : trip * mult(), statements: 0, calls: [] };
      loops.push(loop);
      pending = loop;
      i = close;
      continue;
    }
    if (code[k] === '(' && depth === 0 && fnNames.has(word) && !GLSL_KEYWORDS.has(word)) {
      // A definition header at file scope: its body is the next brace block.
      fn = fns[word] = fns[word] || { statements: 0, calls: [], flat: 0, sites: [] };
      fnDepth = 1;
      i = j - 1;
      continue;
    }
    if (code[k] === '(' && fn && fnNames.has(word) && !GLSL_KEYWORDS.has(word)) {
      const braceless = pending ? (pending.trip ?? 1) : 1;
      fn.calls.push({ name: word, mult: mult() * braceless });
      fn.sites.push(word);
      open.forEach((l, q) => { l.calls.push({ name: word, mult: mult(q) * braceless }); });
      if (pending) pending.calls.push({ name: word, mult: braceless });
    }
    if (fn && matArrayWrite === null && code[k] === '[' && matArrays.has(word)) {
      let q = k, level = 0;
      for (; q < code.length; q++) { if (code[q] === '[') level++; else if (code[q] === ']' && --level === 0) break; }
      let r = q + 1; while (code[r] === ' ' || code[r] === '\t') r++;
      // An assignment guarded by an `if` in the same statement (or opening its block): the measured slow case.
      if (code[r] === '=' && code[r + 1] !== '=' && /\bif[ \t]*\([^;{}]*\)\s*\{?[^;{}]*$/.test(code.slice(Math.max(0, i - 160), i))) matArrayWrite = line(i);
    }
    i = j - 1;
  }
  const memo = {}, visiting = new Set();
  const expanded = (name) => {
    if (name in memo) return memo[name];
    const f = fns[name];
    if (!f || visiting.has(name)) return 0;
    visiting.add(name);
    const n = f.statements + f.calls.reduce((s, c) => s + c.mult * expanded(c.name), 0);
    visiting.delete(name);
    return (memo[name] = n);
  };
  const unrolled = Math.round('main' in fns ? expanded('main') : Object.keys(fns).reduce((s, n) => s + expanded(n), 0));
  for (const l of loops) l.work = Math.round(l.statements + l.calls.reduce((s, c) => s + c.mult * expanded(c.name), 0));
  const known = loops.filter((l) => l.trip !== null);
  const maxTrip = known.reduce((m, l) => Math.max(m, l.trip), 0);
  const maxNested = known.reduce((m, l) => Math.max(m, l.nested), 0);
  const dominant = known.filter((l) => l.work > 0).sort((a, b) => b.work - a.work)[0] || null;

  // Inlined size: every call site is a full copy of its callee, each loop body counts once.
  const flatMemo = {};
  const flat = (name) => {
    if (name in flatMemo) return flatMemo[name];
    const f = fns[name];
    if (!f || visiting.has(name)) return 0;
    visiting.add(name);
    const n = f.flat + f.sites.reduce((s, callee) => s + flat(callee), 0);
    visiting.delete(name);
    return (flatMemo[name] = n);
  };
  const root = 'main' in fns ? ['main'] : Object.keys(fns);
  const inlined = root.reduce((s, n) => s + flat(n), 0);
  // How many copies of each function end up in the root: callers first, so every caller's count is final
  // before it is handed down.
  const order = [], seen = new Set();
  const visit = (name, path = new Set()) => {
    if (seen.has(name) || path.has(name) || !fns[name]) return;
    path.add(name);
    for (const callee of fns[name].sites) visit(callee, path);
    path.delete(name);
    seen.add(name);
    order.push(name);
  };
  root.forEach((n) => visit(n));
  const copies = Object.fromEntries(root.map((n) => [n, 1]));
  for (const name of order.reverse()) for (const callee of fns[name].sites) copies[callee] = (copies[callee] || 0) + (copies[name] || 0);
  // The functions pasted more than once, by how much of the inlined total their copies make up.
  const repeated = order
    .filter((n) => !root.includes(n) && copies[n] >= 2)
    .map((n) => ({ name: n, statements: flat(n), copies: copies[n] }))
    .sort((a, b) => b.statements * b.copies - a.statements * a.copies)
    .slice(0, 3);

  const warnings = [];
  if (inlined >= INLINED_WARN) {
    const top = repeated[0] && repeated[0].statements * repeated[0].copies >= inlined / 4 ? repeated[0] : null;
    warnings.push(
      'about ' + inlined + ' statements with every call inlined — on Windows (FXC) ' +
        (inlined >= INLINED_HEAVY ? 'every measured shader this size took over 10s'
          : inlined >= INLINED_SECONDS ? 'shaders this size usually take seconds'
          : 'shaders this size usually miss the 500ms autoplay bar') +
        (top ? '; biggest repeat: ' + top.name + '() ~' + top.statements + ' statements pasted ' + top.copies + ' times — every call site outside a loop is a full copy, so reuse a result or loop over one call site'
          : '; shrink the largest helpers, or move repeated calls into one loop'),
    );
  }
  if (unrolled >= UNROLLED_TAIL) {
    warnings.push(
      'about ' + unrolled + ' statements if every constant loop unrolled' +
        (dominant ? ' (line ' + dominant.line + ': ' + (dominant.nested ?? '?') + ' nested iterations)' : '') +
        ' — FXC unrolls some loops, and every measured shader this large compiled in seconds to minutes; cut nested trip counts',
    );
  }
  if (matArrayWrite !== null) {
    warnings.push('line ' + matArrayWrite + ': conditional write into a mat2/3/4 array — FXC compiles this far slower than the same data in vec4 arrays (measured ~7x); store it as parallel vec4 arrays or write it unconditionally');
  }
  return { budgetVersion: BUDGET_VERSION, loops: loops.map(({ statements, calls, ...l }) => l), maxTrip, maxNested, unrolled, dominant: dominant ? dominant.line : null,
    inlined, repeated, matArrayWrite, warnings };
}

// The --json shape of loopBudget(): inlined_statements is the predictor, unrolled_statements the tail signal.
function budgetJson(b) {
  return { budget_version: b.budgetVersion, inlined_statements: b.inlined, unrolled_statements: b.unrolled, max_trip: b.maxTrip, max_nested: b.maxNested,
    repeated: b.repeated, mat_array_write_line: b.matArrayWrite, warnings: b.warnings };
}

// What a measured compile time means for visitors, given the backend that measured it. The caller
// already prints the number, so these lines interpret it rather than repeating it — and the backend
// line always comes first, because on a Mac it is the only thing that explains the word 'estimated'.
export function compileAdvice(ms, renderer = '') {
  if (typeof ms !== 'number') return [];
  const r = String(renderer);
  const fxc = /D3D11|Direct3D/i.test(r);
  const metal = /Metal|Apple/i.test(r);
  const software = /SwiftShader|llvmpipe|software/i.test(r);
  const out = [];
  if (software) out.push('measured on a CPU renderer, so this number describes SwiftShader rather than any visitor GPU; Windows visitors compile through FXC');
  else if (fxc) out.push('measured through D3D11/FXC, the reference path Windows visitors pay');
  else if (metal) out.push(`measured on Metal, which compiles about 10x faster than the FXC path Windows visitors pay — call it ${Math.round(ms * 10)}ms there`);
  else out.push('measured on a non-FXC backend; Windows visitors compile through FXC, which is usually slower');
  const est = fxc ? ms : metal ? ms * 10 : null;
  if (est !== null && est > 10000) out.push(`${fxc ? 'over' : 'estimated over'} 10s: marked heavy, never autoplays, and the recording batch has to retry it warm to capture a clip`);
  else if (est !== null && est > 500) out.push(`${fxc ? 'over' : 'estimated over'} the 500ms autoplay bar: the detail page shows the recording and waits for a click`);
  return out;
}
