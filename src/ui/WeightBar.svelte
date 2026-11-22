<script lang="ts">
  // Three gauges under a shader: fps (live), desktop and browser compile-to-first-frame. The browser
  // gauge is what glslop.com visitors on Windows Chrome pay (d3d11/FXC), with the 500 ms autoplay bar
  // marked. Bars use a log scale: 10 ms … 30 s.
  import type { Studio } from '../studio/api';
  import { fmtMs } from './format';

  interface Cost { ms: number | null; ok: boolean; kind: string; backend: string; note?: string }
  let { studio, fps, desktop, browser, busy, full = true }: { studio: Studio; fps: number; desktop: Cost | null; browser: Cost | null; busy: { desktop: boolean; browser: boolean }; full?: boolean } = $props();

  const AUTOPLAY = 500;
  const pos = (ms: number) => Math.max(0, Math.min(1, (Math.log10(Math.max(ms, 10)) - 1) / (Math.log10(30_000) - 1)));
  const msClass = (ms: number | null | undefined) => ms == null ? '' : ms < AUTOPLAY ? 'good' : ms < 2000 ? 'meh' : 'bad';
  const fpsClass = (f: number) => f >= 55 ? 'good' : f >= 30 ? 'meh' : 'bad';
  const label = (c: Cost | null, isBusy: boolean) => isBusy && !c ? 'measuring…' : !c ? '—' : c.ms == null ? (c.ok ? '—' : 'failed') : `${c.kind === 'estimate' || c.kind === 'off' ? '~' : ''}${fmtMs(c.ms)}`;
  const browserTitle = $derived(browser?.kind === 'measured'
    ? `measured on ANGLE d3d11 + FXC (Chrome's default on Windows), cold, through the first frame. glslop.com autoplays under ${AUTOPLAY} ms.${browser.note ? ' ' + browser.note : ''}`
    : `${browser?.note ?? 'estimate'}. glslop.com autoplays under ${AUTOPLAY} ms.`);
</script>

<div class="weight" class:only-fps={!full}>
  <div class="g" title="frames per second at this size, right now">
    <span class="k">fps</span>
    <div class="track"><div class="fill {fpsClass(fps)}" style="width:{Math.min(100, (fps / 60) * 100)}%"></div></div>
    <span class="v {fpsClass(fps)}">{fps || '—'}</span>
  </div>
  {#if full}
  <div class="g" title="cold compile through the first frame in the studio ({studio.host.boot.angleBackend})">
    <span class="k">desktop</span>
    <div class="track"><div class="fill {msClass(desktop?.ms)}" class:pulse={busy.desktop} style="width:{desktop?.ms != null ? pos(desktop.ms) * 100 : 0}%"></div></div>
    <span class="v {msClass(desktop?.ms)}">{label(desktop, busy.desktop)}</span>
  </div>
  <div class="g" title={browserTitle}>
    <span class="k">browser</span>
    <div class="track">
      <div class="fill {msClass(browser?.ms)}" class:est={browser?.kind !== 'measured'} class:pulse={busy.browser} style="width:{browser?.ms != null ? pos(browser.ms) * 100 : 0}%"></div>
      <div class="mark" style="left:{pos(AUTOPLAY) * 100}%"></div>
    </div>
    <span class="v {msClass(browser?.ms)}">{busy.browser && browser ? '… ' : ''}{label(browser, busy.browser)}{browser && browser.kind !== 'measured' && browser.kind !== 'error' ? ' est' : ''}</span>
  </div>
  {/if}
</div>

<style>
  .weight.only-fps { grid-template-columns: minmax(0, 1fr); max-width: 260px; }
  .weight { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px 12px; margin-top: 8px; padding: 5px 8px; background: var(--paper); border: 2px solid var(--line); box-shadow: 3px 3px 0 rgba(0,0,0,.25); font-size: 11px; }
  .g { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 6px; min-width: 0; cursor: help; }
  .k { text-transform: uppercase; letter-spacing: 1px; font-size: 10px; opacity: .75; }
  .track { position: relative; height: 9px; background: #e6e4d8; border: 1px solid var(--line); }
  .fill { position: absolute; left: 0; top: 0; bottom: 0; background: #999; transition: width .25s ease; }
  .fill.good { background: #2fbf4a; } .fill.meh { background: #e8b400; } .fill.bad { background: var(--warn, #d33); }
  .fill.est { opacity: .55; background-image: repeating-linear-gradient(45deg, transparent 0 3px, rgba(255,255,255,.5) 3px 6px); }
  .fill.pulse { animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  .mark { position: absolute; top: -3px; bottom: -3px; width: 2px; background: #000; }
  .v { font-variant-numeric: tabular-nums; white-space: nowrap; min-width: 52px; text-align: right; }
  .v.bad { color: var(--warn, #d33); font-weight: bold; }
</style>
