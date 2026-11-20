// Client-side video export. Encodes a looping shader to MP4 / WebM / GIF entirely in the visitor's
// browser — zero server GL, true to glslop's cost model. It runs the REAL GlslopRenderer (multipass +
// ping-pong feedback) on the shared stepped timeline (runtime.ts drawTimelineFrame) from frame 0:
// feedback state is history-dependent, so it's only correct when stepped forward — which is how a video
// encode runs anyway. captureTimeline() steps the same timeline and hands back frames instead of a file.
//
// One implementation, two entry points: the "download clip" control on the shader page and the
// glslop.exportVideo() apps-bridge method both call exportVideo(). Mediabunny (MP4/WebM) and gifenc (GIF)
// are dynamically imported so they only enter the bundle when someone actually exports.
import { GlslopRenderer, advanceTimeline, drawTimelineFrame } from './runtime.js';
import { repairAvcMetadataInPlace } from './avc-config.js';

export type VideoFormat = 'mp4' | 'webm' | 'gif';
export type ExportQuality = 'low' | 'medium' | 'high';

export interface ExportOpts {
  seconds?: number;
  fps?: number;
  width?: number;
  height?: number;
  format?: VideoFormat;
  inputs?: Record<string, number | boolean | number[]>;
  signal?: AbortSignal;
  // Start capturing at this source frame (default 0). For feedback shaders the renderer is stepped
  // (warmed up) from frame 0 to here without capturing, so the starting state is correct — you can't
  // just jump the clock forward. Useful to skip a boring intro or grab a later moment of an evolving piece.
  startFrame?: number;
  // Capture exactly this many frames. Overrides `seconds` when set (seconds is just frameCount/fps sugar).
  frameCount?: number;
  // MP4/WebM encode quality preset (default 'medium'). Maps to bits-per-pixel — higher = sharper, bigger.
  quality?: ExportQuality;
  // Explicit target bitrate (bits/sec) for MP4/WebM; overrides `quality` when set. Clamped to a sane range.
  bitrate?: number;
  // Per-frame knob override for animated ("drift"/"expressive") exports. Called once per OUTPUT frame
  // with (frameIndex relative to startFrame, u = progress 0..1); returned values are applied via
  // setInputValue before that frame renders, on top of `inputs`. See lib/isf/auto-motion.ts.
  automate?: (frameIndex: number, u: number) => Record<string, number | boolean | number[]>;
  // Which cap table to enforce (default EXPORT_CAPS). The apps bridge passes BRIDGE_CAPS so an
  // untrusted app can never ask for as much as the first-party export UI.
  caps?: ExportCaps;
  // Fired once, synchronously, right before the per-frame loop starts, with which encode path was
  // actually selected for THIS request. Feature detection happens per-request (a specific codec/size/
  // bitrate combo can fail canEncodeVideo even in a browser that generally has WebCodecs), so this is
  // ground truth rather than a browser-sniffed guess — use it to warn the visitor that a real-time
  // recording is about to tie up the tab, instead of predicting it beforehand.
  onPathSelected?: (path: 'webcodecs' | 'mediarecorder' | 'gif') => void;
}

export interface ExportResult {
  blob: Blob;
  mimeType: string;
  ext: string;
  codec?: 'H.264' | 'VP9' | 'VP8' | 'AV1';
}

// Hard caps — enforced here regardless of caller args. Heavy work stays bounded. maxHeight matches
// maxWidth so portrait (1080×1920 Reels/Stories) is allowed, not just landscape — pixel count, and
// thus encode cost, is unchanged from 1080p either way.
//
// Two tables, not one: this is all client-side cost (no server GL either way), but the apps bridge
// hands the cap to an UNTRUSTED app's arbitrary args, while the export UI is a first-party control a
// visitor drives themselves. BRIDGE_CAPS stays at the original conservative bound; EXPORT_CAPS (the
// UI) can go higher. maxGifFrames is separate from maxFrames because GIF is the one path that holds
// every frame in memory at once (gifenc palettizes the whole sequence) rather than streaming to an
// encoder — a long high-res GIF is a real memory/CPU cliff that video's caps don't protect against.
export interface ExportCaps {
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  maxFrames: number;
  maxSeconds: number;
  maxStartFrame: number;
  maxGifFrames: number;
}

