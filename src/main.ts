// Boot order — every step is visible and overridable:
//  1. host (Tauri or browser), settings.json
//  2. window.studio = the Studio object (global on purpose: devtools, eval, mods)
//  3. core mods (src/core/*) — skip any via settings.disabledMods ["core:<name>"]
//  4. user mods (~/.glslop-studio/mods/*)
//  5. the shell UI (or studio.state.mountShell if a mod replaced it)
//  6. the agent bridge
import '@glslop/ui/brutal.css';
import './ui/app.css';
import { mount } from 'svelte';
import { Studio, type StudioMod } from './studio/api';
import { initHost } from './studio/host';
import { loadCoreMods, loadUserMods, registerModTools } from './studio/mods';
import { startBridge } from './studio/bridge';
import { runtimeConfig } from '@glslop/core/runtime';
import Shell from './ui/Shell.svelte';
import corpus from './core/corpus';
import gl from './core/gl';
import bench from './core/bench';
import advisor from './core/advisor';
import views from './core/views';
import thumbs from './core/thumbs';
import live from './core/live';
import account from './core/account';

/** Core mods, in activation order. Exported on window.studio.coreMods for inspection/reload. */
const CORE: Record<string, StudioMod> = { corpus, gl, thumbs, live, bench, advisor, account, views };

async function boot() {
  const bootT0 = performance.now();
  const host = await initHost();
  document.documentElement.classList.add(`os-${host.boot.platform}`); // e.g. os-linux, for platform CSS
  const studio = new Studio();
  (window as any).studio = studio;
  (studio as any).coreMods = CORE;
  try { studio.settings = JSON.parse(await host.readText(host.paths.settings)); } catch { studio.settings = {}; }
  runtimeConfig.posterBase = studio.settings.glslopBase ?? 'https://glslop.com';

  registerModTools(studio, CORE);
  await loadCoreMods(studio, CORE);
  await loadUserMods(studio);
  studio.events.emit('studio:ready', studio);

  const target = document.getElementById('app')!;
  if (typeof studio.state.mountShell === 'function') studio.state.mountShell(target, studio);
  else mount(Shell, { target, props: { studio } });
  await startBridge(studio);
  studio.state.bootMs = Math.round(performance.now() - bootT0);
}

boot().catch((e) => {
  document.body.innerHTML = `<pre style="color:#ff3b1f;padding:12px;white-space:pre-wrap">studio failed to boot:\n${(e as Error).stack ?? e}</pre>`;
});
