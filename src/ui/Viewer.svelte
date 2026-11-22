<script lang="ts">
  // "new": the scratch editor (glslop.com /submit and /preview, minus publishing). Opens a file, raw
  // ISF, or a fork of a corpus shader; autosaves the scratch buffer; shows the compile advisor.
  import { onMount } from 'svelte';
  import type { Studio } from '../studio/api';
  import ShaderStage from './ShaderStage.svelte';
  import VideoExport from '@glslop/ui/VideoExport.svelte';
  import { exportAdapters } from './adapters';
  import { fmtMs, speedClass } from './format';
  import { autosaveAction, autosaveName, shaderFileName, type DocSource } from './edits';

  let { studio, params }: { studio: Studio; params: Record<string, any> } = $props();
  const SCRATCH = `/*{
  "DESCRIPTION": "a fresh start",
  "INPUTS": [ { "NAME": "speed", "TYPE": "float", "DEFAULT": 1.0, "MIN": 0.0, "MAX": 4.0 } ]
}*/
void main(){
  vec2 uv = isf_FragNormCoord;
  vec3 c = 0.5 + 0.5*cos(TIME*speed + uv.xyx*6.0 + vec3(0,2,4));
  gl_FragColor = vec4(c, 1.0);
}
`;
  const scratchPath = `${studio.host.paths.workspace}/scratch.fs`;
  // Anything that isn't the scratch buffer is autosaved here while it differs from what was opened.
  // Keyed by where the document came from (file path, forked shader id, or the title of raw isf), so
  // two documents with the same title never share one.
  const autosavePath = (doc: DocSource, t: string) => `${studio.host.paths.workspace}/autosave/${autosaveName(doc, t)}`;
  let doc: DocSource = { title: 'scratch' };
  let recovered = $state<string | null>(null);
  let autosaved = false;
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  let autosaveFailed = false;
  function restoreAutosave() { if (recovered === null) return; initial = recovered; recovered = null; key++; }
  function discardAutosave() { recovered = null; studio.host.remove(autosavePath(doc, title)).catch(() => {}); }
  let initial = $state<string | null>(null);
  let title = $state<string>(params.title ?? 'scratch');
  let current = '';
  let advice = $state<any>(null);
  let compileMs = $state<number | null>(null);
  let liveInputs = $state<Record<string, any>>({});
  let key = $state(0);
  let adviceTimer: ReturnType<typeof setTimeout> | undefined;
  let pubTitle = $state('');
  let pubTags = $state('');
  let pubBusy = $state(false);
  let pubMsg = $state<string | null>(null);
  let forkOf = $state<string | null>(null);
  let account = $state(studio.state.account ?? { signedIn: false, handle: null });
  async function publish(draft = false) {
    pubBusy = true; pubMsg = null;
    try {
      const r = await studio.call('publish', {
        isf: current || initial, title: pubTitle || title, draft,
        tags: pubTags.split(',').map((t) => t.trim()).filter(Boolean),
        parents: forkOf ? [forkOf] : undefined,
      }, { caller: 'ui' });
      pubMsg = r.published ? `published ✓ ${r.url ?? ''}` : r.draft ? 'draft staged — finish in your browser' : (r.reason ?? 'not published');
    } catch (e) { pubMsg = 'failed: ' + (e as Error).message; }
    finally { pubBusy = false; }
  }

  let loadSeq = 0;
  async function load(p: Record<string, any>) {
    // Read everything first, then show it in one step. Setting `initial` before an await would mount
    // the editor, and the `key++` after it would mount it again: a second compile, and anything typed
    // in between lost.
    const mine = ++loadSeq;
    let src: string, name: string, d: DocSource;
    if (p.path) { src = await studio.host.readText(p.path); name = p.path.split(/[\\/]/).pop(); d = { path: p.path }; }
    else if (p.isf) { src = p.isf; name = p.title ?? 'untitled'; d = p.forkOf ? { forkOf: p.forkOf } : { title: name }; }
    else if (p.id) { const s = studio.state.shader(p.id); src = s?.isf ?? SCRATCH; name = `${s?.title ?? p.id} (fork)`; d = { forkOf: p.id }; }
    else { src = await studio.host.readText(scratchPath).catch(() => SCRATCH); name = 'scratch'; d = { title: 'scratch' }; }
    const saved = name === 'scratch' ? null : await studio.host.readText(autosavePath(d, name)).catch(() => null);
    if (mine !== loadSeq) return; // a newer open overtook this one
    clearTimeout(autosaveTimer);
    initial = src; title = name; doc = d;
    forkOf = p.forkOf ?? p.id ?? null;
    pubTitle = title.replace(/ \(fork\)$/, '');
    autosaved = false;
    recovered = autosaveAction(src, saved) === 'offer' ? saved : null;
    key++;
  }

  function onSource(src: string) {
    current = src;
    clearTimeout(adviceTimer);
    adviceTimer = setTimeout(async () => {
      advice = await studio.call('advise', { isf: src }, { caller: 'ui' }).catch(() => null);
    }, 600);
    // Saving doesn't wait for the advisor (a slow advise must not delay or skip it).
    clearTimeout(autosaveTimer);
    const d = doc, t = title, opened = initial;
    autosaveTimer = setTimeout(() => {
      const fail = (e: unknown) => {
        if (autosaveFailed) return;
        autosaveFailed = true;
        studio.toast(`autosave failed: ${(e as Error)?.message ?? e}`, 'error');
      };
      const ok = () => { autosaveFailed = false; };
      if (t === 'scratch') { studio.host.writeText(scratchPath, src).then(ok, fail); return; }
      // Don't overwrite an autosave the human hasn't decided about yet.
      if (recovered !== null || opened === null) return;
      if (src !== opened) { autosaved = true; studio.host.writeText(autosavePath(d, t), src).then(ok, fail); }
      else if (autosaved) { autosaved = false; studio.host.remove(autosavePath(d, t)).catch(() => {}); }
    }, 500);
  }

  async function openFile() {
    const files = (await studio.host.list(`${studio.host.paths.workspace}/shaders`)).filter((f) => /\.(fs|frag|glsl|isf)$/i.test(f.name));
    studio.state.fileList = files;
    studio.toast(files.length ? `workspace/shaders has ${files.length} file(s): ${files.slice(0, 6).map((f) => f.name).join(', ')}` : 'no .fs files in workspace/shaders yet');
  }

  onMount(() => {
    load(params);
    const offs = [studio.events.on('viewer:open', (p) => load(p)), studio.events.on('account:changed', (a) => (account = a))];
    return () => offs.forEach((o) => o());
  });
