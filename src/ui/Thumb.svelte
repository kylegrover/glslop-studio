<script lang="ts">
  // A lazily-requested thumbnail for one shader (cached URL immediately, else render on first sight).
  import { onMount } from 'svelte';
  import type { Studio } from '../studio/api';
  let { studio, id }: { studio: Studio; id: string } = $props();
  let url = $state<string | null>(studio.state.thumbs?.cached(id) ?? null);
  let el: HTMLElement;
  onMount(() => {
    if (url) return;
    const io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting) { io.disconnect(); studio.state.thumbs?.request(id, 1).then((u: string | null) => (url = u)); }
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => { io.disconnect(); if (!url) studio.state.thumbs?.cancel(id); };
  });
</script>

<span class="thumb" bind:this={el}>{#if url}<img src={url} alt="" draggable="false" />{/if}</span>

<style>
  .thumb { display: block; width: 100%; height: 100%; background: #111; }
  img { width: 100%; height: 100%; object-fit: cover; display: block; }
</style>