// maxFrames/maxSeconds here are a hard technical ceiling (avoid actually crashing a tab — the
// WebCodecs path buffers the whole muxed output in memory via mediabunny's BufferTarget, and the
// MediaRecorder path ties up the tab for real wall-clock time), NOT the point at which we think a
// clip is "too long". Kyle (2026-07-22): let people ask for what they want, warn instead of blocking.
// The UI shows a soft, non-blocking warning above 60s — see VideoExport.svelte's lengthWarning — well
// under this ceiling, so in practice almost nobody hits the hard clamp; it's a backstop, not a target.
// maxFrames covers maxSeconds at maxFps (300 * 60) so the frame-count clamp never silently trims a
// seconds-based request before the seconds clamp would have.
export const EXPORT_CAPS: ExportCaps = {
  maxWidth: 1920,
  maxHeight: 1920,
  maxFps: 60,
  maxFrames: 18000,
  maxSeconds: 300,
  maxStartFrame: 3600,
  maxGifFrames: 300,
};

export const BRIDGE_CAPS: ExportCaps = {
  maxWidth: 1920,
  maxHeight: 1920,
  maxFps: 60,
  maxFrames: 300,
  maxSeconds: 10,
  maxStartFrame: 3600,
  maxGifFrames: 300,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type MbVideoCodec = 'avc' | 'vp9' | 'vp8' | 'av1';

// Prefer the conventional codec for each container, then try codecs browsers commonly expose. Firefox
// can have WebCodecs without an H.264 encoder; VP9-in-MP4 is valid but less portable than H.264.
const CODEC_CANDIDATES: Record<'mp4' | 'webm', readonly MbVideoCodec[]> = {
  mp4: ['avc', 'vp9', 'av1'],
  webm: ['vp9', 'vp8', 'av1'],
};
const CODEC_LABEL: Record<MbVideoCodec, ExportResult['codec']> = {
  avc: 'H.264',
  vp9: 'VP9',
  vp8: 'VP8',
  av1: 'AV1',
};

// Bits-per-pixel-per-frame by preset. 'medium' ≈ the old fixed 0.3; 'high' roughly doubles it for
// visibly sharper gradients/noise (shader output is detail-dense, so it rewards the extra bits).
const QUALITY_BPP: Record<ExportQuality, number> = { low: 0.12, medium: 0.3, high: 0.6 };

function bitrateFor(w: number, h: number, fps: number, quality: ExportQuality, override?: number): number {
  if (override != null && override > 0) return clamp(Math.round(override), 250_000, 40_000_000);
  return clamp(Math.round(w * h * fps * QUALITY_BPP[quality]), 1_000_000, 24_000_000);
}

async function supportedWebCodec(
  format: 'mp4' | 'webm',
  w: number,
  h: number,
  bitrate: number,
): Promise<MbVideoCodec | null> {
  // Fast-path out before importing mediabunny on browsers with no WebCodecs at all (mediabunny encodes
  // via WebCodecs under the hood). Pure-GIF exports never call this, so mediabunny stays out of their chunk.
  if (typeof VideoEncoder === 'undefined') return null;
  try {
    const { canEncodeVideo } = await import('mediabunny');
    for (const codec of CODEC_CANDIDATES[format]) {
      if (await canEncodeVideo(codec, { width: w, height: h, bitrate })) return codec;
    }
  } catch {
    // The MediaRecorder compatibility path below may still work.
  }
  return null;
}

interface RecorderPlan {
  mimeType: string;
  recordedContainer: 'mp4' | 'webm';
  codec: ExportResult['codec'];
}

function supportedRecorderPlan(requested: 'mp4' | 'webm'): RecorderPlan | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    return null;
  }
  const candidates: RecorderPlan[] = requested === 'mp4'
    ? [
        { mimeType: 'video/mp4;codecs=avc1.42E01E', recordedContainer: 'mp4', codec: 'H.264' },
        { mimeType: 'video/mp4', recordedContainer: 'mp4', codec: 'H.264' },
        // Firefox MediaRecorder writes WebM. Mediabunny can losslessly remux its VP9/VP8 track to MP4.
        { mimeType: 'video/webm;codecs=vp9', recordedContainer: 'webm', codec: 'VP9' },
        { mimeType: 'video/webm;codecs=vp8', recordedContainer: 'webm', codec: 'VP8' },
        { mimeType: 'video/webm', recordedContainer: 'webm', codec: 'VP8' },
      ]
    : [
        { mimeType: 'video/webm;codecs=vp9', recordedContainer: 'webm', codec: 'VP9' },
        { mimeType: 'video/webm;codecs=vp8', recordedContainer: 'webm', codec: 'VP8' },
        { mimeType: 'video/webm', recordedContainer: 'webm', codec: 'VP8' },
      ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate.mimeType)) ?? null;
}