</script>

<div class="page">
  <div class="headrow">
    <span class="kicker">new</span>
    <h2>{title}</h2>
    <span class="grow"></span>
    <button class="btn" onclick={() => load({ isf: SCRATCH, title: 'scratch' })}>+ blank</button>
    <button class="btn" onclick={openFile}>workspace files</button>
    <button class="btn" onclick={() => studio.host.open(`${studio.host.paths.workspace}/shaders`)}>open folder</button>
  </div>
  {#if recovered !== null}
    <div class="recover">edits to <b>{title}</b> from last time were autosaved.
      <button class="btn" onclick={restoreAutosave}>restore them</button>
      <button class="btn" onclick={discardAutosave}>discard</button></div>
  {/if}
  {#if initial !== null}
    {#key key}
      <ShaderStage {studio} isf={initial} filename={shaderFileName(title)} editor
        onCompiled={(ms: number) => (compileMs = ms)} onInputs={(v: Record<string, any>) => (liveInputs = v)} {onSource} />
    {/key}
  {/if}

  <div class="panel publish">
    <span class="kicker">publish</span>
    <label>title <input class="txt" bind:value={pubTitle} maxlength="120" /></label>
    <label>tags <input class="txt" bind:value={pubTags} placeholder="comma, separated, max 8" /></label>
    {#if forkOf}<span class="muted">forked from #{forkOf}</span>{/if}
    {#if account.signedIn}
      <button class="btn" disabled={pubBusy} onclick={() => publish(false)}>{pubBusy ? '…' : `publish as @${account.handle}`}</button>
      <button class="linkish" disabled={pubBusy} onclick={() => publish(true)}>or stage a draft</button>
    {:else}
      <button class="btn" disabled={pubBusy} onclick={() => studio.call('account.signIn', {}, { caller: 'ui' })}>login to publish</button>
      <button class="linkish" disabled={pubBusy} onclick={() => publish(true)}>or stage a draft (no account)</button>
    {/if}
    {#if pubMsg}<div class="notice">{pubMsg}</div>{/if}
    <div class="muted small">everything posted is CC0. you'll see exactly what's sent and confirm before anything goes public.</div>
  </div>

  {#if advice}
    <div class="panel advice">
      <span class="kicker">compile advisor</span>
      <span class="chip {speedClass(compileMs)}">{studio.host.boot.angleBackend} {fmtMs(compileMs)}</span>
      <span>~{advice.estimate.inlined_statements} inlined statements · {advice.estimate.verdict} (what Chrome on Windows would pay)</span>
      {#each advice.findings as f}
        <div class="finding {f.severity}">
          <b>{f.severity}</b> {#if f.line}<span class="muted">line {f.line}</span>{/if} {f.message}
          {#if f.fix}<div class="fix">→ {f.fix}</div>{/if}
        </div>
      {/each}
      {#if !advice.findings.length}<div class="muted">no findings. nice and lean.</div>{/if}
    </div>
  {/if}

  {#if initial !== null}{#key key}<VideoExport {...exportAdapters(studio)} isf={current || initial} name={title.replace(/[^\w.-]+/g, '_')} {liveInputs} />{/key}{/if}
</div>

<style>
  .page { max-width: 1600px; margin: 0 auto; padding: 14px 24px 40px; }
  .headrow { display: flex; gap: 10px; align-items: baseline; margin-bottom: 12px; }
  .headrow h2 { margin: 0; }
  .recover { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; padding: 8px 12px; border: 2px solid var(--line); background: var(--paper); font-size: 13px; }
  .grow { flex: 1; }
  .headrow .btn { font-size: 12px; padding: 2px 9px; border-width: 3px; }
  .advice { font-size: 12px; }
  .publish { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; font-size: 13px; }
  .publish label { display: inline-flex; gap: 6px; align-items: center; }
  .publish .txt { min-width: 220px; }
  .publish .notice { flex-basis: 100%; margin: 4px 0 0; }
  .small { font-size: 11px; flex-basis: 100%; }
  .linkish { background: none; border: none; padding: 0; color: var(--link); text-decoration: underline; cursor: pointer; font: inherit; }
  .advice > span { margin-right: 8px; }
  .finding { margin: 6px 0; }
  .finding.high b { color: var(--warn); }
  .finding.warn b { color: #b85c00; }
  .fix { margin-left: 12px; opacity: .85; }
</style>
