<script lang="ts">
  import { onMount } from 'svelte';
  import type { Studio } from '../studio/api';
  import { updateChannel } from '../core/updates';
  let { studio }: { studio: Studio } = $props();

  const boot = studio.host.boot;
  let backend = $state(studio.settings.angleBackend ?? boot.angleBackend);
  let noCache = $state(!!studio.settings.disableGpuCache);
  let env = $state<any>(null);
  let mods = $state<any[]>([]);
  let tools = $state<any[]>([]);
  let thumbSource = $state(studio.settings.thumbSource ?? 'auto');
  let hoverPlay = $state(studio.settings.hoverPlay !== false);
  let browserProbe = $state(studio.settings.browserProbe !== false);
  async function setProbe() { await setSetting('browserProbe', browserProbe); if (!browserProbe) await studio.state.weight?.stopProbe?.(); }
  let autoSync = $state(studio.settings.autoSync !== false);
  let syncMin = $state(studio.settings.syncIntervalMin ?? 15);
  let stats = $state<any>(null);
  // updates: the checkbox shows the channel in effect (a beta build follows betas unless told not to)
  let autoUpdate = $state(studio.settings.autoUpdate !== false);
  let betaUpdates = $state(updateChannel(studio.settings, studio.version) === 'beta');
  let dailyCount = $state(studio.settings.dailyCount !== false);
  let updBusy = $state(false);
  let updMsg = $state<string | null>(null);
  async function checkNow(install = false) {
    updBusy = true; updMsg = install ? 'downloading…' : 'checking…';
    try {
      const r = await studio.call('app.checkUpdate', { install }, { caller: 'ui' });
      updMsg = r.note === 'browser mode' ? 'updates need the desktop app'
        : r.available ? `v${r.version} is available (${r.channel})` : `you're up to date (${r.channel})`;
      updAvailable = !!r.available;
    } catch (e) { updMsg = 'check failed: ' + (e as Error).message; }
    finally { updBusy = false; }
  }
  let updAvailable = $state(!!studio.state.update);
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

  <h2>shader weight</h2>
  <p class="muted">Under every shader: fps, plus how long a cold compile takes to reach the first frame here (desktop) and in
    Chrome on Windows (browser). glslop.com autoplays shaders whose browser number is under 500 ms.</p>
  <div class="row">
    <label><input type="checkbox" bind:checked={browserProbe} onchange={setProbe} disabled={boot.platform !== 'windows'} />
      measure the browser number for real (Windows: a hidden background window running Chrome's D3D11 compiler,
      started on first use, closed after 5 idle minutes). Off, or on Mac/Linux: a static estimate from the source.</label>
  </div>

  <h2>data + caching</h2>
  {#if studio.state.thumbMode?.worker === false}
    <p class="muted">Thumbnails are downloaded from glslop.com here (this system's webview can't render them in the
      background), and only the shader under the mouse plays live. Sync still fetches just the slim shader list plus
      source once per new shader.</p>
  {:else}
    <p class="muted">Thumbnails render locally on your GPU (a few ms each{boot.angleBackend === 'vulkan' ? ' on Vulkan' : ''}), so glslop.com
      only serves the slim shader list on sync, plus source once per new shader. Nothing else.</p>
  {/if}
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

  <h2>updates</h2>
  <p class="muted">You have <b>v{studio.version}</b>. The app looks for a new version at launch and every few hours while it's open,
    and shows an update button in the header. Nothing is downloaded until you click.</p>
  <div class="row">
    <button onclick={() => checkNow(false)} disabled={updBusy}>check for updates</button>
    {#if updAvailable}<button onclick={() => checkNow(true)} disabled={updBusy}>install + restart</button>{/if}
    {#if updMsg}<span>{updMsg}</span>{/if}
  </div>
  <div class="row">
    <label><input type="checkbox" bind:checked={autoUpdate} onchange={() => setSetting('autoUpdate', autoUpdate)} /> check automatically</label>
    <label><input type="checkbox" bind:checked={betaUpdates} onchange={() => setSetting('betaUpdates', betaUpdates)} /> beta updates (early builds, may be rough)</label>
    <label title="The first update check of each day tells glslop.com this version and OS, so it can count how many copies are in use. No install id, no account, nothing about what you do in the app."><input type="checkbox" bind:checked={dailyCount} onchange={() => setSetting('dailyCount', dailyCount)} /> send daily usage count</label>
  </div>
  <p class="muted">Daily usage count: once a day the update check also sends this app's version and OS ("{studio.version}, {studio.host.boot.platform}"), and glslop.com adds one to that day's count. No id, no account, nothing about what you do here.</p>

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
