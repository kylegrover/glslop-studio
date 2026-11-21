<script lang="ts">
  // glslop.com's browse page, desktop edition: the same jittered grid, sort links and captions, but
  // thumbnails are rendered locally and hovering plays the shader live (it compiles in milliseconds).
  import { onMount, tick } from 'svelte';
  import type { Studio } from '../studio/api';
  import { cellJitter, jitterStyle, wob } from '@glslop/core/jitter';
  import { fmtMs, speedClass } from './format';
  import { pageForTechnique } from '@glslop/core/glsl-pages';
  import { normalizeTechniqueName } from '@glslop/core/vocab';

  let { studio, params }: { studio: Studio; params: Record<string, any> } = $props();
  const st = (studio.state.browse ??= { q: '', sort: 'new', tag: '', author: '', seed: Math.random().toString(36).slice(2, 8), scroll: 0 });
  let q = $state<string>(params.q ?? st.q);
  let sort = $state<string>(params.sort ?? st.sort);
  let tag = $state<string>(params.tag ?? st.tag);
  let author = $state<string>(params.author ?? st.author);
  let rows = $state<any[]>([]);
  let total = $state(0);
  let syncedAt = $state<string | null>(null);
  let thumbs = $state<Record<string, string | null>>({});
  let failed = $state<Record<string, string>>({});
  let playing = $state<string | null>(null);
  let showTimes = $state<boolean>(studio.settings.browseShowTimes ?? false);
  let gridEl: HTMLDivElement;
  let scroller: HTMLElement | null = null;
  const backend = studio.host.boot.angleBackend;

  const sorts = [
    { k: 'new', label: 'newest' }, { k: 'slop', label: 'sloppiest' }, { k: 'seen', label: 'most-seen' }, { k: 'random', label: 'random' },
  ];
  const timeSorts = [{ k: 'slowest', label: 'slowest (d3d)' }, { k: 'speedup', label: 'biggest speedup' }];
  const techPage = $derived(tag ? pageForTechnique(normalizeTechniqueName(tag)?.name ?? '') : undefined);

  async function refresh() {
    Object.assign(st, { q, sort, tag, author });
    rows = await studio.call('corpus.search', { q, sort, tag: tag || undefined, author: author || undefined, seed: st.seed });
    total = (studio.state.corpus?.shaders ?? []).filter((s: any) => s.listed).length;
    syncedAt = studio.state.corpus?.syncedAt ?? null;
    const t: Record<string, string | null> = {};
    for (const r of rows) t[r.id] = studio.state.thumbs?.cached(r.id) ?? null;
    thumbs = t;
    await tick();
    observe();
  }

  // Visible cards ask for thumbnails at high priority; cards that leave the viewport cancel.
  let io: IntersectionObserver | null = null;
  function observe() {
    io?.disconnect();
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.id!;
        if (e.isIntersecting && !thumbs[id]) want(id, 1); else if (!e.isIntersecting && !thumbs[id]) studio.state.thumbs?.cancel(id);
      }
    }, { root: scroller, rootMargin: '600px 0px' });
    gridEl?.querySelectorAll<HTMLElement>('[data-id]').forEach((el) => io!.observe(el));
    // Don't depend on IntersectionObserver alone (WebKitGTK with a custom scroll root can stay
    // silent): kick the first screens directly. Requests are de-duplicated by the thumbs queue.
    for (const r of rows.slice(0, 24)) if (!thumbs[r.id]) want(r.id, 1);
  }
  function want(id: string, prio: number) {
    studio.state.thumbs?.request(id, prio).then((url: string | null) => {
      if (url) thumbs[id] = url;
      else { const f = studio.state.thumbs?.failed(id); if (f) failed[id] = f; }
    });
  }

  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  function enter(id: string, e: MouseEvent) {
    if (studio.settings.hoverPlay === false) return;
    clearTimeout(hoverTimer);
    const frame = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-frame]')!;
    hoverTimer = setTimeout(async () => {
      playing = id;
      const r = await studio.state.live?.play(id, frame);
      if (r && !r.ok && playing === id) { failed[id] = r.error; playing = null; }
    }, studio.settings.hoverDelayMs ?? 60);
  }
  function leave(id: string) {
    clearTimeout(hoverTimer);
    if (playing === id) { studio.state.live?.stop(); playing = null; }
  }
  function open(id: string) { studio.state.browse.scroll = scroller?.scrollTop ?? 0; studio.views.open('shader', { id }); }
  function setSort(k: string) { if (k === 'random') st.seed = Math.random().toString(36).slice(2, 8); sort = k; }
  function clear() { q = ''; tag = ''; author = ''; }

  onMount(() => {
    scroller = gridEl.closest('.view-root');
    const offs = [
      studio.events.on('corpus:changed', refresh),
      studio.events.on('thumbs:ready', ({ id, url }: any) => { if (id in thumbs) thumbs[id] = url; }),
      studio.events.on('thumbs:cleared', refresh),
      studio.events.on('browse:filter', (p: any) => { if (p.tag !== undefined) tag = p.tag; if (p.author !== undefined) author = p.author; if (p.q !== undefined) q = p.q; }),
    ];
    refresh().then(() => { if (scroller) scroller.scrollTop = st.scroll ?? 0; });
    return () => { offs.forEach((o) => o()); io?.disconnect(); studio.state.live?.stop(); };
  });
  let first = true;
  $effect(() => { void q; void sort; void tag; void author; if (first) { first = false; return; } refresh(); });
