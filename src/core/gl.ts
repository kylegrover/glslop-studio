// Core mod: GPU tools — compile, render, capture, translated source, environment.
// All use the glslop WebGL2 runtime (src/engine/runtime.ts, copied from glslop) so results match the site's
// semantics, but on whichever ANGLE backend the studio was launched with.
import type { Studio, StudioMod } from '../studio/api';
import { joinPath } from '../studio/host';
import { GlslopRenderer, renderPosterFrame, captureTimeline, measureRenderFrames, type CompileRecord } from '@glslop/core/runtime';
import { parseISF } from '@glslop/core/parse';

export interface CompileOutcome {
  ok: boolean;
  errors: string[];
  compileMs: number;
  backend: string;
  renderer: string;
  parallelCompile: boolean;
  record: CompileRecord | null;
}

let envCache: Record<string, unknown> | null = null;
function gpuEnv(): Record<string, unknown> {
  if (envCache) return envCache;
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return (envCache = { webgl2: false });
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  envCache = {
    webgl2: true,
    renderer: String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
    vendor: String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
    version: String(gl.getParameter(gl.VERSION)),
    parallelCompile: !!gl.getExtension('KHR_parallel_shader_compile'),
    debugShaders: !!gl.getExtension('WEBGL_debug_shaders'),
    floatTargets: !!gl.getExtension('EXT_color_buffer_float'),
    timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return envCache;
}

/** Defeat ANGLE's in-memory/disk program cache (keyed on source). This does NOT defeat the GPU driver's
 *  own cache (keyed on translated code), and compileMs stops at link, before the work Vulkan defers to
 *  the first draw. So on Vulkan these timings are a lower bound. TODO: time through the first frame with
 *  a semantic nonce; see "Known limitation" in docs/COMPILE-COST.md. */
function nonce(isf: string): string {
  return isf + `\n// studio-nonce ${Math.random().toString(36).slice(2)} ${Date.now()}\n`;
}

export async function compileOnce(studio: Studio, isf: string, opts: { cold?: boolean; keep?: boolean } = {}): Promise<{ outcome: CompileOutcome; renderer: GlslopRenderer | null }> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const r = new GlslopRenderer(canvas);
  const t0 = performance.now();
  const res = await r.load(opts.cold === false ? isf : nonce(isf));
  const wall = performance.now() - t0;
  const env = gpuEnv();
  const outcome: CompileOutcome = {
    ok: res.compileOk, errors: res.errors,
    compileMs: Math.round(r.lastCompile?.compileMs ?? wall),
    backend: studio.host.boot.angleBackend, renderer: String(env.renderer ?? ''),
    parallelCompile: !!env.parallelCompile, record: r.lastCompile,
  };
  if (!opts.keep || !res.compileOk) { r.dispose(); return { outcome, renderer: null }; }
  return { outcome, renderer: r };
}

async function sourceOf(studio: Studio, args: { isf?: string; id?: string; path?: string }): Promise<string> {
  if (args.isf) return args.isf;
  if (args.path) return studio.host.readText(args.path);
  if (args.id) return (await studio.call('corpus.get', { id: args.id })).isf;
  throw new Error('pass one of: isf (source), id (corpus shader), path (file)');
}

const SRC = {
  isf: { type: 'string', description: 'ISF source' },
  id: { type: 'string', description: 'corpus shader id' },
  path: { type: 'string', description: 'path to a .fs file' },
};

