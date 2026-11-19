// Core mod: compile-cost advisor. Answers "why is this slow to compile, and what do I change?"
//
// Three layers, each replaceable:
//  1. budget  — the static inlined-statement estimator from glslop.mjs (calibrated on FXC, Spearman 0.95).
//  2. rules   — `studio.state.advisorRules`: an ARRAY mods can push to / filter. Each rule looks at
//               source (+ translated source, + measured ms) and returns findings with a fix.
//  3. measure — optional real compile on this GPU, plus translated-source size (what the driver got).
//
// The guide the rules cite is docs/COMPILE-COST.md (distilled from glslop's craft.txt "compile budget").
import type { Studio, StudioMod } from '../studio/api';
import { loopBudget, compileAdvice } from '@glslop/core/budget';

export interface Finding { rule: string; severity: 'info' | 'warn' | 'high'; line?: number; message: string; fix?: string }
export interface AdvisorInput { isf: string; translated?: string | null; compileMs?: number; backend?: string; budget: ReturnType<typeof loopBudget> }
export interface AdvisorRule { id: string; description: string; check: (i: AdvisorInput) => Finding[] }

const lineOf = (src: string, idx: number) => src.slice(0, idx).split('\n').length;

export const defaultRules: AdvisorRule[] = [
  {
    id: 'repeated-heavy-call',
    description: 'A big function called from several places outside loops gets pasted once per call site.',
    check: ({ budget }) => budget.repeated
      .filter((r: any) => r.statements * r.copies >= Math.max(150, budget.inlined / 5))
      .map((r: any) => ({
        rule: 'repeated-heavy-call', severity: r.statements * r.copies > budget.inlined / 2 ? 'high' : 'warn',
        message: `${r.name}() (~${r.statements} statements once inlined) is pasted ${r.copies}×`,
        fix: `Call ${r.name}() from ONE site inside a ${r.copies}-trip loop that picks per-trip parameters by index, or reuse a computed result.`,
      })),
  },
  {
    id: 'normal-taps',
    description: 'Hand-written central-difference normals call map() 4–6 times.',
    check: ({ isf }) => {
      const out: Finding[] = [];
      const re = /\b(vec3)\s*\(\s*([A-Za-z_]\w*)\s*\([^;]*?\)\s*-\s*\2\s*\(/g;
      for (const m of isf.matchAll(re)) {
        out.push({ rule: 'normal-taps', severity: 'warn', line: lineOf(isf, m.index!), message: `normal via repeated ${m[2]}() taps`,
          fix: `Loop over the 4 tetrahedron taps with ONE ${m[2]}() call site: for (int i=0;i<4;i++){ float f=float(i); vec3 e = vec3(mod(floor((f+3.0)*0.5),2.0), mod(floor(f*0.5),2.0), mod(f,2.0))*2.0-1.0; n += e*${m[2]}(p+e*h); } n = normalize(n);` });
      }
      return out;
    },
  },
  {
    id: 'nested-constant-loops',
    description: 'Deep nests of constant loops can be fully unrolled by FXC (minutes-long compiles).',
    check: ({ budget }) => budget.unrolled >= 200000
      ? [{ rule: 'nested-constant-loops', severity: 'high', line: budget.dominant ?? undefined,
          message: `~${budget.unrolled.toLocaleString()} statements if all constant loops unroll (max nested trips ${budget.maxNested})`,
          fix: 'Flatten the nest: one loop over i < A*B with derived indices, or cut trip counts. Every >100s compile in the corpus sits past 200k.' }]
      : [],
  },
  {
    id: 'mat-array-write',
    description: 'Conditional writes into mat arrays compile ~7× slower than parallel vec4 arrays.',
    check: ({ budget }) => budget.matArrayWrite !== null
      ? [{ rule: 'mat-array-write', severity: 'warn', line: budget.matArrayWrite, message: 'conditional write into a mat2/3/4 array', fix: 'Store as parallel vec4 arrays, or write unconditionally.' }]
      : [],
  },
  {
    id: 'big-if-chain',
    description: 'Long if/else-if chains compile at their full size.',
    check: ({ isf }) => {
      const out: Finding[] = [];
      let count = 0, first = -1;
      for (const m of isf.matchAll(/\belse\s+if\b/g)) { if (first < 0) first = m.index!; count++; }
      if (count >= 10) out.push({ rule: 'big-if-chain', severity: 'info', line: lineOf(isf, first), message: `${count} else-if branches`,
        fix: 'Replace with one loop over the cases that derives each case\'s parameters from the index and keeps the match; run shared work once after the loop (measured 7.8× faster compile).' });
      return out;
    },
  },
  {
    id: 'translated-size',
    description: 'What the backend compiler actually received.',
    check: ({ translated, isf }) => {
      if (!translated) return [];
      const ratio = translated.length / Math.max(1, isf.length);
      return ratio > 6 ? [{ rule: 'translated-size', severity: 'info', message: `translated source is ${(translated.length / 1024).toFixed(0)} KB (${ratio.toFixed(1)}× the ISF)`, fix: 'Inspect with the "translated" view; look for repeated inlined bodies.' }] : [];
    },
  },
];

const mod: StudioMod = {
  description: 'Compile-cost advisor: static budget + pattern rules + optional real compile.',
  activate(studio: Studio) {
    studio.state.advisorRules = [...defaultRules];

    studio.tools.add({
      name: 'advise',
      description: 'Explain a shader\'s compile cost and suggest concrete source changes. Static by default; measure:true also compiles on this GPU and inspects the translated source.',
      input: {
        type: 'object',
        properties: {
          isf: { type: 'string' }, id: { type: 'string' }, path: { type: 'string' },
          measure: { type: 'boolean' },
        },
      },
      async run(args: any) {
        const isf: string = await studio.state.gl.sourceOf(args);
        const budget = loopBudget(isf);
        let compileMs: number | undefined, translated: string | null = null, backend: string | undefined, renderer = '';
        if (args.measure) {
          const { outcome } = await studio.state.gl.compileOnce(isf);
          compileMs = outcome.compileMs; translated = outcome.record?.translatedSource ?? null; backend = outcome.backend; renderer = outcome.renderer;
        }
        const ref = args.id ? studio.state.corpus?.shaders.find((s: any) => s.id === args.id)?.ref_compile_ms : undefined;
        const input: AdvisorInput = { isf, translated, compileMs, backend, budget };
        const findings: Finding[] = [];
        for (const rule of studio.state.advisorRules as AdvisorRule[]) {
          try { findings.push(...rule.check(input)); } catch (e) { findings.push({ rule: rule.id, severity: 'info', message: `rule crashed: ${(e as Error).message}` }); }
        }
        const order = { high: 0, warn: 1, info: 2 };
        findings.sort((a, b) => order[a.severity] - order[b.severity]);
        return {
          estimate: {
            inlined_statements: budget.inlined, unrolled_statements: budget.unrolled,
            verdict: budget.inlined >= 4000 ? 'heavy (>10s on FXC)' : budget.inlined >= 1000 ? 'seconds on FXC' : budget.inlined >= 400 ? 'likely >500ms on FXC' : 'likely fast',
            warnings: budget.warnings,
          },
          reference_d3d11_ms: ref ?? null,
          measured: compileMs !== undefined ? { ms: compileMs, backend, renderer, notes: compileAdvice(compileMs, renderer) } : null,
          translated_bytes: translated?.length ?? null,
          findings,
          guide: 'docs/COMPILE-COST.md',
        };
      },
    });
  },
};
export default mod;
