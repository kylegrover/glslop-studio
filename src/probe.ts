// The d3d11 cost probe: a hidden window whose webview runs ANGLE on D3D11 + FXC, Chrome's default on
// Windows, with the GPU program caches off. The main window sends it shaders; it times a cold compile
// through the first drawn frame and sends the number back. One job at a time, in order.
//
// Protocol (Tauri events): main → probe 'probe:job' {id, isf} and 'probe:ping'; probe → main
// 'probe:ready' {renderer} and 'probe:result' {id, ok, ms, errors, renderer}.
import { emitTo, listen } from '@tauri-apps/api/event';
import { GlslopRenderer, runtimeConfig } from '@glslop/core/runtime';
import { coldCopy } from './engine/cold';

runtimeConfig.blockingCompile = true; // load() blocks for exactly the driver's time; no polling timers

function rendererName(): string {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return 'no webgl2';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}
const renderer = rendererName();

let chain = Promise.resolve();

async function run(id: string, isf: string) {
  // A unique constant in the output, so no cache can answer (see engine/cold.ts). The GPU disk caches
  // are also off for this window (see probe_start).
  const src = coldCopy(isf);
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64; // compile dominates; keep the draw itself trivial
  let r: GlslopRenderer | null = null;
  try {
    r = new GlslopRenderer(canvas);
    const t0 = performance.now();
    const res = await r.load(src);
    if (!res.compileOk) {
      await emitTo('main', 'probe:result', { id, ok: false, ms: Math.round(performance.now() - t0), errors: res.errors, renderer });
      return;
    }
    r.draw(1.0);
    r.finish();
    await emitTo('main', 'probe:result', { id, ok: true, ms: Math.round(performance.now() - t0), errors: [], renderer });
  } catch (e) {
    await emitTo('main', 'probe:result', { id, ok: false, ms: null, errors: [String((e as Error)?.message ?? e)], renderer });
  } finally {
    r?.dispose();
  }
}

await listen<{ id: string; isf: string }>('probe:job', (e) => {
  chain = chain.then(() => run(e.payload.id, e.payload.isf));
});
await listen('probe:ping', () => { void emitTo('main', 'probe:ready', { renderer }); });
await emitTo('main', 'probe:ready', { renderer });
