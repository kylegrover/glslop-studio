<script lang="ts">
  import { onMount } from 'svelte';
  import type { Studio } from '../studio/api';
  let { studio }: { studio: Studio } = $props();

  const boot = studio.host.boot;
  let backend = $state(studio.settings.angleBackend ?? boot.angleBackend);
  let noCache = $state(!!studio.settings.disableGpuCache);
  let env = $state<any>(null);
  let mods = $state<any[]>([]);
  let tools = $state<any[]>([]);
  let thumbSource = $state(studio.settings.thumbSource ?? 'auto');
  let hoverPlay = $state(studio.settings.hoverPlay !== false);
  let autoSync = $state(studio.settings.autoSync !== false);
  let syncMin = $state(studio.settings.syncIntervalMin ?? 15);
  let stats = $state<any>(null);
  async function setSetting(k: string, v: unknown) { studio.settings[k] = v; await studio.saveSettings(); }
  async function refreshStats() {
    const c = studio.state.corpus;
    stats = { corpus: { shaders: c?.shaders.length ?? 0, listed: c?.shaders.filter((s: any) => s.listed).length ?? 0, syncedAt: c?.syncedAt }, thumbs: await studio.call('thumbs.stats'), liveCompiledInMemory: studio.state.live?.size() };
  }

  const refreshMods = async () => {
    mods = (await studio.call('mods.list')).mods;
    tools = studio.tools.list().map((t) => ({ name: t.name, source: t.source, hidden: t.hidden }));
  };
  onMount(() => {
    studio.call('gpu.env').then((e) => (env = e));
    refreshStats();
    refreshMods();
    const offs = [studio.events.on('mods:changed', refreshMods), studio.events.on('tools:changed', refreshMods)];
    return () => offs.forEach((o) => o());
  });

  async function applyBackend() {
    studio.settings.angleBackend = backend;
    studio.settings.disableGpuCache = noCache;
    await studio.saveSettings();
    await studio.host.relaunch();
  }
  async function toggle(m: any) {
    await studio.call(m.enabled ? 'mods.disable' : 'mods.enable', { id: m.id, persist: true });
    refreshMods();
  }
</script>

<div class="settings">
  <h2>graphics backend</h2>
  <p class="muted">ANGLE translates WebGL to a native API. Chrome on Windows defaults to D3D11, where FXC makes heavy shaders take
    seconds to minutes to compile. Vulkan (and desktop GL) skip FXC. Changing this relaunches the app. Windows only; macOS always uses Metal.</p>
  <div class="row">
    <select bind:value={backend} disabled={boot.platform !== 'windows'}>
      {#if boot.platform !== 'windows'}<option value={boot.angleBackend}>{boot.angleBackend}</option>{/if}
      <option value="vulkan">vulkan</option>
      <option value="d3d11">d3d11 (what Chrome/Edge use on Windows)</option>
      <option value="gl">gl (desktop OpenGL)</option>
      <option value="d3d9">d3d9</option>
      <option value="default">webview default</option>
    </select>
    <label><input type="checkbox" bind:checked={noCache} /> disable GPU shader disk cache (honest cold timings)</label>
    <button onclick={applyBackend}>apply + relaunch</button>
  </div>
  <p class="muted">Also: env <code>GLSLOP_ANGLE=d3d11</code> / <code>GLSLOP_NO_GPU_CACHE=1</code> override for one launch.</p>
  {#if env}<pre class="env">{JSON.stringify(env, null, 2)}</pre>{/if}

  <h2>data + caching</h2>
  <p class="muted">Thumbnails render locally on your GPU (a cold Vulkan compile is a few ms), so glslop.com only serves
    the slim shader list on sync, plus source once per new shader. Nothing else.</p>
  <div class="row">
    <label>thumbnails
      <select bind:value={thumbSource} onchange={() => setSetting('thumbSource', thumbSource)}>
        <option value="auto">render locally, download poster only if it fails</option>
        <option value="local">render locally only</option>
        <option value="server">download posters from glslop.com</option>
      </select></label>
    <label><input type="checkbox" bind:checked={hoverPlay} onchange={() => setSetting('hoverPlay', hoverPlay)} /> play on hover</label>
    <label><input type="checkbox" bind:checked={autoSync} onchange={() => setSetting('autoSync', autoSync)} /> sync on launch</label>
    <label>min between syncs <input type="number" min="0" style="width:60px" bind:value={syncMin} onchange={() => setSetting('syncIntervalMin', +syncMin)} /></label>
  </div>
  <div class="row">
    <button onclick={() => studio.call('corpus.sync', { force: true }, { caller: 'ui' }).then(refreshStats)}>sync now</button>
    <button onclick={() => studio.call('thumbs.prefetch', {}, { caller: 'ui' }).then(refreshStats)}>render all thumbnails</button>
    <button onclick={() => studio.call('thumbs.clear', {}, { caller: 'ui' }).then(refreshStats)}>clear thumbnails</button>
  </div>
  {#if stats}<pre class="env">{JSON.stringify(stats, null, 2)}</pre>{/if}

  <h2>paths</h2>
  <table><tbody>
    {#each Object.entries(boot.paths) as [k, v]}
      <tr><td>{k}</td><td><code>{v}</code></td><td><button onclick={() => studio.host.open(v)}>open</button></td></tr>
    {/each}
  </tbody></table>

  <h2>agent bridge</h2>
  {#if boot.bridgeUrl}
    <p>Listening on <code>{boot.bridgeUrl}</code>. Token + URL are in <code>{boot.paths.bridgeFile}</code>. See docs/AGENT-API.md, or run
      <code>node bin/glslop-studio-mcp.mjs</code> as an MCP server.</p>
  {:else}<p class="muted">Not available in browser mode.</p>{/if}

  <h2>mods</h2>
  <p class="muted">Drop <code>name.js</code> or <code>name/index.js</code> into the mods folder, then reload. Core features are mods too, and can be disabled.</p>
  <div class="row">
    <button onclick={() => studio.host.open(boot.paths.mods)}>open mods folder</button>
    <button onclick={() => studio.call('mods.reload').then(refreshMods)}>reload user mods</button>
  </div>
  <table><tbody>
    {#each mods as m (m.id)}
      <tr>
        <td><b>{m.id}</b></td><td>{m.kind}</td><td>{m.description ?? ''}</td>
        <td><button onclick={() => toggle(m)}>{m.enabled ? 'disable' : 'enable'}</button></td>
      </tr>
      {#if m.error}<tr><td colspan="4"><pre class="err">{m.error}</pre></td></tr>{/if}
    {/each}
  </tbody></table>

  <h2>tools ({tools.length})</h2>
  <div class="tools">
    {#each tools as t (t.name)}<span class="tool" class:hidden={t.hidden} title={t.source}>{t.name}</span>{/each}
  </div>
</div>

<style>
  .settings { padding: 10px 14px; max-width: 980px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
  .env { font-size: 11px; background: var(--paper); border: 2px solid var(--line); padding: 6px; }
  table { border-collapse: collapse; font-size: 12px; }
  td { border: 1px solid var(--line); padding: 2px 8px; }
  .err { color: var(--warn); font-size: 11px; white-space: pre-wrap; margin: 0; }
  .tools { display: flex; flex-wrap: wrap; gap: 4px; font-size: 12px; }
  .tool { border: 1px solid var(--line); padding: 1px 6px; background: var(--paper); }
  .tool.hidden { opacity: 0.5; }
</style>
