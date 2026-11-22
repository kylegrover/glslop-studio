<script lang="ts">
  // The app frame, in glslop.com's clothes: skewed double-ruled header with the wordmark, beveled nav
  // built from studio.views, a footer. Mods replace any view by id, or the whole frame via
  // studio.state.mountShell (docs/MODDING.md).
  import { onMount } from 'svelte';
  import type { Studio, View } from '../studio/api';
  import { transitionViews } from './motion';
  import TitleBar from './TitleBar.svelte';

  let { studio }: { studio: Studio } = $props();
  // svelte-ignore state_referenced_locally
  const customBar = studio.host.kind === 'tauri' && studio.host.boot.titleBar === 'custom';
  let views = $state<View[]>([]);
  let active = $state<string>('browse');
  let params = $state<Record<string, unknown>>({});
  let toasts = $state<{ id: number; msg: string; kind: string }[]>([]);
  let progress = $state<string>('');
  let history: { id: string; params: Record<string, unknown> }[] = [];
  let account = $state<{ signedIn: boolean; handle: string | null }>(studio.state.account ?? { signedIn: false, handle: null });
  let update = $state<any>(studio.state.update ?? null);
  let signingIn = $state(false);
  // Clicking again while waiting starts a fresh attempt (the old browser page then says it expired).
  let signInSeq = 0;
  async function signIn() {
    const mine = ++signInSeq;
    signingIn = true;
    try { await studio.call('account.signIn', {}, { caller: 'ui' }); }
    catch { /* shown as a toast by tool:error */ }
    finally { if (mine === signInSeq) signingIn = false; }
  }
  let slot: HTMLElement;
  let cleanup: (() => void) | void;
  let seq = 0;

  const refresh = () => { views = studio.views.list().filter((v) => !v.hidden).sort((a, b) => (a.order ?? 50) - (b.order ?? 50)); };

  function mount(id: string, p: Record<string, unknown> = {}, push = true) {
    const v = studio.views.get(id);
    if (!v || !slot) return;
    if (push && (active !== id || JSON.stringify(params) !== JSON.stringify(p))) history.push({ id: active, params });
    if (history.length > 50) history.shift();
    // The shader being opened (or the one we're coming back from) morphs between its grid thumbnail
    // and the stage. Only when motion is full and the webview has View Transitions.
    const heroKey = (p.id as string | undefined) ?? (params.id as string | undefined) ?? null;
    const swap = () => {
      try { cleanup?.(); } catch (e) { console.error(e); }
      slot.replaceChildren();
      const el = document.createElement('div');
      el.className = 'view-root';
      slot.append(el);
      active = id; params = p;
      try { cleanup = v.mount(el, studio, p); }
      catch (e) { el.textContent = `view "${id}" crashed: ${(e as Error).stack ?? e}`; }
    };
    transitionViews({ root: slot, swap, heroKey });
    studio.state.activeView = id;
    studio.state.activeParams = p;
    studio.events.emit('view:mounted', { id, params: p });
  }
  function back() { const h = history.pop(); if (h) mount(h.id, h.params, false); }

  onMount(() => {
    refresh();
    const offs = [
      studio.events.on('views:changed', ({ key }) => { refresh(); if (key === active) mount(active, params, false); }),
      studio.events.on('view:open', ({ id, params }) => mount(id, params)),
      studio.events.on('toast', ({ msg, kind }) => {
        const id = ++seq; toasts = [...toasts, { id, msg, kind }];
        setTimeout(() => (toasts = toasts.filter((t) => t.id !== id)), kind === 'error' ? 8000 : 3500);
      }),
      studio.events.on('account:changed', (a) => (account = a)),
      studio.events.on('update:available', (u) => (update = u)),
      studio.events.on('tool:progress', ({ msg }) => (progress = msg)),
      studio.events.on('tool:after', () => (progress = '')),
      studio.events.on('tool:error', ({ name, error, caller }) => { progress = ''; if (caller === 'ui' && !/a newer one was started/.test(error)) studio.toast(`${name}: ${error}`, 'error'); }),
    ];
    const onKey = (e: KeyboardEvent) => {
      if ((e.altKey && e.key === 'ArrowLeft') || (e.key === 'Backspace' && !(e.target as HTMLElement).closest('input,textarea,select,[contenteditable]'))) { e.preventDefault(); back(); return; }
      const combo = [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.shiftKey ? 'Shift' : '', e.altKey ? 'Alt' : '', e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join('+');
      for (const c of studio.commands.list()) if (c.key && c.key === combo) { e.preventDefault(); c.run(studio); }
    };
    const onMouse = (e: MouseEvent) => { if (e.button === 3) { e.preventDefault(); back(); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    mount(studio.settings.startView ?? 'browse', {}, false);
    studio.state.back = back;
    // Second launch: the window comes to the front (Rust). Put the cursor where typing makes sense:
    // the search box on browse, unless something on the page already has focus.
    let offReopen: (() => void) | undefined;
    studio.host.listen?.('app:reopened', () => {
      const a = document.activeElement as HTMLElement | null;
      if (a && a !== document.body && a.closest('input,textarea,select,[contenteditable]')) return;
      const search = slot?.querySelector<HTMLInputElement>('input[type=text]');
      if (search) { search.focus(); search.select(); }
      studio.events.emit('app:reopened', {});
    }).then((off) => (offReopen = off));
    return () => { offReopen?.(); offs.forEach((o) => o()); window.removeEventListener('keydown', onKey); window.removeEventListener('mouseup', onMouse); };
  });
</script>

<div class="shell" class:custom-bar={customBar}>
  {#if customBar}<TitleBar {studio} />{/if}
  <header class="site-head">
    <div class="headwrap">
      <div>
        <button class="wordmark" onclick={() => mount('browse')}><span class="wordmark-gl">gl</span>sl<b>op</b><span class="studio">studio</span></button>
        <div class="tagline">[ CC0 shader vibe commons · on your own gpu ]</div>
      </div>
      <nav class="main">
        {#if history.length}<button onclick={back} title="back (Alt+←)">←</button>{/if}
        {#each views as v (v.id)}
          <button class:on={active === v.id} onclick={() => mount(v.id)}>{v.title}</button>
        {/each}
        {#if update}<button class="upd" title={update.notes ?? ''} onclick={() => studio.call('app.checkUpdate', { install: true }, { caller: 'ui' })}>⬆ update {update.version}</button>{/if}
        {#if studio.host.kind === 'tauri'}
          {#if account.signedIn}<button class="acct" title="signed in to glslop" onclick={() => studio.host.open(`${studio.state.corpus?.base ?? 'https://glslop.com'}/u/${account.handle}`)}>@{account.handle}</button>
          {:else}<button onclick={signIn} title={signingIn ? 'finish in your browser, or click to open a fresh sign-in page' : 'sign in with glslop'}>{signingIn ? 'waiting for browser… (retry)' : 'login'}</button>{/if}
        {/if}
      </nav>
    </div>
  </header>
  <main bind:this={slot}></main>
  <footer class="statusbar">
    <span class="cc0">CONTENT = CC0</span>
    <span title={studio.host.boot.browserArgs}>{studio.host.kind === 'tauri' ? '' : 'browser · '}gpu: {studio.host.boot.angleBackend}</span>
    {#if studio.host.boot.bridgeUrl}<span>agent bridge {studio.host.boot.bridgeUrl.replace('http://', '')}</span>{/if}
    {#if progress}<span class="progress">{progress}</span>{/if}
  </footer>
  <div class="toasts">{#each toasts as t (t.id)}<div class="toast {t.kind}">{t.msg}</div>{/each}</div>
</div>

<style>
  .shell { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; }
  .shell.custom-bar { grid-template-rows: auto auto 1fr auto; }
  .site-head { border-bottom: 6px double var(--line); background: repeating-linear-gradient(137deg, var(--paper) 0 14px, #dedcce 14px 28px); transform: rotate(0.3deg); position: relative; z-index: 40; margin-bottom: 4px; }
  .headwrap { display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 6px; padding: 8px 18px 6px; max-width: 1600px; margin: 0 auto; }
  .wordmark { font-family: var(--display); font-weight: 700; font-size: 38px; line-height: .9; letter-spacing: -2px; color: #000; text-shadow: 3px 3px 0 var(--slime), 6px 6px 0 var(--magenta); display: inline-block; transform: rotate(-5deg); background: none; border: none; padding: 0; cursor: pointer; }
  .wordmark-gl { position: relative; top: -6px; z-index: -1; }
  .wordmark b { color: var(--magenta); }
  .wordmark .studio { font-family: var(--mono); font-size: 12px; letter-spacing: 1px; text-shadow: none; background: #000; color: var(--slime); padding: 0 5px; margin-left: 6px; vertical-align: middle; }
  .tagline { font-size: 11px; opacity: .8; transform: rotate(-0.5deg); position: relative; top: 3px; }
  nav.main { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
  nav.main button { display: inline-block; padding: 2px 9px; border: 3px outset var(--paper); background: var(--paper); color: #000; font-size: 13px; font-family: var(--mono); cursor: pointer; }
  nav.main button:hover { background: var(--slime); border-color: var(--slime); }
  nav.main button.on { background: var(--magenta); color: #fff; border-color: var(--magenta); }
  nav.main button.upd { background: var(--slime); border-color: var(--slime); }
  nav.main button.acct { background: #000; color: var(--slime); border-color: #000; }
  main { overflow: hidden; position: relative; }
  main :global(.view-root) { height: 100%; overflow: auto; }
  .statusbar { display: flex; gap: 16px; align-items: center; padding: 3px 14px; font-size: 11px; border-top: 2px solid var(--line); background: var(--paper); }
  .cc0 { font-weight: bold; }
  .progress { background: #000; color: var(--slime); padding: 0 6px; max-width: 50vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toasts { position: fixed; right: 10px; bottom: 30px; display: grid; gap: 4px; z-index: 100; }
  .toast { animation: toast-in .32s cubic-bezier(.2,1.5,.4,1); background: #ffe600; border: 2px solid var(--line); box-shadow: 4px 4px 0 var(--line); padding: 6px 10px; max-width: 460px; font-size: 12px; white-space: pre-wrap; }
  .toast.error { background: var(--warn); color: #fff; }
  @keyframes toast-in { from { transform: translateX(40px) rotate(3deg); opacity: 0; } }
  :global(html[data-motion='off']) .toast { animation: none; }
  :global(html[data-motion='full']) nav.main button:active { transform: translate(2px, 2px); }
  :global(html[data-motion='full']) nav.main button.upd { animation: upd-pulse 2.4s ease-in-out infinite; }
  @keyframes upd-pulse { 50% { box-shadow: 0 0 0 4px rgba(70, 255, 26, .35); } }
  /* The shell's first appearance, as the splash leaves: header drops in, content rises. */
  :global(html[data-motion='full']:not(.app-in)) .site-head { transform: translateY(-110%) rotate(0.3deg); }
  :global(html[data-motion='full']) .site-head { transition: transform .5s cubic-bezier(.2,1.3,.4,1); }
  :global(html[data-motion='full']:not(.app-in)) main { opacity: 0; transform: translateY(18px); }
  :global(html[data-motion='full']) main { transition: opacity .4s ease-out .08s, transform .5s cubic-bezier(.2,1.2,.4,1) .08s; }
</style>
