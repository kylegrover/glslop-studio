// Core mod: thumbnails. Rendered LOCALLY by default — a cold Vulkan compile is ~5-90 ms, so drawing a
// poster frame here is cheaper than downloading one, and costs glslop.com nothing.
//
//  - Cache: <cache>/thumbs/<id>-<sourcehash>-<size>.webp. Content-addressed, so it's never stale and
//    the studio:// scheme serves it immutable (the webview's memory cache does the rest).
//  - Queue: visible cards first (Browse requests on intersect, cancels on leave), N background workers
//    (settings.thumbWorkers, default 2), each with its own GL context, off the main thread.
//  - settings.thumbSource: 'local' | 'server' | 'auto' (default: local, server poster only if the local
//    compile fails). 'server' downloads posters once and caches them the same way.
//  - Image-input textures (a shader sampling another shader's poster) are fetched once into
//    <cache>/textures/<id>.png and served locally after that.
import type { Studio, StudioMod } from '../studio/api';
import type { CorpusShader } from './corpus';
import { joinPath } from '../studio/host';
import { textureSources } from './corpus';
import { GlslopRenderer, renderPosterFrame, runtimeConfig } from '@glslop/core/runtime';

/** Does this webview give workers WebGL2 on OffscreenCanvas? (WebKitGTK and older WebKit: no.)
 *  Asked right at boot, a webview whose GPU process is still starting can answer "no" once and "yes"
 *  a moment later (seen in the Windows release build), so a "no" is only believed after retries. */
async function workerGlSupported(log: boolean[] = []): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400));
    const ok = await workerGlProbe();
    log.push(ok);
    if (ok) return true;
  }
  return false;
}

async function workerGlProbe(): Promise<boolean> {
  if (typeof OffscreenCanvas === 'undefined' || typeof Worker === 'undefined') return false;
  const src = 'try{postMessage(!!new OffscreenCanvas(1,1).getContext("webgl2"))}catch(e){postMessage(false)}';
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try {
    const w = new Worker(url);
    return await new Promise<boolean>((res) => { w.onmessage = (e) => { res(!!e.data); w.terminate(); }; w.onerror = () => { res(false); w.terminate(); }; setTimeout(() => { res(false); w.terminate(); }, 3000); });
  } finally { URL.revokeObjectURL(url); }
}

/** Best still-image encoding this webview can produce (WebKit's toBlob silently ignores webp). */
async function pickEncoding(): Promise<{ type: string; ext: string }> {
  const c = document.createElement('canvas'); c.width = c.height = 2;
  const b: Blob | null = await new Promise((r) => c.toBlob(r, 'image/webp', 0.8));
  return b?.type === 'image/webp' ? { type: 'image/webp', ext: 'webp' } : { type: 'image/jpeg', ext: 'jpg' };
}

interface Waiter { id: string; resolve: (url: string | null) => void; priority: number }

