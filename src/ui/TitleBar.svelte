<script lang="ts">
  // Our own title bar, when settings.titleBar = 'custom' (opt-in prototype; applies at next launch).
  //   Windows / Linux: the OS frame is gone, so this strip is the drag area and carries the window
  //                    buttons, drawn in glslop's bevelled style.
  //   macOS:           the title bar is transparent and the traffic lights stay where macOS puts them;
  //                    this strip is the drag area and leaves room on the left for them.
  // Double-click maximizes/restores (Tauri's drag region does that by itself).
  import { onMount } from 'svelte';
  import type { Studio } from '../studio/api';

  let { studio }: { studio: Studio } = $props();
  const mac = studio.host.boot.platform === 'macos';
  let maximized = $state(false);
  let win: any = null;

  onMount(() => {
    let off: (() => void) | undefined;
    (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      win = getCurrentWindow();
      maximized = await win.isMaximized().catch(() => false);
      off = await win.onResized(async () => { maximized = await win.isMaximized().catch(() => false); });
    })();
    return () => off?.();
  });
</script>

<div class="titlebar" class:mac data-tauri-drag-region>
  <span class="title" data-tauri-drag-region>glslop studio <i data-tauri-drag-region>· {studio.host.boot.angleBackend}</i></span>
  {#if !mac}
    <div class="btns">
      <button title="minimize" onclick={() => win?.minimize()}><svg viewBox="0 0 10 10"><path d="M1 8h8" /></svg></button>
      <button title={maximized ? 'restore' : 'maximize'} onclick={() => win?.toggleMaximize()}>
        {#if maximized}<svg viewBox="0 0 10 10"><path d="M3 1h6v6M1 3h6v6H1z" /></svg>{:else}<svg viewBox="0 0 10 10"><path d="M1 1h8v8H1z" /></svg>{/if}
      </button>
      <button class="x" title="close" onclick={() => win?.close()}><svg viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" /></svg></button>
    </div>
  {/if}
</div>

<style>
  .titlebar { height: 30px; display: flex; align-items: center; justify-content: space-between; background: #0b0b10; color: var(--slime); user-select: none; -webkit-user-select: none; position: relative; z-index: 60; border-bottom: 2px solid #000; }
  .titlebar.mac { padding-left: 78px; height: 28px; }
  .title { font-family: var(--mono); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; padding: 0 12px; pointer-events: auto; }
  .title i { font-style: normal; color: var(--magenta); opacity: .9; }
  .btns { display: flex; height: 100%; }
  .btns button { all: unset; width: 44px; height: 100%; display: grid; place-items: center; cursor: default; color: #d4d0c4; }
  .btns button:hover { background: #1f1f28; color: var(--slime); }
  .btns button.x:hover { background: var(--warn); color: #fff; }
  .btns button:active { translate: 1px 1px; }
  svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1.4; }
</style>