</script>

<div class="wrap">
  <section class="panel browse-head">
    <div>
      <span class="kicker">the feed</span>
      <h2>browse <span class="bignum" style={wob('total')}>{total.toLocaleString('en-US')}</span> shaders</h2>
      <div class="sub">always CC0 · take it & break it · rendered on your gpu ({backend})</div>
    </div>
    <form class="searchbar" onsubmit={(e) => e.preventDefault()}>
      <input class="txt" type="text" placeholder="search titles, tags, authors…" bind:value={q} />
    </form>
  </section>

  <div class="sortbar">
    <span style="opacity:.7">sort&gt;&gt;</span>
    {#each sorts as s}<button class="sortlink" class:on={sort === s.k} onclick={() => setSort(s.k)}>{s.label}</button>{/each}
    {#if showTimes}{#each timeSorts as s}<button class="sortlink" class:on={sort === s.k} onclick={() => setSort(s.k)}>{s.label}</button>{/each}{/if}
    {#if tag}<span class="tagfilter">· tag: <b>{tag}</b> <button class="linkish" onclick={() => (tag = '')}>[clear]</button></span>{/if}
    {#if q}<span class="tagfilter">· q: <b>{q}</b> <button class="linkish" onclick={() => (q = '')}>[clear]</button></span>{/if}
    {#if author}<span class="tagfilter">· by: <b>@{author}</b> <button class="linkish" onclick={() => (author = '')}>[clear]</button></span>{/if}
    <span class="grow"></span>
    <label class="opt"><input type="checkbox" bind:checked={showTimes} onchange={() => { studio.settings.browseShowTimes = showTimes; studio.saveSettings(); }} /> compile times</label>
    <button class="linkish" title={syncedAt ? `synced ${new Date(syncedAt).toLocaleString()}` : 'never synced'} onclick={() => studio.call('corpus.sync', { force: true }, { caller: 'ui' })}>↻ sync</button>
  </div>

  {#if techPage}
    <button class="techlink" onclick={() => studio.views.open('glsl', { slug: techPage.slug })}>
      <b>{techPage.title}</b> — there is a whole page on how this works, with a live example you can edit <span class="arrow">&rarr;</span>
    </button>
  {/if}

  {#if rows.length === 0}
    <div class="notice">{total ? 'no shaders match. the void stares back.' : 'syncing the corpus…'} {#if total}<button class="linkish" onclick={clear}>try everything</button>{/if}</div>
  {/if}

  <div class="grid" bind:this={gridEl}>
    {#each rows as s, i (s.id)}
      {@const l = s.local?.[backend]}
      <a class="cell" href={'#' + s.id} style="{jitterStyle(cellJitter(s.id))};--i:{Math.min(i, 30)}" data-id={s.id}
        onclick={(e) => { e.preventDefault(); open(s.id); }}
        onmouseenter={(e) => enter(s.id, e)} onmouseleave={() => leave(s.id)}>
        <span class="corner">#{s.id}</span>
        {#if showTimes}
          <span class="times">
            <span class="chip {speedClass(s.ref_compile_ms)}" title="reference: D3D11/FXC, RTX 3090">d3d {fmtMs(s.ref_compile_ms)}</span>
            {#if l}<span class="chip {l.ok ? speedClass(l.compile_ms) : 'bad'}" title="measured here on {backend}">{fmtMs(l.compile_ms)}</span>{/if}
          </span>
        {/if}
        <div class="frame" data-frame data-hero={s.id}>
          {#if thumbs[s.id]}
            <img src={thumbs[s.id]} alt={s.title} draggable="false" />
          {:else if failed[s.id]}
            <div class="ph err" title={failed[s.id]}>∅ no compile</div>
          {:else}
            <div class="ph"></div>
          {/if}
        </div>
        <div class="cap">
          <span class="t">{s.title}</span>
          <span class="meta">
            <span class="by">{s.author_name ? '@' + s.author_name : ''}</span>
            <span class="s"><span class="num" style={wob(s.id + 'slop')}>{s.stats?.slops ?? 0}</span> 💧</span>
          </span>
        </div>
      </a>
    {/each}
  </div>
</div>

<style>
  .wrap { max-width: 1400px; margin: 0 auto; padding: 0 14px; }
  .browse-head { display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  .bignum { background: #000; color: var(--slime); padding: 0 8px; }
  .sub { font-size: 12px; opacity: 0.75; }
  .searchbar input { min-width: 280px; }
  .sortbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; padding: 2px 6px; }
  .sortlink { border: 3px outset var(--paper); background: var(--paper); padding: 1px 8px; color: #000; font-size: 13px; }
  .sortlink.on { background: var(--magenta); color: #fff; border-color: var(--magenta); }
  .sortlink:hover { background: var(--slime); color: #000; border-color: var(--slime); }
  .sortlink:active { border-style: inset; }
  .grow { flex: 1; }
  .opt { font-size: 12px; opacity: 0.8; display: inline-flex; gap: 4px; align-items: center; }
  .linkish { background: none; border: none; padding: 0; color: var(--link); text-decoration: underline; cursor: pointer; font: inherit; font-size: 12px; }
  .linkish:hover { background: var(--slime); color: #000; }
  .tagfilter { opacity: 0.85; }
  .techlink { display: block; width: 100%; text-align: left; margin: 8px 0 2px; padding: 7px 10px; font-size: 13px; line-height: 1.45; color: inherit; background: none; border: 1px solid var(--slime); cursor: pointer; font-family: var(--mono); }
  .techlink:hover { background: var(--slime); color: #000; }
  .cell { cursor: pointer; }
  .cell .corner { z-index: 2; }
  .cell .frame { position: relative; }
  /* Cells deal in on first show (full motion only): opacity + a small drop, staggered by index. Only
     the first 30 get a delay, so a long grid never waits. */
  :global(html[data-motion='full']) .cell { animation: deal .42s cubic-bezier(.2,1.4,.4,1) backwards; animation-delay: calc(var(--i, 0) * 18ms); }
  @keyframes deal { from { opacity: 0; translate: 0 14px; } }
  /* Thumbnails fade up when they arrive instead of popping. */
  :global(html:not([data-motion='off'])) .frame img { animation: thumb-in .3s ease-out; }
  @keyframes thumb-in { from { opacity: 0; filter: saturate(0) brightness(1.6); } }
  .ph { width: 100%; height: 100%; background: repeating-linear-gradient(135deg, #0d0d12 0 14px, #16161d 14px 28px); }
  .ph.err { display: grid; place-items: center; color: var(--warn); font-size: 12px; background: #111; }
  .times { position: absolute; top: -10px; right: -8px; z-index: 2; display: flex; gap: 2px; }
  .times .chip { font-size: 10px; line-height: 1.5; }
  .grid .cell .cap { flex-direction: column; align-items: stretch; gap: 2px; }
  .grid .cell .cap .meta { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
  .grid .cell .cap .by { flex: 1; min-width: 0; font-size: 11px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