const mod: StudioMod = {
  description: 'Local thumbnail rendering + disk cache (server posters only as a fallback).',
  activate(studio: Studio) {
    const dir = joinPath(studio.host.paths.cache, 'thumbs');
    const texDir = joinPath(studio.host.paths.cache, 'textures');
    const size = () => studio.settings.thumbSize ?? 384;
    // Where thumbnails come from. 'auto' = render locally when the webview can do WebGL2 in workers
    // (Windows/macOS), otherwise download the server's PNG once (Linux/WebKitGTK: main-thread
    // compiles freeze the UI). An explicit settings.thumbSource always wins.
    const source = () => {
      const s = studio.settings.thumbSource as string | undefined;
      if (s && s !== 'auto') return s;
      return studio.state.thumbMode && studio.state.thumbMode.worker === false ? 'server' : 'auto';
    };
    const have = new Set<string>(); // filenames on disk
    const failed = new Map<string, string>(); // key -> error
    const inflight = new Map<string, Promise<string | null>>();
    const queue: Waiter[] = [];
    const workers: { w: Worker; busy: boolean }[] = [];
    const stats = { rendered: 0, downloaded: 0, hits: 0, failed: 0, renderMs: 0 };
    let ready: Promise<void>;
    let mode: Promise<{ worker: boolean; type: string; ext: string }>;
    let mainRenderer: GlslopRenderer | null = null; // fallback when workers can't do WebGL2
    let mainBusy: Promise<unknown> = Promise.resolve();

    const keyOf = (s: CorpusShader) => `${s.id}-${fnv(s.isf).toString(36)}-${size()}`;
    const urlOf = (file: string) => studio.host.fileUrl('cache', `thumbs/${file}`);
    const fileFor = (key: string) => [...have].find((f) => f.startsWith(key + '.')) ?? null;

    // AVIF can't be decoded everywhere (WebKitGTK), and older builds cached server AVIFs: drop them.
    ready = studio.host.list(dir).then((es) => {
      for (const e of es) {
        if (e.dir) continue;
        if (/.avif$/i.test(e.name)) studio.host.remove(e.path).catch(() => {});
        else have.add(e.name);
      }
    }).catch(() => {});
    mode = (async () => {
      const probes: boolean[] = [];
      const [worker, enc] = await Promise.all([studio.settings.thumbWorkersOff ? false : workerGlSupported(probes), pickEncoding()]);
      studio.state.thumbMode = { worker, ...enc, probes };
      return { worker, ...enc };
    })();

    function worker() {
      const free = workers.find((x) => !x.busy);
      if (free) return free;
      if (workers.length >= (studio.settings.thumbWorkers ?? 2)) return null;
      const w = { w: new Worker(new URL('../engine/thumb-worker.ts', import.meta.url), { type: 'module' }), busy: false };
      workers.push(w);
      return w;
    }

    async function textureMap(isf: string): Promise<Record<string, string> | undefined> {
      const ids = textureSources(isf);
      if (!ids.length) return undefined;
      const map: Record<string, string> = {};
      const base = studio.state.corpus?.base ?? 'https://glslop.com';
      for (const id of ids) {
        const p = joinPath(texDir, `${id}.png`);
        if (!(await studio.host.exists(p))) {
          const r = await fetch(`${base}/posters/${encodeURIComponent(id)}.png`);
          if (r.ok) await studio.host.writeBytes(p, new Uint8Array(await r.arrayBuffer()));
        }
        map[id] = studio.host.fileUrl('cache', `textures/${id}.png`);
      }
      return map;
    }

    /** Same canonical poster semantics as the worker, on the main thread, serialized. */
    async function renderMain(s: CorpusShader, enc: { type: string }, textures?: Record<string, string>) {
      const run = async () => {
        const t0 = performance.now();
        if (!mainRenderer || mainRenderer.isContextLost()) {
          const c = document.createElement('canvas');
          mainRenderer = new GlslopRenderer(c);
        }
        const prevTex = runtimeConfig.textureUrl;
        runtimeConfig.textureUrl = textures ? (id) => textures[id] ?? `${runtimeConfig.posterBase}/posters/${id}.png` : prevTex;
        const r = mainRenderer.createSibling();
        try {
          await new Promise((res) => setTimeout(res, 0)); // let the UI breathe between compiles
          const res = await r.load(s.isf);
          const compileMs = Math.round(performance.now() - t0);
          if (!res.compileOk) return { ok: false, error: res.errors.join(' | '), compileMs };
          await renderPosterFrame(r, { width: size(), height: size(), time: 0.8 });
          const blob: Blob | null = await new Promise((res2) => (mainRenderer!.canvas as HTMLCanvasElement).toBlob(res2, enc.type, 0.86));
          if (!blob) return { ok: false, error: 'encode failed', compileMs };
          return { ok: true, bytes: await blob.arrayBuffer(), compileMs };
        } finally { r.dispose(); runtimeConfig.textureUrl = prevTex; }
      };
      const p = mainBusy.then(run, run);
      mainBusy = p.catch(() => {});
      return p;
    }

    function renderLocal(s: CorpusShader, key: string): Promise<{ ok: boolean; bytes?: ArrayBuffer; error?: string; compileMs?: number }> {
      return new Promise(async (resolve) => {
        const textures = await textureMap(s.isf).catch(() => undefined);
        const m = await mode;
        const enc = m;
        if (!m.worker) { resolve(await renderMain(s, enc, textures).catch((e) => ({ ok: false, error: String(e) }))); pump(); return; }
        const tryRun = () => {
          const w = worker();
          if (!w) { setTimeout(tryRun, 16); return; }
          w.busy = true;
          const onMsg = (e: MessageEvent) => {
            if (e.data?.id !== key) return;
            w.w.removeEventListener('message', onMsg);
            w.busy = false;
            if (e.data.error === 'context lost') { w.w.terminate(); workers.splice(workers.indexOf(w), 1); }
            resolve(e.data);
            pump();
          };
          w.w.addEventListener('message', onMsg);
          w.w.onerror = () => { w.w.removeEventListener('message', onMsg); w.busy = false; w.w.terminate(); workers.splice(workers.indexOf(w), 1); resolve({ ok: false, error: 'thumbnail worker crashed' }); pump(); };
          w.w.postMessage({ id: key, isf: s.isf, size: size(), time: 0.8, textures, type: enc.type, quality: 0.86 });
        };
        tryRun();
      });
    }

    async function download(s: CorpusShader): Promise<{ bytes: ArrayBuffer; ext: string } | null> {
      const base = studio.state.corpus?.base ?? 'https://glslop.com';
      // The PNG original always exists and every webview decodes it (WebKitGTK can't do AVIF).
      const r = await fetch(`${base}/posters/${encodeURIComponent(s.id)}.png`);
      if (!r.ok) return null;
      return { bytes: await r.arrayBuffer(), ext: 'png' };
    }

    async function produce(s: CorpusShader): Promise<string | null> {
      const key = keyOf(s);
      const m = await mode;
      let bytes: ArrayBuffer | undefined, ext = m.ext;
      const src = source(); // read after `mode` resolves so 'auto' knows the platform
      if (src !== 'server') {
        const t0 = performance.now();
        const r = await renderLocal(s, key);
        if (r.ok && r.bytes) {
          bytes = r.bytes; stats.rendered++; stats.renderMs += performance.now() - t0;
          if (typeof r.compileMs === 'number') studio.events.emit('thumbs:compiled', { id: s.id, compileMs: r.compileMs, backend: studio.host.boot.angleBackend });
        } else failed.set(key, r.error ?? 'render failed');
      }
      if (!bytes && src !== 'local') {
        const d = await download(s).catch(() => null);
        if (d) { bytes = d.bytes; ext = d.ext; stats.downloaded++; failed.delete(key); }
      }
      if (!bytes) { stats.failed++; return null; }
      const file = `${key}.${ext}`;
      await studio.host.writeBytes(joinPath(dir, file), new Uint8Array(bytes));
      have.add(file);
      // Drop stale variants for this id (source changed upstream or size changed).
      for (const f of [...have]) if (f.startsWith(s.id + '-') && f !== file) { have.delete(f); studio.host.remove(joinPath(dir, f)).catch(() => {}); }
      studio.events.emit('thumbs:ready', { id: s.id, url: urlOf(file) });
      return urlOf(file);
    }

    function pump() {
      queue.sort((a, b) => b.priority - a.priority);
      while (queue.length) {
        if (studio.state.thumbMode?.worker !== false && workers.length >= (studio.settings.thumbWorkers ?? 2) && workers.every((w) => w.busy) && source() !== 'server') return;
        const w = queue.shift()!;
        const s = studio.state.shader(w.id) as CorpusShader | undefined;
        if (!s) { w.resolve(null); continue; }
        const key = keyOf(s);
        let p = inflight.get(key);
        if (!p) {
          p = produce(s).finally(() => inflight.delete(key));
          inflight.set(key, p);
        }
        p.then(w.resolve, () => w.resolve(null));
      }
    }

    const api = {
      /** Cached URL right now, or null (never triggers work). */
      cached(id: string): string | null {
        const s = studio.state.shader(id) as CorpusShader | undefined;
        if (!s) return null;
        const f = fileFor(keyOf(s));
        if (f) stats.hits++;
        return f ? urlOf(f) : null;
      },
      failed(id: string): string | null {
        const s = studio.state.shader(id) as CorpusShader | undefined;
        return s ? failed.get(keyOf(s)) ?? null : null;
      },
      /** Ask for a thumbnail; resolves with a URL (or null). Higher priority goes first. */
      async request(id: string, priority = 0): Promise<string | null> {
        await ready;
        const hit = api.cached(id);
        if (hit) return hit;
        return new Promise((resolve) => { queue.push({ id, resolve, priority }); pump(); });
      },
      /** Drop a queued (not yet started) request — e.g. the card scrolled away. */
      cancel(id: string) {
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) { queue[i].resolve(null); queue.splice(i, 1); }
      },
      stats: () => ({ ...stats, cachedFiles: have.size, queued: queue.length, workers: workers.length, mode: source(), size: size(), renderer: studio.state.thumbMode ?? null }),
      ready: () => ready,
    };
    studio.state.thumbs = api;

    studio.tools.add({
      name: 'thumbs.prefetch',
      description: 'Render (or download, per settings.thumbSource) thumbnails for every listed shader not yet cached. Returns counts and timing.',
      input: { type: 'object', properties: { all: { type: 'boolean', description: 'include unlisted (superseded) versions' } } },
      async run(args: { all?: boolean }, ctx) {
        await ready;
        const t0 = performance.now();
        const rows: CorpusShader[] = (studio.state.corpus?.shaders ?? []).filter((s: CorpusShader) => args.all || s.listed);
        let done = 0;
        await Promise.all(rows.map((s) => api.request(s.id, -1).then(() => ctx.progress(`thumbnails ${++done}/${rows.length}`, done / rows.length))));
        return { shaders: rows.length, seconds: +((performance.now() - t0) / 1000).toFixed(1), ...api.stats() };
      },
    });

    studio.tools.add({
      name: 'thumbs.stats',
      description: 'Thumbnail cache counters: rendered locally, downloaded, failed, cache hits, queue.',
      run: () => api.stats(),
    });

    studio.tools.add({
      name: 'thumbs.clear',
      description: 'Delete every cached thumbnail (they re-render on demand).',
      async run() {
        await studio.host.remove(dir).catch(() => {});
        have.clear(); failed.clear();
        studio.events.emit('thumbs:cleared');
        return { cleared: true };
      },
    });

    // Moderated-away shaders lose their thumbnails too.
    const off = studio.events.on('corpus:removed', (ids: string[]) => {
      for (const f of [...have]) if (ids.some((id) => f.startsWith(id + '-'))) { have.delete(f); studio.host.remove(joinPath(dir, f)).catch(() => {}); }
    });
    return () => { off(); workers.forEach((w) => w.w.terminate()); };
  },
};
export default mod;

function fnv(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
