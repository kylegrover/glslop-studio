<script lang="ts">
  // The canvas | params | code row from glslop's ShaderStudio.svelte, minus everything that exists to
  // protect a browser tab from FXC (poster cover, worker isolation, run-live button, WebGPU pilot).
  // Here it just compiles and plays. Same slider rows, randomize/reset, fullscreen overlay, apply ⌘↵.
  import { onMount } from 'svelte';
  import type { Studio } from '../studio/api';
  import { GlslopRenderer, defaultFor } from '@glslop/core/runtime';
  import { parseISF } from '@glslop/core/parse';
  import type { ISFInput } from '@glslop/core/types';
  import IsfCodeArea from '@glslop/ui/IsfCodeArea.svelte';

  interface Props {
    studio: Studio;
    isf: string;
    shaderId?: string | null;
    filename?: string;
    onCompiled?: (ms: number, ok: boolean) => void;
    onInputs?: (v: Record<string, any>) => void;
    /** Expose the source being edited (scratch editor saves it). */
    onSource?: (src: string) => void;
  }
  let { studio, isf, shaderId = null, filename = 'shader.fs', onCompiled, onInputs, onSource }: Props = $props();

  const HEADER_RE = /\/\*\s*(\{[\s\S]*?\})\s*\*\//;
  function bodyStartIndex(src: string): number {
    const m = src.match(HEADER_RE);
    if (!m || m.index === undefined) return 0;
    let i = m.index + m[0].length;
    while (i < src.length && (src[i] === '\n' || src[i] === '\r')) i++;
    return i;
  }
  const parseInputs = (src: string): ISFInput[] => { const p = parseISF(src); return p.ok ? p.isf.inputs : []; };

  let source = $state(isf);
  let applied = $state(isf);
  let inputs = $state<ISFInput[]>(parseInputs(isf));
  const dirty = $derived(source !== applied);
  let compileErr = $state<string | null>(null);
  let compileOk = $state(true);
  let compiling = $state(false);
  let compileMs = $state<number | null>(null);
  let paused = $state(false);
  let disp = $state<Record<string, number>>({});
  let bools = $state<Record<string, boolean>>({});
  let colorHex = $state<Record<string, string>>({});
  let codeExpanded = $state(false);
  let isFs = $state(false);
  let panelOpen = $state(false);
  let keepOpen = $state(false);
  let fps = $state(0);
  let wrapEl: HTMLDivElement;
  let canvasEl: HTMLCanvasElement;
  let renderer: GlslopRenderer | null = null;
  let raf = 0, began = performance.now(), pausedAt = 0;
  let codeArea: { scrollToChar: (i: number, focus?: boolean) => void } | undefined;

  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  const toHex = (c: number[]) => '#' + [0, 1, 2].map((i) => Math.round(clamp01(c[i] ?? 1) * 255).toString(16).padStart(2, '0')).join('');
  const fromHex = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]; };

  function seedValues(preserve = true) {
    const nd: Record<string, number> = {}, nb: Record<string, boolean> = {}, nc: Record<string, string> = {};
    for (const inp of inputs) {
      const d = defaultFor(inp);
      if (inp.TYPE === 'float' || inp.TYPE === 'long') nd[inp.NAME] = preserve && inp.NAME in disp ? disp[inp.NAME] : Number(d);
      else if (inp.TYPE === 'bool' || inp.TYPE === 'event') nb[inp.NAME] = preserve && inp.NAME in bools ? bools[inp.NAME] : d === true;
      else if (inp.TYPE === 'color') nc[inp.NAME] = preserve && inp.NAME in colorHex ? colorHex[inp.NAME] : toHex(d as number[]);
      else if (inp.TYPE === 'point2D') {
        const p = d as number[], kx = inp.NAME + '__x', ky = inp.NAME + '__y';
        nd[kx] = preserve && kx in disp ? disp[kx] : (p[0] ?? 0.5);
        nd[ky] = preserve && ky in disp ? disp[ky] : (p[1] ?? 0.5);
      }
    }
    disp = nd; bools = nb; colorHex = nc;
    pushAll();
  }
  function currentInputs(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const inp of inputs) {
      if (inp.TYPE === 'float' || inp.TYPE === 'long') out[inp.NAME] = disp[inp.NAME];
      else if (inp.TYPE === 'bool' || inp.TYPE === 'event') out[inp.NAME] = bools[inp.NAME];
      else if (inp.TYPE === 'color') out[inp.NAME] = fromHex(colorHex[inp.NAME] ?? '#ffffff');
      else if (inp.TYPE === 'point2D') out[inp.NAME] = [disp[inp.NAME + '__x'] ?? 0.5, disp[inp.NAME + '__y'] ?? 0.5];
    }
    return out;
  }
  function pushAll() { if (renderer) for (const [k, v] of Object.entries(currentInputs())) renderer.setInputValue(k, v); }
  $effect(() => { onInputs?.(currentInputs()); });
  $effect(() => { onSource?.(source); });

  function resetAll() { seedValues(false); began = performance.now(); pausedAt = 0; renderer?.resetFeedback(); }
  const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
  function randomizeAll() {
    for (const inp of inputs) {
      if (inp.TYPE === 'float') disp[inp.NAME] = rand(inp.MIN ?? 0, inp.MAX ?? 1);
      else if (inp.TYPE === 'long') disp[inp.NAME] = inp.VALUES?.length ? inp.VALUES[Math.floor(Math.random() * inp.VALUES.length)] : Math.round(rand(inp.MIN ?? 0, inp.MAX ?? 10));
      else if (inp.TYPE === 'bool' || inp.TYPE === 'event') bools[inp.NAME] = Math.random() < 0.5;
      else if (inp.TYPE === 'color') colorHex[inp.NAME] = toHex([Math.random(), Math.random(), Math.random(), 1]);
      else if (inp.TYPE === 'point2D') { disp[inp.NAME + '__x'] = Math.random(); disp[inp.NAME + '__y'] = Math.random(); }
    }
    pushAll();
  }

  async function compile(src: string): Promise<boolean> {
    if (!renderer) return false;
    compiling = true;
    await new Promise((r) => setTimeout(r, 0)); // paint "compiling…" first: Vulkan compiles synchronously
    const t0 = performance.now();
    const res = await renderer.load(src);
    compileMs = Math.round(performance.now() - t0);
    compiling = false;
    if (res.superseded) return false;
    onCompiled?.(compileMs, res.compileOk);
    studio.events.emit('viewer:compiled', { id: shaderId, ok: res.compileOk, compileMs, errors: res.errors, backend: studio.host.boot.angleBackend });
    if (!res.compileOk) { compileErr = res.errors.join('\n') || 'compile failed'; compileOk = false; return false; }
    compileErr = null; compileOk = true;
    return true;
  }
  async function apply(force = false) {
    if (compiling) await compileIdle();
    if (!dirty && !force) return;
    const next = source;
    if (await compile(next)) { applied = next; inputs = parseInputs(next); seedValues(true); }
    else if (renderer) { await renderer.load(applied); pushAll(); }
  }
  const compileIdle = () => new Promise<void>((r) => { const t = () => (compiling ? setTimeout(t, 20) : r()); t(); });
  function revert() { source = applied; compileErr = null; compileOk = true; }
  function onEditorKeydown(e: KeyboardEvent) { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void apply(); } }

  function resize() {
    if (!renderer || !wrapEl) return;
    const dpr = Math.min(2, devicePixelRatio || 1) * (studio.settings.renderScale ?? 1);
    const fs = document.fullscreenElement === wrapEl;
    const r = wrapEl.getBoundingClientRect();
    renderer.resize(Math.max(1, Math.round((fs ? innerWidth : r.width) * dpr)), Math.max(1, Math.round((fs ? innerHeight : r.height) * dpr)));
  }
  function togglePlay() {
    paused = !paused;
    if (paused) pausedAt = performance.now(); else began += performance.now() - pausedAt;
  }
  function toggleFs() { if (document.fullscreenElement) document.exitFullscreen(); else wrapEl.requestFullscreen?.(); }

  let copied = $state(false);
  async function copyIsf() { await navigator.clipboard.writeText(source); copied = true; setTimeout(() => (copied = false), 1500); }
  async function saveFs() {
    const path = `${studio.host.paths.workspace}/shaders/${filename}`;
    await studio.host.writeText(path, source);
    studio.toast(`saved ${path}`);
  }

  onMount(() => {
    renderer = new GlslopRenderer(canvasEl);
    resize();
    compile(applied).then((ok) => { if (ok) seedValues(false); });
    let fpsN = 0, fpsT = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!renderer || paused || !compileOk && applied === source && compileErr) return;
      renderer.draw((performance.now() - began) / 1000);
      fpsN++;
      const now = performance.now();
      if (now - fpsT > 500) { fps = Math.round((fpsN * 1000) / (now - fpsT)); fpsN = 0; fpsT = now; }
    };
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(resize); ro.observe(wrapEl);
    const onFs = () => { isFs = document.fullscreenElement === wrapEl; resize(); };
    document.addEventListener('fullscreenchange', onFs);
    const onVis = () => { if (document.hidden && !paused) togglePlay(); };
    document.addEventListener('visibilitychange', onVis);
    const offExport = [
      studio.events.on('export:start', () => { if (!paused) togglePlay(); }),
    ];
    // Agents drive the page through studio.state.viewer (same contract as the scratch editor).
    studio.state.viewer = {
      get id() { return shaderId; }, get title() { return filename; }, get source() { return source; },
      get values() { return currentInputs(); }, get errors() { return compileErr ? [compileErr] : []; }, get compileMs() { return compileMs; },
      get renderer() { return renderer; }, canvas: canvasEl,
      setSource: async (src: string) => { source = src; await apply(true); return { ok: compileOk, errors: compileErr ? [compileErr] : [], compileMs }; },
      setValue: (name: string, v: any) => {
        const inp = inputs.find((i) => i.NAME === name);
        if (!inp) return;
        if (inp.TYPE === 'bool' || inp.TYPE === 'event') bools[name] = !!v;
        else if (inp.TYPE === 'color') colorHex[name] = toHex(v);
        else if (inp.TYPE === 'point2D') { disp[name + '__x'] = v[0]; disp[name + '__y'] = v[1]; }
        else disp[name] = +v;
        renderer?.setInputValue(name, v);
      },
      play: (on = true) => { if (on === paused) togglePlay(); },
      snapshot: () => canvasEl.toDataURL('image/png'),
    };
    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      document.removeEventListener('fullscreenchange', onFs); document.removeEventListener('visibilitychange', onVis);
      offExport.forEach((o) => o());
      renderer?.dispose(); renderer = null;
    };
  });

  function setFloat(inp: ISFInput, e: Event) { const v = parseFloat((e.target as HTMLInputElement).value); disp[inp.NAME] = v; renderer?.setInputValue(inp.NAME, v); }
  function setLong(inp: ISFInput, e: Event) { const v = parseInt((e.target as HTMLInputElement).value, 10); disp[inp.NAME] = v; renderer?.setInputValue(inp.NAME, v); }
  function setBool(inp: ISFInput, e: Event) { const c = (e.target as HTMLInputElement).checked; bools[inp.NAME] = c; renderer?.setInputValue(inp.NAME, c); }
  function setColor(inp: ISFInput, e: Event) { const hex = (e.target as HTMLInputElement).value; colorHex[inp.NAME] = hex; renderer?.setInputValue(inp.NAME, fromHex(hex)); }
  // ISF has no mouse uniform; the convention is a point2D input. Dragging on the canvas drives the first one.
  const pointInput = () => inputs.find((i) => i.TYPE === 'point2D');
  let dragging = false;
  function pointerAt(e: PointerEvent) {
    const inp = pointInput();
    if (!inp) return;
    const r = canvasEl.getBoundingClientRect();
    const x = clamp01((e.clientX - r.left) / r.width), y = clamp01(1 - (e.clientY - r.top) / r.height);
    disp[inp.NAME + '__x'] = x; disp[inp.NAME + '__y'] = y;
    renderer?.setInputValue(inp.NAME, [x, y]);
  }
  function pointerDown(e: PointerEvent) { if (!pointInput() || e.button !== 0) return; dragging = true; canvasEl.setPointerCapture(e.pointerId); pointerAt(e); }
  function pointerMove(e: PointerEvent) { if (dragging) pointerAt(e); }
  function pointerUp() { dragging = false; }
  function setPoint(inp: ISFInput, idx: number, e: Event) {
    const v = parseFloat((e.target as HTMLInputElement).value);
    disp[inp.NAME + (idx ? '__y' : '__x')] = v;
    renderer?.setInputValue(inp.NAME, [disp[inp.NAME + '__x'] ?? 0.5, disp[inp.NAME + '__y'] ?? 0.5]);
  }
