// Core mod: live hover playback. One GL context + one canvas, moved into whichever card is hovered.
// Compiled renderers are kept in an LRU (settings.liveCacheSize, default 24), so re-hovering a card
// resumes instantly with its own clock and feedback state. On Vulkan a cold compile is ~5-90 ms, so
// there is no clip/worker dance like glslop.com needs for D3D11 — just compile and play.
//
// "Saving compilations for later": within a session the LRU keeps linked programs alive. Across
// launches Chromium's GPU program cache (in the webview profile) stores the linked binaries keyed by
// source, so a second-launch compile of the same shader is a cache hit. Studio timing tools append a
// nonce to defeat that cache on purpose; playback deliberately doesn't.
import type { Studio, StudioMod } from '../studio/api';
import { GlslopRenderer } from '@glslop/core/runtime';

interface Entry { id: string; r: GlslopRenderer; elapsed: number; feedback: boolean; w: number; h: number }

const mod: StudioMod = {
  description: 'Hover-to-play: one shared GL context, an LRU of compiled shaders.',
  activate(studio: Studio) {
    const canvas = document.createElement('canvas');
    canvas.className = 'live-hover';
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;z-index:1;';
    let owner: GlslopRenderer | null = null;
    const lru = new Map<string, Entry>();
    let active: Entry | null = null;
    let raf = 0, began = 0, token = 0;

    const cap = () => studio.settings.liveCacheSize ?? 24;
    const ensureOwner = () => {
      if (!owner || owner.isContextLost()) {
        for (const e of lru.values()) try { e.r.dispose(); } catch { /* context gone */ }
        lru.clear();
        owner = new GlslopRenderer(canvas);
      }
      return owner;
    };

    function stop() {
      token++;
      cancelAnimationFrame(raf);
      if (active) { active.elapsed = (performance.now() - began) / 1000; }
      active = null;
      canvas.remove();
    }

    async function play(id: string, frame: HTMLElement): Promise<{ ok: boolean; compileMs?: number; cached?: boolean; error?: string }> {
      stop();
      const t = token;
      const s = studio.state.shader(id);
      if (!s) return { ok: false, error: 'unknown shader' };
      const o = ensureOwner();
      let e = lru.get(id);
      let compileMs: number | undefined;
      const cached = !!e;
      if (!e) {
        const r = o.createSibling();
        const t0 = performance.now();
        const res = await r.load(s.isf);
        compileMs = Math.round(performance.now() - t0);
        if (!res.compileOk) { r.dispose(); return { ok: false, error: res.errors.join('\n'), compileMs }; }
        e = { id, r, elapsed: 0, feedback: r.hasFeedback(), w: 0, h: 0 };
        lru.set(id, e);
        while (lru.size > cap()) {
          const [oldId, old] = lru.entries().next().value!;
          if (old === active) break;
          old.r.dispose(); lru.delete(oldId);
        }
        studio.events.emit('live:compiled', { id, compileMs, backend: studio.host.boot.angleBackend });
      } else { lru.delete(id); lru.set(id, e); }
      if (t !== token) return { ok: true, compileMs, cached };
      const rect = frame.getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
      o.resize(w, h);
      if (e.w !== w || e.h !== h) { if (e.feedback && e.w) { e.r.resetFeedback(); e.elapsed = 0; } e.w = w; e.h = h; }
      if (getComputedStyle(frame).position === 'static') frame.style.position = 'relative';
      frame.append(canvas);
      active = e;
      began = performance.now() - e.elapsed * 1000;
      const loop = () => {
        if (t !== token || active !== e) return;
        try { e!.r.draw((performance.now() - began) / 1000); }
        catch (err) { stop(); return; }
        raf = requestAnimationFrame(loop);
      };
      loop();
      return { ok: true, compileMs, cached };
    }

    /** The frame the hover is showing right now for `id`, and its clock, or null if it isn't playing.
     *  Opening a shader hands this to the stage so the open animation continues from exactly what
     *  you were looking at. The context keeps its drawing buffer, so this is the last drawn frame. */
    function snapshot(id: string): { url: string; elapsed: number } | null {
      if (!active || active.id !== id || !canvas.isConnected) return null;
      try { return { url: canvas.toDataURL('image/jpeg', 0.92), elapsed: (performance.now() - began) / 1000 }; }
      catch { return null; }
    }

    studio.state.live = { play, stop, snapshot, cached: (id: string) => lru.has(id), size: () => lru.size };
    const offs = [
      studio.events.on('view:mounted', stop),
      studio.events.on('corpus:removed', (ids: string[]) => { for (const id of ids) { const e = lru.get(id); if (e) { e.r.dispose(); lru.delete(id); } } }),
    ];
    const vis = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', vis);
    return () => {
      stop(); offs.forEach((o) => o()); document.removeEventListener('visibilitychange', vis);
      for (const e of lru.values()) e.r.dispose();
      owner?.dispose();
    };
  },
};
export default mod;
