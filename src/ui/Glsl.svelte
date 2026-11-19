<script lang="ts">
  // glslop.com /glsl and /glsl/[slug]: technique explainers beside a running example, plus every shader
  // in the corpus that uses the technique. Membership = local feature extractor (same code as the
  // server's programmatic layer) ∪ normalized author tags. The server's optional LLM layer isn't public.
  import type { Studio } from '../studio/api';
  import { GLSL_PAGES, pageForSlug } from '@glslop/core/glsl-pages';
  import { extractFeatures } from '@glslop/core/extract';
  import { normalizeTechniqueName } from '@glslop/core/vocab';
  import ShaderStage from './ShaderStage.svelte';
  import Thumb from './Thumb.svelte';

  let { studio, params }: { studio: Studio; params: Record<string, any> } = $props();
  const page = params.slug ? pageForSlug(params.slug) : undefined;

  // Feature extraction is pure and fast; memoize per source on the studio so it runs once per shader.
  const memo: Map<string, string[]> = (studio.state.techniqueMemo ??= new Map());
  function techniquesOf(s: any): string[] {
    let t = memo.get(s.id);
    if (!t) {
      t = extractFeatures(s.isf).techniques.map((x) => x.name);
      for (const tag of s.tags ?? []) { const n = normalizeTechniqueName(tag)?.name; if (n) t.push(n); }
      memo.set(s.id, t);
    }
    return t;
  }
  const listed = (studio.state.corpus?.shaders ?? []).filter((s: any) => s.listed);
  const using = (technique: string) => listed.filter((s: any) => techniquesOf(s).includes(technique)).sort((a: any, b: any) => (b.stats?.views ?? 0) - (a.stats?.views ?? 0));
  const others = GLSL_PAGES.filter((p) => p.slug !== page?.slug);
</script>

<div class="wrap">
  {#if !page}
    <section class="panel">
      <span class="kicker">learn</span>
      <h2>glsl techniques</h2>
      <p class="lede">Short explanations of the ideas behind the shaders here. Every page has a minimal example running next to the text — edit it, break it, fork it — and links to every shader in the corpus that uses the technique. All CC0, so take any of it.</p>
      <ul class="cards">
        {#each GLSL_PAGES as p}
          {@const all = using(p.technique)}
          <li>
            <button class="card" onclick={() => studio.views.open('glsl', { slug: p.slug })}>
              <div class="strip">
                {#each all.slice(0, 4) as t (t.id)}<span class="ph"><Thumb {studio} id={t.id} /></span>{/each}
                {#if !all.length}<span class="ph wide"></span>{/if}
              </div>
              <div class="body"><h3>{p.title}</h3><p>{p.summary}</p><span class="count">{all.length} shader{all.length === 1 ? '' : 's'} &rarr;</span></div>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {:else}
    {@const shaders = using(page.technique)}
    <article class="panel glsl">
      <header class="head">
        <button class="crumb linkish" onclick={() => studio.views.open('glsl', {})}>&larr; glsl techniques</button>
        <h2>{page.title}</h2>
      </header>
      <p class="summary">{page.summary}</p>
      <div class="demo">
        <span class="kicker">try it — this is running</span>
        <ShaderStage {studio} isf={page.example.isf} filename={`glsl-${page.slug}.fs`} />
        <p class="caption">{page.example.caption}</p>
      </div>
      <div class="read">
        {#each page.explainer as para}<p>{para}</p>{/each}
        {#if page.excerpts?.length}
          <section class="excerpts">
            <span class="kicker">in the wild</span>
            {#each page.excerpts as ex}
              <figure>
                <figcaption>{ex.label} — <button class="linkish" onclick={() => studio.views.open('shader', { id: ex.shaderId })}>#{ex.shaderId}</button></figcaption>
                <pre><code>{ex.code}</code></pre>
                <p>{ex.note}</p>
              </figure>
            {/each}
          </section>
        {/if}
      </div>
      <section class="gallery">
        <div class="ghead"><h3>{shaders.length} shader{shaders.length === 1 ? '' : 's'} using this</h3><span class="hint">most-seen first · all CC0, take any of it</span></div>
        <ul class="grid">
          {#each shaders as s (s.id)}
            <li><button class="tile" onclick={() => studio.views.open('shader', { id: s.id })}><span class="thumb"><Thumb {studio} id={s.id} /></span><span class="cap">{s.title}</span></button></li>
          {/each}
        </ul>
      </section>
      <nav class="more">
        <span class="kicker">more techniques</span>
        <ul>{#each others as p}<li><button class="linkish" onclick={() => studio.views.open('glsl', { slug: p.slug })}>{p.title}</button> <span>{p.summary}</span></li>{/each}</ul>
      </nav>
    </article>
  {/if}
</div>

<style>
  .wrap { max-width: 1400px; margin: 0 auto; padding: 0 14px 40px; }
  .lede { max-width: 75ch; }
  .linkish { background: none; border: none; padding: 0; color: var(--link); text-decoration: underline; cursor: pointer; font: inherit; }
  .linkish:hover { background: var(--slime); color: #000; }
  .cards { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 12px; }
  .card { display: flex; flex-direction: column; height: 100%; width: 100%; text-align: left; padding: 0; background: none; color: inherit; border: 1px solid #8080808c; cursor: pointer; font-family: var(--mono); }
  .card:hover { border-color: var(--slime); }
  .strip { display: grid; grid-template-columns: repeat(4, 1fr); background: #000; }
  .strip .ph { width: 100%; aspect-ratio: 1; display: block; overflow: hidden; background: #111; }
  .strip .ph.wide { grid-column: 1 / -1; aspect-ratio: 4; }
  .body { padding: 10px 12px 12px; display: flex; flex-direction: column; flex: 1; }
  .body h3 { margin: 0 0 5px; font-size: 16px; }
  .body p { margin: 0 0 10px; font-size: 13px; line-height: 1.55; opacity: .9; flex: 1; }
  .count { font-size: 11px; opacity: .7; }
  .crumb { font-size: 12px; opacity: .7; }
  .head h2 { margin: 4px 0 10px; }
  .summary { font-size: 15.5px; line-height: 1.6; max-width: 75ch; }
  .demo { margin: 12px 0 20px; }
  .caption { font-size: 12px; line-height: 1.5; opacity: .78; margin: 12px 0 0; }
  .read { max-width: 75ch; }
  .read > p { font-size: 14.5px; line-height: 1.7; margin: 0 0 14px; }
  .excerpts { margin-top: 24px; }
  .excerpts figure { margin: 0 0 18px; }
  .excerpts figcaption { font-size: 12px; opacity: .8; }
  .excerpts pre { overflow-x: auto; background: #0d0d12; color: #d8d8d8; padding: 10px; font-size: 11.5px; line-height: 1.5; margin: 6px 0 0; }
  .excerpts p { font-size: 13.5px; line-height: 1.6; margin: 8px 0 0; }
  .gallery { margin-top: 32px; }
  .ghead { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .ghead h3 { margin: 0; font-size: 16px; }
  .hint { font-size: 11px; opacity: .6; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 7px; list-style: none; padding: 0; margin: 12px 0 0; }
  .tile { display: block; width: 100%; padding: 0; background: none; border: none; color: inherit; cursor: pointer; text-align: left; font-family: var(--mono); }
  .tile .thumb { display: block; width: 100%; aspect-ratio: 1; overflow: hidden; background: #000; }
  .tile .cap { display: block; font-size: 11px; padding: 3px 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tile:hover .cap { text-decoration: underline; }
  .more { margin-top: 30px; font-size: 13px; }
  .more ul { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
  .more li span { opacity: .8; }
</style>