</script>

<div class="studio" class:expanded={codeExpanded}>
  <section class="col col-canvas">
    <div class="stage" class:fs={isFs} bind:this={wrapEl}>
      <canvas bind:this={canvasEl} class:draggable={!!pointInput()} onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={pointerUp}></canvas>
      {#if compiling}<div class="badge-live">compiling…</div>{/if}
      <div class="overlay" class:show={isFs} role="group" onmouseenter={() => (panelOpen = true)} onmouseleave={() => { if (!keepOpen) panelOpen = false; }}>
        <div class="ctl-left">
          <button class="ctl" onclick={togglePlay} title={paused ? 'play' : 'pause'}>{paused ? '▶' : '⏸'}</button>
          <button class="ctl" onclick={resetAll} title="reset knobs + time">↺</button>
          <button class="ctl" onclick={toggleFs} title="fullscreen">{isFs ? '✕' : '⛶'}</button>
          <span class="fps">{fps} fps · {compileMs ?? '?'} ms compile</span>
          {#if isFs}<label class="fs-keep"><input type="checkbox" bind:checked={keepOpen} /> keep panel</label>{/if}
        </div>
        {#if inputs.length}<button class="ctl rand" onclick={randomizeAll}>🎲 random</button>{/if}
      </div>
      {#if isFs && inputs.length}
        <div class="fs-panel" class:fs-hidden={!panelOpen && !keepOpen}>
          <div class="fs-sliders">{#each inputs as inp (inp.NAME)}{@render sliderRow(inp)}{/each}</div>
        </div>
        {#if !panelOpen && !keepOpen}<div class="fs-hotzone" onmouseenter={() => (panelOpen = true)} role="presentation"></div>{/if}
      {/if}
    </div>
  </section>

  <section class="col col-params" class:rail={codeExpanded}>
    {#if codeExpanded}
      <button class="rail-toggle" onclick={() => (codeExpanded = false)}><span>◂ params</span></button>
    {:else}
      <div class="inner">
        <header class="col-head">
          <span class="kicker">params ({inputs.length})</span>
          {#if inputs.length}<span class="head-right">
            <button class="link-btn" onclick={randomizeAll}>🎲 random</button>
            <button class="link-btn" onclick={resetAll}>reset all</button>
          </span>{/if}
        </header>
        <div class="pane-scroll">
          {#if inputs.length}{#each inputs as inp (inp.NAME)}{@render sliderRow(inp)}{/each}
          {:else}<p class="empty">no adjustable inputs — this shader has no ISF knobs.</p>{/if}
        </div>
      </div>
    {/if}
  </section>

  <section class="col col-code">
    <div class="inner">
      <header class="col-head">
        <span class="kicker">.fs source · isf</span>
        <span class="head-right">
          {#if bodyStartIndex(source) > 0}
            <span class="jump">
              <button class="jump-btn" onclick={() => codeArea?.scrollToChar(0, true)}>↑ header</button>
              <button class="jump-btn" onclick={() => codeArea?.scrollToChar(bodyStartIndex(source), true)}>↓ code</button>
            </span>
          {/if}
          {#if dirty}<span class="dirty">edited</span>{/if}
          <span class={compileOk ? 'compile-ok' : 'compile-bad'}>{compileOk ? 'compiles ✓' : 'broken ✗'}</span>
          <button class="expand-btn" onclick={() => (codeExpanded = !codeExpanded)}>{codeExpanded ? '⛶ collapse' : '⛶ expand'}</button>
        </span>
      </header>
      <div class="pane-editor" onkeydown={onEditorKeydown} role="group">
        <IsfCodeArea bind:this={codeArea} bind:value={source} />
      </div>
      {#if compileErr}<pre class="compile-strip">{compileErr}</pre>{/if}
      <div class="code-actions">
        <button class="btn apply" class:hot={dirty} onclick={() => apply()} disabled={!dirty || compiling} title="apply (⌘↵ / Ctrl+↵)">{compiling ? 'compiling…' : 'apply ⌘↵'}</button>
        <button class="btn" onclick={revert} disabled={!dirty}>revert</button>
        <button class="btn" onclick={copyIsf}>{copied ? 'copied ✓' : '⧉ copy'}</button>
        <button class="btn" onclick={saveFs} title="save to workspace/shaders">⤓ .fs</button>
      </div>
    </div>
  </section>
</div>

{#snippet sliderRow(inp: ISFInput)}
  {#if inp.TYPE === 'float'}
    <div class="slider-row"><label title={inp.NAME}>{inp.LABEL ?? inp.NAME}</label>
      <input type="range" min={inp.MIN ?? 0} max={inp.MAX ?? 1} step="0.001" value={disp[inp.NAME]} oninput={(e) => setFloat(inp, e)} />
      <span class="v">{(disp[inp.NAME] ?? 0).toFixed(2)}</span></div>
  {:else if inp.TYPE === 'long'}
    <div class="slider-row"><label title={inp.NAME}>{inp.LABEL ?? inp.NAME}</label>
      {#if inp.VALUES?.length}
        <select onchange={(e) => setLong(inp, e)}>{#each inp.VALUES as val, i}<option value={val} selected={val === disp[inp.NAME]}>{inp.LABELS?.[i] ?? val}</option>{/each}</select>
      {:else}<input type="range" min={inp.MIN ?? 0} max={inp.MAX ?? 10} step="1" value={disp[inp.NAME]} oninput={(e) => setLong(inp, e)} />{/if}
      <span class="v">{disp[inp.NAME] ?? 0}</span></div>
  {:else if inp.TYPE === 'bool' || inp.TYPE === 'event'}
    <div class="slider-row"><label title={inp.NAME}>{inp.LABEL ?? inp.NAME}</label>
      <input type="checkbox" checked={bools[inp.NAME]} onchange={(e) => setBool(inp, e)} /><span class="v">{bools[inp.NAME] ? 'on' : 'off'}</span></div>
  {:else if inp.TYPE === 'color'}
    <div class="slider-row"><label title={inp.NAME}>{inp.LABEL ?? inp.NAME}</label>
      <input type="color" value={colorHex[inp.NAME]} oninput={(e) => setColor(inp, e)} /><span class="v">rgb</span></div>
  {:else if inp.TYPE === 'point2D'}
    <div class="slider-row"><label title={inp.NAME}>{inp.LABEL ?? inp.NAME}.x</label>
      <input type="range" min="0" max="1" step="0.001" value={disp[inp.NAME + '__x']} oninput={(e) => setPoint(inp, 0, e)} /><span class="v">{(disp[inp.NAME + '__x'] ?? 0).toFixed(2)}</span></div>
    <div class="slider-row"><label title={inp.NAME}>{inp.LABEL ?? inp.NAME}.y</label>
      <input type="range" min="0" max="1" step="0.001" value={disp[inp.NAME + '__y']} oninput={(e) => setPoint(inp, 1, e)} /><span class="v">{(disp[inp.NAME + '__y'] ?? 0).toFixed(2)}</span></div>
  {/if}
{/snippet}

<style>
  .studio { display: grid; grid-template-columns: minmax(0, 1.8fr) minmax(0, 0.9fr) minmax(0, 1.6fr); gap: 14px; align-items: stretch; }
  .studio.expanded { grid-template-columns: minmax(0, 1.8fr) 38px minmax(0, 2.5fr); }
  .col { min-width: 0; }
  .stage { position: relative; aspect-ratio: 1 / 1; width: 100%; max-height: min(78vh, 760px); background: #000; overflow: hidden; border: 2px solid var(--line); box-shadow: 6px 6px 0 var(--line); }
  .stage canvas { width: 100%; height: 100%; display: block; object-fit: cover; touch-action: none; }
  .stage canvas.draggable { cursor: crosshair; }
  .badge-live { position: absolute; left: 8px; top: 8px; background: rgba(0,0,0,.7); color: var(--slime); font-size: 11px; padding: 2px 6px; }
  .overlay { position: absolute; left: 0; right: 0; bottom: 0; z-index: 4; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; background: linear-gradient(to top, rgba(0,0,0,.6), rgba(0,0,0,0)); opacity: 0; transform: translateY(8px); transition: opacity .18s ease, transform .18s ease; pointer-events: none; }
  .stage:hover .overlay, .overlay.show, .overlay:focus-within { opacity: 1; transform: none; pointer-events: auto; }
  .ctl-left { display: flex; align-items: center; gap: 6px; }
  .fps { color: #ccc; font-size: 11px; }
  .ctl { font-family: var(--mono); font-size: 14px; line-height: 1; padding: 4px 9px; cursor: pointer; color: #fff; background: rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,.4); }
  .ctl:hover { background: var(--magenta); border-color: var(--magenta); }
  .fs-keep { display: inline-flex; align-items: center; gap: 5px; color: #eee; font-size: 12px; }
  .stage:fullscreen { width: 100vw; height: 100vh; max-height: none; aspect-ratio: auto; border: 0; box-shadow: none; }
  .fs-panel { position: fixed; left: 0; right: 0; bottom: 0; z-index: 6; padding: 8px 14px 12px; max-height: 44vh; overflow: auto; color: #eee; background: rgba(10,10,14,.62); backdrop-filter: blur(8px); border-top: 1px solid rgba(255,255,255,.18); transition: transform .22s ease, opacity .22s ease; }
  .fs-panel.fs-hidden { transform: translateY(100%); opacity: 0; pointer-events: none; }
  .fs-sliders { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 2px 18px; }
  .fs-hotzone { position: fixed; left: 0; right: 0; bottom: 0; height: 52px; z-index: 5; }
  .col-params, .col-code { position: relative; border: 2px solid var(--line); background: var(--paper); box-shadow: 3px 3px 0 rgba(0,0,0,.25); }
  .col-params > .inner, .col-code > .inner { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; }
  .col-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; border-bottom: 2px solid var(--line); background: #cbc9bb; }
  .head-right { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; }
  .jump { display: inline-flex; gap: 4px; margin-right: 2px; }
  .jump-btn, .expand-btn { font-family: var(--mono); font-size: 11px; padding: 1px 6px; background: var(--paper); color: #000; border: 2px outset var(--paper); cursor: pointer; }
  .jump-btn:hover, .expand-btn:hover { background: var(--slime); }
  .link-btn { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; background: none; border: none; color: var(--link); cursor: pointer; text-decoration: underline; padding: 0; }
  .link-btn:hover { background: var(--slime); color: #000; }
  .pane-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px; }
  .pane-scroll .empty { font-size: 12px; opacity: .7; }
  .pane-editor { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 8px 8px 0; }
  .pane-editor :global(.codearea) { min-height: 0; width: 100%; resize: none; flex: 1; }
  .col-params.rail { box-shadow: none; background: #cbc9bb; }
  .rail-toggle { position: absolute; inset: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: #cbc9bb; border: none; cursor: pointer; font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 2px; }
  .rail-toggle span { writing-mode: vertical-rl; transform: rotate(180deg); }
  .rail-toggle:hover { background: var(--slime); }
  .slider-row { display: grid; grid-template-columns: 84px 1fr 46px; gap: 8px; align-items: center; margin: 4px 0; }
  .slider-row label { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .slider-row input[type='range'] { width: 100%; accent-color: var(--magenta); }
  .slider-row .v { font-size: 11px; text-align: right; font-variant-numeric: tabular-nums; }
  .slider-row input[type='color'] { width: 100%; height: 20px; padding: 0; border: 2px solid var(--line); background: none; }
  .slider-row select { font-family: var(--mono); font-size: 12px; background: #fff; border: 2px inset #999; }
  .dirty { background: var(--magenta); color: #fff; padding: 0 5px; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; border: 1px solid #000; }
  .compile-strip { margin: 6px 8px 0; padding: 6px 8px; background: var(--warn); color: #fff; font-size: 11px; line-height: 1.35; max-height: 90px; overflow: auto; white-space: pre-wrap; border: 2px solid var(--line); }
  .code-actions { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px; }
  .code-actions .btn { font-size: 12px; padding: 3px 9px; border-width: 3px; }
  .code-actions .apply { background: #cbc9bb; opacity: .7; }
  .code-actions .apply.hot { background: var(--slime); opacity: 1; }
  @media (max-width: 1100px) {
    .studio, .studio.expanded { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .col-canvas { grid-column: 1 / -1; }
    .col-params, .col-code { height: 60vh; }
  }
</style>
