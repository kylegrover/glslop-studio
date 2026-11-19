<script lang="ts">
    // Shared by glslop.com and glslop studio. Host differences are adapters:
  //  save(blob, filename) -> where the file goes (browser download / workspace folder); returns a label
  //  onStart / onEnd      -> pause the page's live renderer while exporting
  //  reveal(label)        -> optional "open" button after saving (desktop)
  import { EXPORT_CAPS, exportVideo, type VideoFormat, type ExportQuality } from '@glslop/core/export-video';
  import { parseISF } from '@glslop/core/parse';
  import { defaultFor } from '@glslop/core/runtime';
  import { buildAutoMotion, type MotionMode } from '@glslop/core/auto-motion';

  interface Props {
    save?: (blob: Blob, filename: string) => Promise<string | void>;
    onStart?: () => void;
    onEnd?: () => void;
    reveal?: (saved: string) => void;
    /** Wording: 'in your browser' or 'on your gpu' etc. */
    where?: string;
    liveInputs?: Record<string, number | boolean | number[]> | null;
    isf: string;
    name?: string; // download basename, e.g. "liquid-moss-qkr5vof8"
  }
  let { isf, name = 'shader', liveInputs = null, save = browserDownload, onStart, onEnd, reveal, where = 'in your browser' }: Props = $props();
  async function browserDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return filename;
  }

  let format = $state<VideoFormat>('mp4');
  let lengthUnit = $state<'sec' | 'frames'>('sec');
  let length = $state(12); // seconds when unit=sec, frame count when unit=frames
  let startFrame = $state(0);
  let fps = $state(30);
  // width×height presets — square, landscape 16:9, and portrait 4:5 / 9:16 for Instagram feed &
  // Reels/Stories. Bound by reference (Svelte binds the object value).
  const SIZES = [
    { label: '512²', w: 512, h: 512 },
    { label: '720²', w: 720, h: 720 },
    { label: '1080²', w: 1080, h: 1080 },
    { label: '1280×720 · 16:9', w: 1280, h: 720 },
    { label: '1920×1080 · 16:9', w: 1920, h: 1080 },
    { label: '1080×1350 · 4:5 portrait', w: 1080, h: 1350 },
    { label: '1080×1920 · 9:16 reel', w: 1080, h: 1920 },
  ];
  let size = $state(SIZES[0]);
  let quality = $state<ExportQuality>('high');
  let motion = $state<'static' | MotionMode>('static');
  // Gacha roll. buildAutoMotion is deterministic *given a seed*, so variety comes from rolling a fresh
  // token per export rather than from randomness inside the generator. The token is shown + copyable so
  // a clip you like is reproducible (paste it back to get the exact same motion); 🔒 pins it so repeated
  // exports — or tweaking other settings — reproduce instead of re-rolling.
  function newRoll(): string {
    return Math.random().toString(36).slice(2, 8);
  }
  let roll = $state(newRoll());
  let rollLocked = $state(false);
  let rollCopied = $state(false);

  function reroll() {
    roll = newRoll();
    rollCopied = false;
  }
  async function copyRoll() {
    try {
      await navigator.clipboard.writeText(roll);
      rollCopied = true;
      setTimeout(() => (rollCopied = false), 1500);
    } catch {
      /* clipboard blocked — the token is visible in the field to copy by hand */
    }
  }
  // GIF holds every frame in memory at once (no streaming encoder), so it keeps a much tighter frame
  // cap than video regardless of the shared EXPORT_CAPS.maxFrames — clamp the length field itself
  // rather than letting the export silently trim a request the UI implied was fine.
  const effectiveMaxFrames = $derived(format === 'gif' ? Math.min(EXPORT_CAPS.maxFrames, EXPORT_CAPS.maxGifFrames) : EXPORT_CAPS.maxFrames);
  const maxLength = $derived(
    lengthUnit === 'frames' ? effectiveMaxFrames : Math.min(EXPORT_CAPS.maxSeconds, effectiveMaxFrames / fps),
  );

  // Parsed once per shader (isf prop is static per page) so the motion selector knows which float
  // knobs exist without needing a live renderer instance.
  const parsedInputs = $derived.by(() => {
    const r = parseISF(isf);
    return r.ok ? r.isf.inputs : [];
  });
  const hasFloatKnobs = $derived(parsedInputs.some((i) => i.TYPE === 'float' && typeof i.MIN === 'number' && typeof i.MAX === 'number'));

  // Live knob values broadcast by ShaderCanvas (separate island) via window. When present + opted-in,
  // the export reproduces the visitor's current tweaks instead of the ISF defaults.
  let useLive = $state(true);
  const hasKnobs = $derived(!!liveInputs && Object.keys(liveInputs).length > 0);


  // Soft warning only — the hard technical ceiling lives in EXPORT_CAPS (export-video.ts) and is much
  // higher. 60s is just where we think it's worth a visitor double-checking they meant it, not a limit.
  const LENGTH_WARN_SECONDS = 60;
  const lengthWarning = $derived.by(() => {
    if (format === 'gif') return null; // GIF's own maxGifFrames cap already keeps it well under this
    const secs = lengthUnit === 'frames' ? length / fps : length;
    if (secs <= LENGTH_WARN_SECONDS) return null;
    return `${Math.round(secs)}s is a long clip — it'll take a while to encode and make a large file. Make sure that's what you want.`;
  });

  // Which encode path is actually running, reported by exportVideo() itself (feature-detected per
  // request, not guessed from the browser) — see ExportOpts.onPathSelected. Used to warn about the
  // MediaRecorder real-time path only when it's actually the one in use, not preemptively.
  let activePath = $state<'webcodecs' | 'mediarecorder' | 'gif' | null>(null);

  let busy = $state(false);
  let progress = $state(0);
  let msg = $state<string | null>(null);
  let controller: AbortController | null = null;

  let savedPath = $state<string | null>(null);
  async function downloadBlob(blob: Blob, filename: string) {
    savedPath = (await save(blob, filename)) || null;
  }

  async function run() {
    if (busy) return;
    // Synchronous veto before export-start or any renderer/encoder allocation.
    busy = true;
    progress = 0;
    msg = null;
    activePath = null;
    controller = new AbortController();
    // Pause the page's live shader while we export — it competes for the GPU (and is distracting) while
    // the offscreen renderer steps frames. ShaderCanvas listens for these and resumes on export-end.
    onStart?.();
    try {
      if (length > maxLength) length = maxLength;
      const requested = format;
      const lengthOpt =
        lengthUnit === 'frames' ? { frameCount: length } : { seconds: length };
      const inputs = useLive && hasKnobs ? liveInputs! : undefined;
      // drift/expressive animate the shader's own float knobs around their CURRENT value (live knobs
      // if in use, else the shader's declared defaults) — see lib/isf/auto-motion.ts for the curve math
      // and the feedback-param guard rail.
      let automate: NonNullable<Parameters<typeof exportVideo>[1]>['automate'];
      let usedRoll: string | null = null;
      if (motion !== 'static') {
        const baseValues: Record<string, number> = {};
        for (const input of parsedInputs) {
          if (input.TYPE !== 'float') continue;
          const live = inputs?.[input.NAME];
          baseValues[input.NAME] = typeof live === 'number' ? live : (defaultFor(input) as number);
        }
        // The roll token is the motion seed — paste it back (with 🔒 on) to reproduce this exact clip.
        usedRoll = roll;
        automate = buildAutoMotion(parsedInputs, baseValues, motion, usedRoll) ?? undefined;
      }
      const result = await exportVideo(
        isf,
        {
          format,
          ...lengthOpt,
          startFrame,
          fps,
          quality,
          inputs,
          width: size.w,
          height: size.h,
          signal: controller.signal,
          automate,
          onPathSelected: (p) => (activePath = p),
        },
        (p) => (progress = p),
      );
      await downloadBlob(result.blob, `${name}-${Date.now().toString(36)}.${result.ext}`);
      const kb = Math.round(result.blob.size / 1024);
      const codec = result.codec ? ` · ${result.codec}` : '';
      const rollInfo = usedRoll ? ` · roll ${usedRoll}` : '';
      msg =
        result.ext !== requested
          ? `saved ${result.ext.toUpperCase()} (${kb}kb${codec})${rollInfo} — ${requested.toUpperCase()} couldn't be produced in this browser.`
          : `saved ${result.ext.toUpperCase()} (${kb}kb${codec})${rollInfo} ✓`;
      // Advance to the next roll so a repeat export lands a different clip — unless the token is pinned.
      if (usedRoll && !rollLocked) reroll();
    } catch (e) {
      const err = e as Error;
      msg = err.name === 'AbortError' ? 'cancelled.' : 'export failed: ' + err.message;
    } finally {
      busy = false;
      controller = null;
      onEnd?.();
    }
  }

  function cancel() {
    controller?.abort();
  }
