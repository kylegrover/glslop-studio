<script lang="ts">
  // glslop.com's /shader/[id] page: canvas | params | code, then the info shelf, lineage, export.
  // Everything comes from the local corpus — lineage, forks and texture edges are derived, not fetched.
  import { onMount } from 'svelte';
  import type { Studio } from '../studio/api';
  import { parseISF } from '@glslop/core/parse';
  import { jitterStyle, numJitter, wob } from '@glslop/core/jitter';
  import { fmtMs, speedClass } from './format';
  import ShaderStage from './ShaderStage.svelte';
  import VideoExport from '@glslop/ui/VideoExport.svelte';
  import { exportAdapters } from './adapters';

  let { studio, params }: { studio: Studio; params: Record<string, any> } = $props();
  const s = studio.state.shader(params.id);
  const lin = s ? studio.state.lineage(s.id) : null;
  const parsed = s ? parseISF(s.isf) : null;
  const header = parsed?.ok ? parsed.isf.header : null;
  const description = (header?.DESCRIPTION ?? '').trim();
  const credit = (header?.CREDIT ?? '').trim();
  const categories = Array.isArray(header?.CATEGORIES) ? header!.CATEGORIES.filter(Boolean) : [];
  const paramCount = parsed?.ok ? parsed.isf.inputs.length : 0;
  const passCount = parsed?.ok ? parsed.isf.passes.length : 0;
  const backend = studio.host.boot.angleBackend;
  const slug = (s?.title ?? 'shader').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'shader';
  let compileMs = $state<number | null>(null);
  let liveInputs = $state<Record<string, any>>({});
  let advice = $state<any>(null);
  const site = studio.state.corpus?.base ?? 'https://glslop.com';

  const go = (id: string) => studio.views.open('shader', { id });
  const tagFilter = (tag: string) => { studio.views.open('browse', { tag, q: '', author: '' }); };
  const byAuthor = (author: string) => { studio.views.open('browse', { author, tag: '', q: '' }); };

  onMount(() => {
    if (s) studio.call('advise', { id: s.id }, { caller: 'ui' }).then((a) => (advice = a)).catch(() => {});
  });
</script>