const mod: StudioMod = {
  description: 'GPU tools: env, compile, render, capture, translated source, bench.',
  activate(studio: Studio) {
    studio.tools.add({
      name: 'gpu.env',
      description: 'Which GPU/backend the studio is rendering with, and which WebGL extensions it exposes.',
      run: () => ({ backend: studio.host.boot.angleBackend, browserArgs: studio.host.boot.browserArgs, gpuCacheDisabled: studio.host.boot.gpuCacheDisabled, host: studio.host.kind, ...gpuEnv() }),
    });

    studio.tools.add({
      name: 'compile',
      description: 'Compile an ISF shader on this machine\'s GPU. Returns ok/errors, compile ms, backend. Cold by default (ANGLE cache defeated).',
      input: { type: 'object', properties: { ...SRC, cold: { type: 'boolean' }, translated: { type: 'boolean', description: 'include backend-translated source' } } },
      async run(args: { isf?: string; id?: string; path?: string; cold?: boolean; translated?: boolean }) {
        const { outcome } = await compileOnce(studio, await sourceOf(studio, args), { cold: args.cold });
        const { record, ...rest } = outcome;
        return { ...rest, translatedBytes: record?.translatedSource?.length ?? null, ...(args.translated ? { translatedSource: record?.translatedSource, fragmentSource: record?.fragmentSource } : {}) };
      },
    });

    studio.tools.add({
      name: 'render',
      description: 'Render a still PNG (the canonical glslop poster semantics; feedback shaders warm up 120 steps). Saves to the workspace and returns the path.',
      input: {
        type: 'object',
        properties: {
          ...SRC, width: { type: 'number' }, height: { type: 'number' }, time: { type: 'number' },
          inputs: { type: 'object' }, out: { type: 'string', description: 'output PNG path (default workspace/renders/...)' },
          benchmark: { type: 'boolean', description: 'also measure draw time (wall clock incl. readback)' },
          frames: { type: 'array', items: { type: 'number' }, description: 'stepped-timeline frame indices (60fps) instead of one still' },
          returnDataUrl: { type: 'boolean' },
        },
      },
      async run(args: any) {
        const isf = await sourceOf(studio, args);
        const { outcome, renderer } = await compileOnce(studio, isf, { keep: true });
        if (!renderer) return { ok: false, errors: outcome.errors, compileMs: outcome.compileMs, backend: outcome.backend };
        try {
          const width = args.width ?? 512, height = args.height ?? 512;
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const base = args.out ?? joinPath(studio.host.paths.workspace, 'renders', `${args.id ?? 'shader'}-${stamp}.png`);
          if (Array.isArray(args.frames) && args.frames.length) {
            const frames = await captureTimeline(renderer as any, { width, height, inputs: args.inputs, capture: { fps: 60, frames: args.frames } });
            const files = [];
            for (const f of frames) {
              const p = base.replace(/\.png$/i, `-f${f.frame}.png`);
              await studio.host.writeBase64(p, f.pngDataUrl);
              files.push({ frame: f.frame, path: p, hash: f.renderHash });
            }
            return { ok: true, compileMs: outcome.compileMs, backend: outcome.backend, frames: files };
          }
          await renderPosterFrame(renderer as any, { width, height, time: args.time ?? 0.8, inputs: args.inputs });
          const dataUrl = renderer.toDataURL();
          const hash = renderer.averageHash();
          const benchmark = args.benchmark ? await measureRenderFrames(renderer, { width, height, time: args.time ?? 0.8 }) : undefined;
          await studio.host.writeBase64(base, dataUrl);
          studio.events.emit('render:done', { path: base, id: args.id });
          return { ok: true, path: base, hash, compileMs: outcome.compileMs, backend: outcome.backend, renderer: outcome.renderer, benchmark, ...(args.returnDataUrl ? { dataUrl } : {}) };
        } finally { renderer.dispose(); }
      },
    });

    studio.tools.add({
      name: 'parse',
      description: 'Parse the ISF header: inputs, passes, description. No GPU.',
      input: { type: 'object', properties: SRC },
      async run(args: any) {
        const p = parseISF(await sourceOf(studio, args));
        if (!p.ok) return { ok: false, error: p.error };
        return { ok: true, header: p.isf.header, inputs: p.isf.inputs, passes: p.isf.passes, bodyLines: p.isf.body.split('\n').length };
      },
    });

    // Re-export for other mods without import paths.
    studio.state.gl = { compileOnce: (isf: string, o?: any) => compileOnce(studio, isf, o), GlslopRenderer, sourceOf: (a: any) => sourceOf(studio, a) };
  },
};
export default mod;