</script>

<details class="panel export" open>
  <summary><span class="kicker">export clip</span> · render a video {where}</summary>

  <p class="hint">
    Renders to video <b>{where}</b> (no upload), stepping the real renderer frame by frame so
    multipass + feedback come out right. <b>motion</b> auto-animates the shader's own knobs — each export
    rolls a fresh take (🎲 re-roll, 🔒 to pin one you like). GIF is slower with a tighter length cap;
    MP4/WebM are faster. Some devices record in real time (noted below if so) — keep the tab visible.
  </p>

  <div class="row">
    <label>
      format
      <select bind:value={format} disabled={busy}>
        <option value="mp4">MP4 (H.264 / compatible fallback)</option>
        <option value="webm">WebM (VP9)</option>
        <option value="gif">GIF</option>
      </select>
    </label>
    <label>
      length
      <span class="pair">
        <input
          type="number"
          inputmode={lengthUnit === 'frames' ? 'numeric' : 'decimal'}
          bind:value={length}
          min={lengthUnit === 'frames' ? 1 : 0.5}
          max={maxLength}
          step={lengthUnit === 'frames' ? 1 : 0.5}
          disabled={busy}
        />
        <select bind:value={lengthUnit} disabled={busy}>
          <option value="sec">sec</option>
          <option value="frames">frames</option>
        </select>
      </span>
      <small>max {maxLength}{lengthUnit === 'frames' ? ' frames' : ' sec at this fps'}</small>
    </label>
    <label>
      start frame
      <input
        type="number"
        inputmode="numeric"
        bind:value={startFrame}
        min="0"
        max={EXPORT_CAPS.maxStartFrame}
        step="1"
        disabled={busy}
      />
    </label>
    <label>
      motion
      <select bind:value={motion} disabled={busy || !hasFloatKnobs}>
        <option value="static">static</option>
        <option value="drift">drift</option>
        <option value="expressive">expressive</option>
      </select>
      {#if !hasFloatKnobs}<small>no animatable knobs</small>{/if}
    </label>
    {#if motion !== 'static'}
      <label class="roll">
        roll
        <span class="pair">
          <input
            type="text"
            bind:value={roll}
            spellcheck="false"
            autocomplete="off"
            disabled={busy}
            aria-label="motion roll token"
          />
          <button type="button" class="mini" onclick={copyRoll} disabled={busy} title="copy this roll token">
            {rollCopied ? '✓' : '⧉'}
          </button>
          <button type="button" class="mini" onclick={reroll} disabled={busy} title="re-roll — new random motion">🎲</button>
          <button
            type="button"
            class="mini"
            class:on={rollLocked}
            onclick={() => (rollLocked = !rollLocked)}
            disabled={busy}
            title={rollLocked ? 'locked — repeat exports reproduce this clip' : 'unlocked — each export rolls a new clip'}
          >{rollLocked ? '🔒' : '🔓'}</button>
        </span>
        <small>{rollLocked ? 'pinned — reproduces this clip' : 'each export rolls a new clip'}</small>
      </label>
    {/if}
    <label>
      fps
      <select bind:value={fps} disabled={busy}>
        <option value={24}>24</option>
        <option value={30}>30</option>
        <option value={60}>60</option>
      </select>
    </label>
    <label>
      size
      <select bind:value={size} disabled={busy}>
        {#each SIZES as s}
          <option value={s}>{s.label}</option>
        {/each}
      </select>
    </label>
    {#if format !== 'gif'}
      <label>
        quality
        <select bind:value={quality} disabled={busy}>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </label>
    {/if}
  </div>

  {#if hasKnobs}
    <label class="uselive">
      <input type="checkbox" bind:checked={useLive} disabled={busy} />
      use my current knob values (uncheck to export the shader's defaults)
    </label>
  {/if}

  {#if lengthWarning}<div class="notice" style="margin:4px 0 10px">⚠ {lengthWarning}</div>{/if}
  {#if busy && activePath === 'mediarecorder'}
    <div class="notice" style="margin:4px 0 10px">
      ⚠ recording in real time (this browser/request has no WebCodecs) — this will take about as long as
      the clip itself, and the tab needs to stay visible until it finishes.
    </div>
  {/if}

  <div class="bar">
    {#if busy}
      <button class="btn" onclick={cancel}>cancel</button>
      <div class="prog"><div class="fill" style={`width:${Math.round(progress * 100)}%`}></div></div>
      <span class="pct">{Math.round(progress * 100)}%</span>
    {:else}
      <button class="btn big" onclick={run}>⬇ export {format.toUpperCase()}</button>
      <span class="hint" style="margin:0"
        >caps: ≤1920 per side, ≤60fps, ≤{EXPORT_CAPS.maxFrames} frames (GIF ≤{EXPORT_CAPS.maxGifFrames})</span
      >
    {/if}
  </div>

  {#if msg}<div class="notice" style="margin-top:8px">{msg}
    {#if savedPath && reveal}<button class="btn" style="font-size:12px;padding:1px 8px;margin-left:8px" onclick={() => reveal!(savedPath!)}>show</button>{/if}
  </div>{/if}
</details>

<style>
  .export {
    margin-top: 12px;
  }
  .export summary {
    cursor: pointer;
    font-size: 13px;
  }
  .hint {
    font-size: 12px;
    opacity: 0.7;
    margin: 8px 0;
  }
  .row {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin: 8px 0;
  }
  .row label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    opacity: 0.8;
  }
  .row select,
  .row input {
    font-family: var(--mono);
    font-size: 13px;
    padding: 3px 6px;
    background: #fff;
    color: #000;
    border: 2px inset #999;
  }
  .row input {
    width: 72px;
  }
  .row .pair {
    display: flex;
    gap: 4px;
  }
  .row .pair input {
    width: 52px;
  }
  .row .roll .pair input {
    width: 72px;
    text-transform: none;
    letter-spacing: 0;
  }
  .row .mini {
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1;
    padding: 3px 5px;
    background: #fff;
    color: #000;
    border: 2px outset #999;
    cursor: pointer;
  }
  .row .mini:active {
    border-style: inset;
  }
  .row .mini.on {
    background: var(--magenta);
    color: #fff;
  }
  .row .mini:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .uselive {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    opacity: 0.85;
    margin: 4px 0 10px;
    cursor: pointer;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .prog {
    flex: 1;
    min-width: 120px;
    height: 14px;
    border: 2px inset #999;
    background: #000;
    overflow: hidden;
  }
  .prog .fill {
    height: 100%;
    background: var(--magenta);
    transition: width 0.1s linear;
  }
  .pct {
    font-family: var(--mono);
    font-size: 12px;
    min-width: 38px;
  }
</style>