{#if !s}
  <div class="wrap"><div class="notice">not found: {params.id}. <button class="linkish" onclick={() => studio.views.open('browse')}>back to browse</button></div></div>
{:else}
  {#if lin?.newer}
    <div class="wrap"><div class="notice">↻ a <b>newer version</b> of this shader exists:
      <button class="linkish" onclick={() => go(lin.newer.id)}>{lin.newer.title} <code>#{lin.newer.id}</code></button>
      — this one is kept as-is but no longer shows in browse.</div></div>
  {/if}
  <div class="shaderpage">
    <ShaderStage {studio} isf={s.isf} shaderId={s.id} filename={`${slug}-${s.id}.fs`}
      onCompiled={(ms: number) => (compileMs = ms)} onInputs={(v: Record<string, any>) => (liveInputs = v)} />

    <div class="info-shelf">
      <div class="shelf-top">
        <div class="title-line">
          <h2 style={jitterStyle(numJitter(s.id + 't'))}>{s.title}</h2>
          <code class="idtag" style={wob(s.id)}>#{s.id}</code>
        </div>
        <div class="actions">
          <span class="slops"><b class="num" style={wob(s.id + 'slop')}>{s.stats?.slops ?? 0}</b> 💧</span>
          <button class="btn" onclick={() => studio.views.open('viewer', { isf: s.isf, title: `${s.title} (fork)`, forkOf: s.id })}>⑂ fork it</button>
          <button class="btn" onclick={() => studio.host.open(`${site}/shader/${s.id}`)}>↗ glslop.com</button>
          <button class="btn" onclick={() => studio.host.open(`${site}/api/v1/shaders/${s.id}`)}>{'{ }'} json</button>
        </div>
      </div>

      {#if description}<p class="isf-desc">{description}</p>{/if}

      {#if s.tags?.length || categories.length}
        <div class="tags">
          {#each s.tags ?? [] as t}<button class="tag" onclick={() => tagFilter(t)}>#{t}</button>{/each}
          {#each categories as c}<span class="cat" title="ISF category">{c}</span>{/each}
        </div>
      {/if}

      <div class="provenance">
        <span>by <button class="linkish" onclick={() => byAuthor(s.author_name)}>{s.author_name ?? 'anon'}</button></span>
        {#if s.provenance_type}<span class="badge {s.provenance_type}">{s.provenance_type}</span>{/if}
        {#if s.made_with}<span>made with <b>{s.made_with}</b></span>{/if}
        <span><b>{s.license ?? 'CC0-1.0'}</b></span>
        {#if credit}<span>credit: <b>{credit}</b></span>{/if}
        <span class="sep" aria-hidden="true">·</span>
        <span>created {new Date(s.created_at).toISOString().slice(0, 16).replace('T', ' ')}Z</span>
        <span class="num" style={wob(s.id + 'v')}>{(s.stats?.views ?? 0).toLocaleString('en-US')} views</span>
        <span class="num" style={wob(s.id + 'f')}>{(s.stats?.forks ?? 0).toLocaleString('en-US')} forks</span>
        {#if paramCount}<span class="num">{paramCount} param{paramCount === 1 ? '' : 's'}</span>{/if}
        {#if passCount > 1}<span class="badge multipass">multipass ×{passCount}</span>{/if}
        {#if s.generator?.model || s.generator?.provider}<span class="modeltag">{[s.generator.model, s.generator.provider].filter(Boolean).join(' · ')}</span>{/if}
        {#if s.generator?.prompt}
          <details class="genprompt"><summary>generation prompt</summary><p>{s.generator.prompt}</p></details>
        {/if}
      </div>

      <div class="provenance compile">
        <span class="chip {speedClass(compileMs)}">{backend} {fmtMs(compileMs)}</span>
        <span class="chip {speedClass(s.ref_compile_ms)}" title="what Chrome on Windows pays (ANGLE/D3D11/FXC, RTX 3090)">d3d11 ref {fmtMs(s.ref_compile_ms)}</span>
        {#if advice}
          <span>~{advice.estimate.inlined_statements} inlined statements · {advice.estimate.verdict}</span>
          {#if advice.findings.length}<button class="linkish" onclick={() => studio.views.open('viewer', { isf: s.isf, title: s.title, forkOf: s.id })}>{advice.findings.length} compile tip{advice.findings.length === 1 ? '' : 's'} →</button>{/if}
        {/if}
      </div>
    </div>

    {#if lin && (lin.replaces || lin.parents.length || lin.children.length || lin.textureSources.length || lin.textureUsers.length)}
      <div class="panel lineage">
        <span class="kicker">lineage</span>
        <div class="lin-band">
          {#if lin.replaces}<div class="lin-row"><span class="k">replaces</span><div class="lin-chips"><button class="lin-link" onclick={() => go(lin.replaces.id)}>{lin.replaces.title} <code>#{lin.replaces.id}</code></button></div></div>{/if}
          {#if lin.parents.length}<div class="lin-row"><span class="k">{lin.parents.length > 1 ? 'derived from' : 'forked from'}</span><div class="lin-chips">{#each lin.parents as p}<button class="lin-link" onclick={() => go(p.id)}>{p.title} <code>#{p.id}</code></button>{/each}</div></div>{/if}
          {#if lin.children.length}<div class="lin-row"><span class="k">forks ({lin.children.length})</span><div class="lin-chips">{#each lin.children as c}<button class="lin-link" onclick={() => go(c.id)}>{c.title} <code>#{c.id}</code></button>{/each}</div></div>{/if}
          {#if lin.textureSources.length}<div class="lin-row"><span class="k">uses texture from</span><div class="lin-chips">{#each lin.textureSources as t}<button class="lin-link" onclick={() => go(t.id)}>🖼 {t.title} <code>#{t.id}</code></button>{/each}</div></div>{/if}
          {#if lin.textureUsers.length}<div class="lin-row"><span class="k">texture used by ({lin.textureUsers.length})</span><div class="lin-chips">{#each lin.textureUsers as t}<button class="lin-link" onclick={() => go(t.id)}>{t.title} <code>#{t.id}</code></button>{/each}</div></div>{/if}
        </div>
      </div>
    {/if}

    <VideoExport {...exportAdapters(studio)} isf={s.isf} name={`${slug}-${s.id}`} {liveInputs} />
  </div>
{/if}

<style>
  .wrap { max-width: 1400px; margin: 0 auto; padding: 0 14px; }
  .shaderpage { max-width: 1600px; margin: 0 auto; padding: 14px 24px 40px; }
  .info-shelf { margin: 16px 0; padding: 12px 14px; border: 2px solid var(--line); background: var(--paper); box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.25); }
  .shelf-top { display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; }
  .actions { display: flex; align-items: center; gap: 8px 10px; flex-wrap: wrap; }
  .actions .btn { font-size: 13px; padding: 3px 10px; border-width: 3px; }
  .slops { font-size: 18px; }
  .title-line { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .title-line h2 { margin: 0; }
  .idtag { background: #000; color: var(--slime); padding: 1px 6px; font-size: 13px; }
  .isf-desc { margin: 10px 0 0; font-size: 14px; line-height: 1.5; max-width: 70ch; white-space: pre-wrap; }
  .tags { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { cursor: pointer; font-family: var(--mono); color: #000; }
  .cat { font-size: 12px; padding: 1px 7px; background: #d9d7ca; border: 1px dashed var(--line); opacity: 0.85; }
  .provenance { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 10px; padding-top: 9px; border-top: 1px dotted var(--line); font-size: 12px; opacity: 0.85; }
  .provenance .sep { opacity: 0.4; }
  .provenance .modeltag { font-size: 11px; opacity: 0.75; }
  .provenance .multipass { text-transform: none; background: #eae8dc; }
  .provenance.compile { opacity: 1; }
  .genprompt { font-size: 12px; flex-basis: 100%; margin-top: 2px; }
  .genprompt summary { cursor: pointer; opacity: 0.75; }
  .genprompt p { margin: 6px 0 0; white-space: pre-wrap; opacity: 0.85; max-height: 180px; overflow: auto; }
  .lineage { font-size: 13px; }
  .lin-band { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .lin-row { display: grid; grid-template-columns: 130px 1fr; gap: 8px; padding: 4px 0; border-bottom: 1px dotted var(--line); align-items: baseline; }
  .lin-row .k { opacity: 0.7; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
  .lin-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .lin-link { display: inline-block; border: 2px outset #fff; padding: 1px 6px; background: #fff; color: #000; font-family: var(--mono); font-size: 12px; cursor: pointer; }
  .lin-link:hover { background: var(--magenta); color: #fff; }
  .linkish { background: none; border: none; padding: 0; color: var(--link); text-decoration: underline; cursor: pointer; font: inherit; }
  .linkish:hover { background: var(--slime); color: #000; }
</style>
