// Core mod: how heavy is this shader? Three numbers, shown as gauges under every shader stage and
// returned to agents with every compile:
//
//   fps      the live render loop (measured by the stage itself)
//   desktop  cold compile through the first drawn frame on the studio's own backend
//   browser  the same, on ANGLE D3D11 + FXC: what glslop.com visitors on Windows Chrome pay. Measured
//            in a hidden probe window (src/probe.ts) on Windows; elsewhere it's the advisor's estimate,
//            labelled as such. glslop.com autoplays shaders under 500 ms.
//
// Tools: weight.measure (both compile numbers for a source), weight.probe (browser only).
// Settings: browserProbe (default true; false = estimate only, no background window).
import type { Studio, StudioMod } from '../studio/api';
import { loopBudget } from '@glslop/core/budget';
import { coldCopy } from '../engine/cold';

export const AUTOPLAY_MS = 500;
const PROBE_TIMEOUT_MS = 120_000; // past this, kill the probe window rather than wait forever
const PROBE_IDLE_MS = 5 * 60_000; // close the probe window after this long unused

export interface CostMeasure { ms: number | null; ok: boolean; kind: 'measured' | 'estimate' | 'off' | 'error'; backend: string; note?: string; errors?: string[] }

/** The advisor's static estimate, as a rough millisecond band (calibrated on FXC). */
export function estimateBrowserMs(isf: string): number {
  const n = loopBudget(isf).inlined;
  // Corpus fit, deliberately coarse: 400 statements ≈ 500 ms, 1000 ≈ a few s, 4000+ ≈ 10 s+.
  return Math.round(Math.max(30, 0.0009 * n * n + 0.4 * n));
}

