<script lang="ts">
  // Syntax-highlighted ISF editor: a transparent <textarea> over a highlighted <pre>,
  // scroll-synced. The two layers share identical box metrics (font, line-height,
  // padding, white-space) so the caret lines up with the painted glyphs underneath.
  import { tick } from 'svelte';
  import { highlightIsf } from '@glslop/core/highlight';
  import { MAX_ISF_BYTES, MAX_ISF_LABEL } from '@glslop/core/limits';
  import './code.css';

  interface Props {
    value: string;
    oninput?: () => void;
  }
  let { value = $bindable(), oninput }: Props = $props();

  let ta: HTMLTextAreaElement;
  let pre: HTMLPreElement;
  let fileInput: HTMLInputElement;
  let dragging = $state(false);
  let fileError = $state<string | null>(null);
  const SHADER_FILE = /\.(?:fs|frag|glsl|isf)$/i;

  // trailing newline keeps the painted layer as tall as the textarea's phantom last line
  const hl = $derived(highlightIsf(value) + '\n');

  // Live size against the submit ceiling. This WARNS and never blocks: an over-size shader still
  // edits, highlights, compiles and previews exactly as before — you just can't publish it until
  // it fits, and you find that out here instead of after a poster render and a 413.
  //
  // Must be UTF-8 bytes to agree with the server's Buffer.byteLength check; value.length would
  // under-count any shader with non-ASCII comments and let it sail past this warning into a
  // rejection. Re-encoding the whole document per keystroke is free next to highlightIsf(), which
  // already re-highlights the entire source on the same beat.
  const encoder = new TextEncoder();
  const bytes = $derived(encoder.encode(value).length);
  const overBy = $derived(bytes - MAX_ISF_BYTES);
  // Stay invisible until it could plausibly matter — a typical shader is a few KB and never
  // sees this. 80% is close enough to be a useful heads-up while there's still room to react.
  const showSize = $derived(bytes >= MAX_ISF_BYTES * 0.8);
  const kib = (n: number) => (n / 1024).toFixed(1);
  // Composed here rather than as markup: an inline {#if} mid-sentence gets its leading whitespace
  // trimmed, which silently glued the size onto the em dash ("128 KiB— over by").
  const sizeNote = $derived(
    overBy > 0
      ? `${kib(bytes)} / ${MAX_ISF_LABEL} — over by ${kib(overBy)} KiB. keep editing and previewing, but trim it down before submitting.`
      : `${kib(bytes)} / ${MAX_ISF_LABEL}`,
  );

  function sync() {
    if (pre && ta) {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    }
  }

  // Scroll (and optionally place the caret at) a character offset — used by the shader page's
  // "header / code" quick-jump buttons and to land the editor on the GLSL body at first paint.
  export function scrollToChar(index: number, focus = false) {
    if (!ta) return;
    const clamped = Math.max(0, Math.min(index, value.length));
    if (focus) {
      ta.focus();
      ta.setSelectionRange(clamped, clamped);
    }
    const line = value.slice(0, clamped).split('\n').length - 1;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.scrollTop = Math.max(0, line * lh - lh); // one line of context above the target
    sync();
  }
  function onInput() {
    oninput?.();
    sync();
  }

  async function loadFile(file: File) {
    fileError = null;
    if (!SHADER_FILE.test(file.name)) {
      fileError = 'pick an .fs, .frag, .glsl, or .isf shader file.';
      return;
    }
    if (file.size > MAX_ISF_BYTES) {
      fileError = `that shader is over the ${MAX_ISF_LABEL} submission limit.`;
      return;
    }
    try {
      value = await file.text();
      // Let the bound parent observe the source before asking it to compile.
      await tick();
      oninput?.();
      ta?.focus();
      ta?.setSelectionRange(0, 0);
      ta.scrollTop = 0;
      sync();
    } catch {
      fileError = 'could not read that file.';
    }
  }
  function chooseFile() { fileInput?.click(); }
  function onFileChange(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (file) void loadFile(file);
    (e.currentTarget as HTMLInputElement).value = '';
  }
  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragging = true;
  }
  function onDragLeave(e: DragEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) dragging = false;
  }
  function onDrop(e: DragEvent) {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    dragging = false;
    void loadFile(e.dataTransfer.files[0]);
  }
</script>

<div class="codearea" class:dragging ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop}>
  <input bind:this={fileInput} class="file-input" type="file" accept=".fs,.frag,.glsl,.isf,text/plain" onchange={onFileChange} />
  <button type="button" class="open-file" onclick={chooseFile} title="open a shader file">open .fs</button>
  <pre class="hl" aria-hidden="true" bind:this={pre}>{@html hl}</pre>
  <textarea
    class="ed"
    bind:this={ta}
    bind:value
    oninput={onInput}
    onscroll={sync}
    spellcheck="false"
    autocapitalize="off"
    autocomplete="off"
    autocorrect="off"
    wrap="off"
  ></textarea>
  {#if dragging}<div class="drop-cover">drop shader file</div>{/if}
</div>
{#if showSize}
  <p class="size" class:over={overBy > 0}>{sizeNote}</p>
{/if}
{#if fileError}<p class="file-error">{fileError}</p>{/if}

<style>
  .codearea {
    position: relative;
    height: 340px;
    min-height: 200px;
    border: 3px inset #3a3a3a;
    background: #101014;
    overflow: hidden;
    resize: vertical;
  }
  .codearea.dragging { border-color: var(--magenta); }
  .file-input { display: none; }
  .open-file {
    position: absolute;
    z-index: 3;
    top: 5px;
    right: 5px;
    padding: 2px 6px;
    font: 10px var(--mono);
    color: #ddd;
    background: rgba(10, 10, 14, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.3);
    cursor: pointer;
  }
  .open-file:hover { color: #fff; background: var(--magenta); border-color: var(--magenta); }
  .hl,
  .ed {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 10px;
    border: 0;
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.5;
    letter-spacing: 0;
    tab-size: 2;
    white-space: pre;
    word-wrap: normal;
    overflow: auto;
  }
  .hl {
    z-index: 0;
    color: #c8f6b0;
    background: transparent;
    pointer-events: none;
    overflow: hidden;
  }
  .ed {
    z-index: 1;
    color: transparent;
    background: transparent;
    caret-color: #b6ff5c;
    resize: none;
    outline: none;
  }
  .ed::selection {
    background: rgba(163, 230, 53, 0.3);
  }
  /* Below the editor, not floating inside it: an overlay pinned to a corner would sit on top of
     the textarea's own scrollbars, and occluding a control the author is trying to drag is worse
     than one more line of layout. This only appears near the ceiling, so the shift is rare. */
  .size {
    margin: 4px 0 0;
    font: 12px var(--mono);
    color: #8a8a8a;
  }
  .size.over {
    color: var(--magenta);
    font-weight: 700;
  }
  .drop-cover {
    position: absolute;
    z-index: 4;
    inset: 0;
    display: grid;
    place-items: center;
    color: #fff;
    font: 700 14px var(--mono);
    background: rgba(15, 0, 25, 0.78);
    pointer-events: none;
  }
  .file-error { margin: 4px 0 0; color: var(--magenta); font-size: 12px; }
</style>
