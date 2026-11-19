<script lang="ts">
  import { onMount } from 'svelte';
  import type { Studio } from '../studio/api';
  import { fmtMs, speedClass } from './format';

  let { studio }: { studio: Studio } = $props();
  const backend = studio.host.boot.angleBackend;
  let summary = $state<any>(null);
  let running = $state(!!studio.state.benchRunning);
  let log = $state<{ id: string; title: string; ms: number; ok: boolean; ref?: number }[]>([]);
  let total = $state(0);

  const refresh = async () => { summary = await studio.call('bench.summary', { backend }, { caller: 'ui' }).catch(() => null); };

  onMount(() => {
    refresh();
    const offs = [
      studio.events.on('bench:start', ({ total: t }) => { running = true; total = t; log = []; }),
      studio.events.on('bench:result', (r) => {
        const s = studio.state.corpus.shaders.find((x: any) => x.id === r.id);
        log = [{ id: r.id, title: s?.title ?? r.id, ms: r.compile_ms, ok: r.ok, ref: s?.ref_compile_ms }, ...log].slice(0, 400);
      }),
      studio.events.on('bench:end', () => { running = false; refresh(); }),
    ];
    return () => offs.forEach((o) => o());
  });

  const run = (force = false) => studio.call('bench.corpus', { force }, { caller: 'ui' }).then(refresh);
</script>

<div class="bench">
  <h2>compile bench · {backend}</h2>
  <p class="muted">Compiles every corpus shader cold on this backend and compares with reference times measured through
    ANGLE → D3D11 → FXC (what Chrome uses on Windows) on an RTX 3090. Switch backend in <a href="#settings" onclick={(e) => { e.preventDefault(); studio.views.open('settings'); }}>settings</a> and run again to compare.</p>
  <div class="row">
    {#if running}
      <button onclick={() => studio.call('bench.stop')}>stop</button>
      <span>{log.length} / {total}</span>
    {:else}
      <button onclick={() => run(false)}>run (unmeasured only)</button>
      <button onclick={() => run(true)}>re-run all</button>
    {/if}
  </div>

  {#if summary && summary.measured}
    <table>
      <thead><tr><th></th><th>p50</th><th>p90</th><th>max</th><th>total</th><th>&gt;1s</th></tr></thead>
      <tbody>
        <tr><td>{backend} (here)</td><td>{fmtMs(summary.local.p50)}</td><td>{fmtMs(summary.local.p90)}</td><td>{fmtMs(summary.local.max)}</td><td>{summary.local.total_s}s</td><td>{summary.over_1s.local}</td></tr>
        <tr><td>d3d11 reference</td><td>{fmtMs(summary.reference_d3d11_same_shaders.p50)}</td><td>{fmtMs(summary.reference_d3d11_same_shaders.p90)}</td><td>{fmtMs(summary.reference_d3d11_same_shaders.max)}</td><td>{summary.reference_d3d11_same_shaders.total_s}s</td><td>{summary.over_1s.reference}</td></tr>
      </tbody>
    </table>
    <p><b>{summary.speedup_total ?? '?'}×</b> total speedup over {summary.measured} measured shaders ({summary.failed} failed to compile). CSV: <code>{summary.csv}</code></p>
    <h3>slowest on the reference path</h3>
    <table>
      <thead><tr><th>shader</th><th>d3d11 ref</th><th>{backend}</th><th>×</th></tr></thead>
      <tbody>
        {#each summary.slowest_reference as r}
          <tr onclick={() => studio.views.open('shader', { id: r.id })} class="click">
            <td>{r.title}</td><td class={speedClass(r.ref_ms)}>{fmtMs(r.ref_ms)}</td><td class={speedClass(r.local_ms)}>{fmtMs(r.local_ms)}</td><td>{(r.ref_ms / Math.max(1, r.local_ms)).toFixed(0)}×</td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if summary.failures.length}
      <h3>failed here</h3>
      {#each summary.failures as f}<div class="fail"><b>{f.title}</b> <span class="muted">{f.id}</span><br /><code>{f.error}</code></div>{/each}
    {/if}
  {/if}

  {#if log.length}
    <h3>live</h3>
    <div class="log">
      {#each log as l (l.id)}
        <div><span class="chip {l.ok ? speedClass(l.ms) : 'bad'}">{l.ok ? fmtMs(l.ms) : 'fail'}</span> <span class="muted">ref {fmtMs(l.ref)}</span> {l.title}</div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .bench { padding: 10px 14px; max-width: 980px; }
  .row { display: flex; gap: 6px; align-items: center; margin: 8px 0; }
  table { border-collapse: collapse; margin: 6px 0; font-size: 12px; }
  td, th { border: 1px solid var(--line); padding: 2px 8px; text-align: left; }
  tr.click { cursor: pointer; }
  tr.click:hover { background: var(--slime); }
  .log { font-size: 12px; max-height: 40vh; overflow: auto; }
  .fail { font-size: 12px; margin: 4px 0; }
</style>