const mod: StudioMod = {
  description: 'Shader weight: fps, desktop and browser (d3d11) compile-to-first-frame, as gauges and tool results.',
  activate(studio: Studio) {
    const host = studio.host;
    const windows = host.kind === 'tauri' && host.boot.platform === 'windows';
    const enabled = () => windows && studio.settings.browserProbe !== false;

    // ---- the probe window: started lazily, one job at a time, closed when idle
    let probeUp: Promise<boolean> | null = null;
    let probeRenderer = '';
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const waiting = new Map<string, (r: any) => void>();
    const offs: Array<() => void> = [];
    let listening: Promise<void> | null = null;

    const listenOnce = () => (listening ??= (async () => {
      offs.push(await host.listen!('probe:result', (r: any) => { waiting.get(r.id)?.(r); waiting.delete(r.id); }));
    })());

    async function startProbe(): Promise<boolean> {
      await listenOnce();
      return (probeUp ??= (async () => {
        const ready = new Promise<boolean>((resolve) => {
          let off: (() => void) | undefined;
          const t = setTimeout(() => { off?.(); resolve(false); }, 20_000);
          host.listen!('probe:ready', (p: any) => { probeRenderer = p?.renderer ?? ''; clearTimeout(t); off?.(); resolve(true); }).then((o) => (off = o));
        });
        const how = await host.invoke!('probe_start');
        if (how === 'unsupported') return false;
        if (how === 'existing') void (await import('@tauri-apps/api/event')).emitTo('probe', 'probe:ping');
        const ok = await ready;
        if (!ok) probeUp = null;
        return ok;
      })());
    }
    async function stopProbe() {
      probeUp = null;
      clearTimeout(idleTimer);
      await host.invoke?.('probe_stop').catch(() => {});
      for (const [, done] of waiting) done({ ok: false, ms: null, errors: ['probe stopped'] });
      waiting.clear();
    }
    const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => void stopProbe(), PROBE_IDLE_MS); };

    let seq = 0;
    let queue = Promise.resolve();
    const latest = new Map<string, number>(); // per caller key: only the newest request is worth running

    /** Time a cold compile + first frame on d3d11. Requests with the same `key` replace older ones. */
    async function probe(isf: string, key = 'default'): Promise<CostMeasure> {
      if (!enabled()) return { ms: estimateBrowserMs(isf), ok: true, kind: windows ? 'off' : 'estimate', backend: 'd3d11', note: windows ? 'browser probe is off in settings: this is the static estimate' : 'no d3d11 on this OS: this is the static estimate from the source' };
      const mine = ++seq;
      latest.set(key, mine);
      const run = queue.then(async (): Promise<CostMeasure> => {
        if (latest.get(key) !== mine) return { ms: null, ok: false, kind: 'error', backend: 'd3d11', note: 'superseded' };
        if (!(await startProbe())) return { ms: estimateBrowserMs(isf), ok: true, kind: 'estimate', backend: 'd3d11', note: 'probe window failed to start: estimate' };
        touch();
        const id = `p${mine}`;
        const res = await new Promise<any>((resolve) => {
          waiting.set(id, resolve);
          const t = setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); resolve({ ok: false, ms: PROBE_TIMEOUT_MS, timedOut: true, errors: ['still compiling after 2 min'] }); } }, PROBE_TIMEOUT_MS);
          import('@tauri-apps/api/event').then(({ emitTo }) => emitTo('probe', 'probe:job', { id, isf })).catch((e) => { clearTimeout(t); waiting.delete(id); resolve({ ok: false, ms: null, errors: [String(e)] }); });
        });
        if (res.timedOut) await stopProbe(); // the window is stuck inside FXC; start fresh next time
        touch();
        return { ms: res.ms ?? null, ok: !!res.ok, kind: res.ok || res.timedOut ? 'measured' : 'error', backend: 'd3d11', errors: res.errors?.length ? res.errors : undefined, note: res.timedOut ? 'over 2 minutes (stopped waiting)' : probeRenderer || undefined };
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    }

    /** Cold compile + first frame on the studio's own backend, in a throwaway context. */
    async function desktop(isf: string): Promise<CostMeasure> {
      const backend = host.boot.angleBackend;
      const GlslopRenderer = studio.state.gl?.GlslopRenderer;
      if (!GlslopRenderer) return { ms: null, ok: false, kind: 'error', backend, note: 'gl mod not loaded' };
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      const r = new GlslopRenderer(canvas);
      try {
        const t0 = performance.now();
        const res = await r.load(coldCopy(isf));
        if (!res.compileOk) return { ms: Math.round(performance.now() - t0), ok: false, kind: 'error', backend, errors: res.errors };
        r.draw(1.0);
        r.finish();
        return { ms: Math.round(performance.now() - t0), ok: true, kind: 'measured', backend };
      } finally { r.dispose(); }
    }

    studio.state.weight = { probe, desktop, estimateBrowserMs, AUTOPLAY_MS, enabled, stopProbe };
    if (studio.settings.browserProbe === undefined) studio.settings.browserProbe = true;

    const SRC = { isf: { type: 'string' }, path: { type: 'string' }, id: { type: 'string' } };
    const sourceOf = async (a: any): Promise<string> => a.isf ?? (a.path ? await host.readText(a.path) : a.id ? studio.state.shader(a.id)?.isf : studio.state.viewer?.source) ?? '';

    studio.tools.add({
      name: 'weight.measure',
      description: 'How heavy is a shader? Cold compile through the first frame on the desktop backend, and on d3d11 (what glslop.com visitors on Windows Chrome pay; glslop.com autoplays under 500 ms). Defaults to the shader in the viewer.',
      input: { type: 'object', properties: SRC },
      async run(a: any) {
        const isf = await sourceOf(a);
        if (!isf) throw new Error('no source: pass isf, path or id, or open a shader');
        const [d, b] = await Promise.all([desktop(isf), probe(isf, 'tool')]);
        return { desktop: d, browser: b, autoplay_ms: AUTOPLAY_MS, browser_autoplays: b.ms !== null && b.ms < AUTOPLAY_MS };
      },
    });
    studio.tools.add({
      name: 'weight.probe',
      description: 'Browser (d3d11) cold compile + first frame only. See weight.measure.',
      input: { type: 'object', properties: SRC },
      async run(a: any) { return probe(await sourceOf(a), 'tool'); },
    });

    return () => { offs.forEach((o) => o()); void stopProbe(); };
  },
};
export default mod;