// Yield to the event loop between frames so the tab stays responsive + progress paints; also lets the
// encoder drain its internal queue (backpressure) instead of ballooning memory on weak GPUs.
const nextTick = () =>
  new Promise<void>((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('export cancelled', 'AbortError');
}

/**
 * Encode a shader to a video Blob. onProgress is called with 0..1 as frames render + a final ~1 on mux.
 * Prefers WebCodecs, then uses MediaRecorder plus a local remux on browsers such as Firefox. GIF is
 * the last resort when neither browser video encoder is available.
 */
export async function exportVideo(
  isf: string,
  opts: ExportOpts = {},
  onProgress?: (p: number) => void,
): Promise<ExportResult> {
  const caps = opts.caps ?? EXPORT_CAPS;
  const format = (opts.format ?? 'mp4') as VideoFormat;
  const fps = clamp(Math.round(opts.fps ?? 30), 1, caps.maxFps);
  const seconds = clamp(opts.seconds ?? 4, 0.1, caps.maxSeconds);
  const width = clamp(Math.round(opts.width ?? 512), 16, caps.maxWidth);
  const height = clamp(Math.round(opts.height ?? 512), 16, caps.maxHeight);
  // Length by explicit frame count if given, else derived from seconds. Clamped to maxFrames, then
  // additionally to maxGifFrames for GIF — gifenc holds every frame in memory, so GIF keeps a much
  // tighter bound than streamed video regardless of what the video caps allow.
  const frameCap = format === 'gif' ? Math.min(caps.maxFrames, caps.maxGifFrames) : caps.maxFrames;
  const totalFrames = clamp(Math.round(opts.frameCount != null ? opts.frameCount : seconds * fps), 1, frameCap);
  const startFrame = clamp(Math.round(opts.startFrame ?? 0), 0, caps.maxStartFrame);
  const bitrate = bitrateFor(width, height, fps, opts.quality ?? 'medium', opts.bitrate);
  const webCodec = format === 'gif' ? null : await supportedWebCodec(format, width, height, bitrate);
  const recorderPlan = format === 'gif' || webCodec ? null : supportedRecorderPlan(format);

  // Fresh offscreen renderer (not the page's live one) so time-stepping + resize never fight the live
  // display loop; the caller passes current INPUT values via opts.inputs so the export matches the knobs.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new GlslopRenderer(canvas);
  const compiled = await renderer.load(isf);
  if (!compiled.compileOk) {
    renderer.dispose();
    throw new Error('shader does not compile: ' + (compiled.errors[0] ?? 'unknown error'));
  }
  if (opts.inputs) for (const [k, v] of Object.entries(opts.inputs)) renderer.setInputValue(k, v);
  renderer.resize(width, height);
  await renderer.imagesReady(); // load any poster textures before capturing (not the 1×1 fallback)

  // Warm up to startFrame WITHOUT capturing: feedback is history-dependent, so a correct "start at
  // frame N" means actually stepping frames 0..N-1 first (you can't seek the clock on a feedback loop).
  // No-op for startFrame=0. Yields to paint (rAF) so a long warm-up doesn't freeze the tab.
  await advanceTimeline(renderer, 0, startFrame, fps, { signal: opts.signal, yieldNow: nextTick });

  try {
    const ctx = { fps, width, height, totalFrames, startFrame, signal: opts.signal, automate: opts.automate };
    if (format === 'gif' || (!webCodec && !recorderPlan)) {
      opts.onPathSelected?.('gif');
      return await encodeGif(renderer, canvas, ctx, onProgress);
    }
    if (webCodec) {
      opts.onPathSelected?.('webcodecs');
      return await encodeWebCodecs(renderer, canvas, { ...ctx, format, codec: webCodec, bitrate }, onProgress);
    }
    opts.onPathSelected?.('mediarecorder');
    return await encodeMediaRecorder(renderer, canvas, { ...ctx, format, bitrate, plan: recorderPlan! }, onProgress);
  } finally {
    renderer.dispose();
  }
}

interface EncCtx {
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
  startFrame: number;
  signal?: AbortSignal;
  automate?: ExportOpts['automate'];
}

// Applied once per OUTPUT frame (i is 0-based, independent of startFrame) right before renderer.draw.
// u=0 at the first captured frame, u=1 at the last — a full sweep/LFO cycle spans exactly the clip.
function applyAutomation(renderer: GlslopRenderer, automate: ExportOpts['automate'], i: number, totalFrames: number): void {
  if (!automate) return;
  const u = totalFrames > 1 ? i / (totalFrames - 1) : 0;
  const values = automate(i, u);
  for (const [name, value] of Object.entries(values)) renderer.setInputValue(name, value);
}

async function encodeWebCodecs(
  renderer: GlslopRenderer,
  canvas: HTMLCanvasElement,
  ctx: EncCtx & { format: 'mp4' | 'webm'; codec: MbVideoCodec; bitrate: number },
  onProgress?: (p: number) => void,
): Promise<ExportResult> {
  const { format, codec, fps, totalFrames, startFrame, bitrate, signal, automate } = ctx;
  const { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource } = await import('mediabunny');

  const output = new Output({
    // fastStart:'in-memory' rewrites the moov box to the front so the MP4 is streamable/seekable.
    format: format === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  // CanvasSource owns the WebCodecs encode + backpressure internally: source.add() snapshots the canvas,
  // encodes, and resolves only once the encoder/writer are ready for more — so the old manual VideoEncoder
  // + encodeQueueSize drain loop is gone. keyFrameInterval defaults to 2s (matches the old ~2s cadence).
  // Firefox emits a spec-violating AVCDecoderConfigurationRecord, and Mediabunny muxes the
  // description verbatim — unrepaired, the MP4 won't play on iPhone. This hook fires with the very
  // object the muxer is handed next, so fixing it here is what reaches the avcC box. No-op elsewhere.
  const source = new CanvasSource(canvas, {
    codec,
    bitrate,
    ...(codec === 'avc' ? { onEncodedPacket: (_p: unknown, meta: unknown) => repairAvcMetadataInPlace(meta as never) } : {}),
  });
  output.addVideoTrack(source, { frameRate: fps });
  try {
    await output.start();
    for (let i = 0; i < totalFrames; i++) {
      throwIfAborted(signal);
      // deterministic step: source frame = startFrame + i (feedback continues from warm-up), but the
      // output timeline stays 0-based. The shared timeline (runtime.ts drawTimelineFrame) sets
      // TIMEDELTA=1/fps and FRAMEINDEX=src so motion matches wall-clock and feedback advances once per frame.
      const src = startFrame + i;
      applyAutomation(renderer, automate, i, totalFrames);
      drawTimelineFrame(renderer, src, fps);
      await source.add(i / fps, 1 / fps); // awaits encoder/writer backpressure — no separate drain loop needed
      onProgress?.(i / totalFrames);
    }
    await output.finalize();
  } catch (error) {
    // Releases Mediabunny's encoder and target writer after cancellation or an encode failure.
    await output.cancel().catch(() => {});
    throw error;
  }
  onProgress?.(1);
  const buffer = (output.target as InstanceType<typeof BufferTarget>).buffer!;
  return format === 'mp4'
    ? { blob: new Blob([buffer], { type: 'video/mp4' }), mimeType: 'video/mp4', ext: 'mp4', codec: CODEC_LABEL[codec] }
    : { blob: new Blob([buffer], { type: 'video/webm' }), mimeType: 'video/webm', ext: 'webm', codec: CODEC_LABEL[codec] };
}

async function remuxWebmToMp4(blob: Blob, signal?: AbortSignal): Promise<Blob> {
  const { Input, Output, Conversion, ALL_FORMATS, BlobSource, Mp4OutputFormat, BufferTarget } = await import('mediabunny');
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const conversion = await Conversion.init({ input, output, tracks: 'primary', showWarnings: false });
  if (!conversion.isValid) throw new Error('browser recording cannot be remuxed to MP4');
  const abort = () => void conversion.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    throwIfAborted(signal);
    await conversion.execute();
    const buffer = (output.target as InstanceType<typeof BufferTarget>).buffer!;
    return new Blob([buffer], { type: 'video/mp4' });
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function encodeMediaRecorder(
  renderer: GlslopRenderer,
  canvas: HTMLCanvasElement,
  ctx: EncCtx & { format: 'mp4' | 'webm'; bitrate: number; plan: RecorderPlan },
  onProgress?: (p: number) => void,
): Promise<ExportResult> {
  const { format, fps, totalFrames, startFrame, bitrate, signal, plan, automate } = ctx;
  const stream = canvas.captureStream(fps);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (!track) throw new Error('canvas recording is not supported by this browser');

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: plan.mimeType, videoBitsPerSecond: bitrate });
  // `started` used to resolve on 'start' only, with no reject path — if the recorder ever emits 'error'
  // instead of 'start' (observed: happens when the browser's codec backend is in an unusual state),
  // this hung forever on `await started` with no error and no way to cancel (throwIfAborted only runs
  // INSIDE the frame loop, which this line is before). Now rejects on 'error' too, and a timeout is a
  // last-resort backstop in case neither event ever fires.
  const started = new Promise<void>((resolve, reject) => {
    recorder.addEventListener('start', () => resolve(), { once: true });
    recorder.addEventListener('error', (e) => reject(new Error((e as ErrorEvent).message || 'browser video recorder failed to start')), {
      once: true,
    });
    setTimeout(() => reject(new Error('browser video recorder never started (no start/error event within 8s)')), 8000);
  });
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onerror = (event) => reject(new Error((event as ErrorEvent).message || 'browser video recorder failed'));
    recorder.onstop = () => resolve();
  });

  try {
    recorder.start();
    throwIfAborted(signal);
    await started;
    const frameMs = 1000 / fps;
    let nextFrameAt = performance.now();
    for (let i = 0; i < totalFrames; i++) {
      throwIfAborted(signal);
      const src = startFrame + i;
      applyAutomation(renderer, automate, i, totalFrames);
      drawTimelineFrame(renderer, src, fps);
      track.requestFrame?.();
      onProgress?.(i / totalFrames);
      nextFrameAt += frameMs;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextFrameAt - performance.now())));
    }
    // MediaRecorder derives duration from packet timestamps and Firefox gives the final packet no
    // duration. Requesting the held final canvas once at the end supplies the clip end marker.
    track.requestFrame?.();
    await new Promise((resolve) => setTimeout(resolve, frameMs));
    throwIfAborted(signal);
    recorder.stop();
    await stopped;
  } catch (error) {
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Cleanup only — the original `error` below is what actually gets reported.
      }
    }
    await stopped.catch(() => {});
    throw error;
  } finally {
    stream.getTracks().forEach((item) => item.stop());
  }

  const recorded = new Blob(chunks, { type: plan.mimeType });
  if (!recorded.size) throw new Error('browser video recorder returned an empty file');
  onProgress?.(0.98);

  if (format === 'mp4' && plan.recordedContainer === 'webm') {
    try {
      const blob = await remuxWebmToMp4(recorded, signal);
      onProgress?.(1);
      return { blob, mimeType: 'video/mp4', ext: 'mp4', codec: plan.codec };
    } catch (error) {
      if (signal?.aborted) throw error;
      // A usable WebM is much better than discarding a completed recording or falling back to GIF.
      onProgress?.(1);
      return { blob: recorded, mimeType: 'video/webm', ext: 'webm', codec: plan.codec };
    }
  }

  onProgress?.(1);
  return format === 'mp4'
    ? { blob: recorded, mimeType: 'video/mp4', ext: 'mp4', codec: plan.codec }
    : { blob: recorded, mimeType: 'video/webm', ext: 'webm', codec: plan.codec };
}

async function encodeGif(
  renderer: GlslopRenderer,
  canvas: HTMLCanvasElement,
  ctx: EncCtx,
  onProgress?: (p: number) => void,
): Promise<ExportResult> {
  const { fps, width, height, totalFrames, startFrame, signal, automate } = ctx;
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const gif = GIFEncoder();
  // GIF needs RGBA pixels; draw the WebGL canvas onto a 2D scratch canvas and read it back.
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const c2d = scratch.getContext('2d', { willReadFrequently: true })!;
  const delay = Math.round(1000 / fps);
  for (let i = 0; i < totalFrames; i++) {
    throwIfAborted(signal);
    const src = startFrame + i;
    applyAutomation(renderer, automate, i, totalFrames);
    drawTimelineFrame(renderer, src, fps);
    c2d.drawImage(canvas, 0, 0, width, height);
    const { data } = c2d.getImageData(0, 0, width, height);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, width, height, { palette, delay });
    onProgress?.(i / totalFrames);
    await nextTick();
  }
  gif.finish();
  onProgress?.(1);
  const bytes = gif.bytes();
  return { blob: new Blob([bytes], { type: 'image/gif' }), mimeType: 'image/gif', ext: 'gif' };
}
