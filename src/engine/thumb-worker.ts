// Thumbnail worker: one OffscreenCanvas + one GL context, renders a poster frame per request with the
// canonical glslop poster semantics (renderPosterFrame: time 0.8, feedback warmed 120 steps) and
// returns an encoded WebP. Runs off the main thread so a long compile never stalls scrolling.
import { GlslopRenderer, renderPosterFrame, runtimeConfig } from '@glslop/core/runtime';

const scope = self as unknown as Worker;
let owner: GlslopRenderer | null = null;
let canvas: OffscreenCanvas | null = null;

interface Job { id: string; isf: string; size: number; time: number; posterBase: string; textures?: Record<string, string>; type?: string; quality?: number }

scope.onmessage = async (e: MessageEvent<Job>) => {
  const job = e.data;
  const t0 = performance.now();
  try {
    if (!owner) {
      canvas = new OffscreenCanvas(job.size, job.size);
      owner = new GlslopRenderer(canvas);
    }
    if (owner.isContextLost()) throw new Error('context lost');
    runtimeConfig.posterBase = job.posterBase;
    runtimeConfig.textureUrl = job.textures ? (id) => job.textures![id] ?? `${runtimeConfig.posterBase}/posters/${id}.png` : undefined;
    const r = owner.createSibling();
    try {
      const res = await r.load(job.isf);
      const compileMs = Math.round(performance.now() - t0);
      if (!res.compileOk) { scope.postMessage({ id: job.id, ok: false, error: res.errors.join('\n'), compileMs }); return; }
      await renderPosterFrame(r, { width: job.size, height: job.size, time: job.time });
      const blob = await canvas!.convertToBlob({ type: job.type ?? 'image/webp', quality: job.quality ?? 0.86 });
      const bytes = await blob.arrayBuffer();
      scope.postMessage({ id: job.id, ok: true, bytes, compileMs, totalMs: Math.round(performance.now() - t0) }, [bytes]);
    } finally { r.dispose(); }
  } catch (err) {
    scope.postMessage({ id: job.id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
