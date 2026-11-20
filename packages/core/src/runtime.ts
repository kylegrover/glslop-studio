import { parseISF } from './parse.js';
import { waitForCompile } from './compile-wait.js';
import type { ISFInput, ISFPass } from './types.js';

// ---------------------------------------------------------------------------
// glslop WebGL2 ISF runtime. Classic ISF (GLSL ES 1.00 body with gl_FragColor)
// compiled in a WebGL2 context. INPUTS become uniforms + sliders. PASSES become
// offscreen render targets (multipass), and PERSISTENT targets ping-pong across
// frames (feedback). This same engine powers the live site AND the headless agent
// render path. Matching source/settings/history use the same algorithm; this is not a promise
// of byte identity across different hardware, drivers, texture availability or DATE values.
// ---------------------------------------------------------------------------

// ISF host functions for sampling images/buffers. We render every buffer at RENDERSIZE,
// so IMG_SIZE is RENDERSIZE and IMG_PIXEL maps pixel->normalized by RENDERSIZE.
const IMG_MACROS = `#define IMG_THIS_PIXEL(img) texture2D(img, isf_FragNormCoord)
#define IMG_THIS_NORM_PIXEL(img) texture2D(img, isf_FragNormCoord)
#define IMG_NORM_PIXEL(img, nc) texture2D(img, (nc))
#define IMG_PIXEL(img, pc) texture2D(img, (pc) / RENDERSIZE)
#define IMG_SIZE(img) RENDERSIZE`;

// PERSISTENT / FLOAT can arrive as bool, number, or "true"/"YES" strings.
function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return /^(1|true|yes)$/i.test(v.trim());
  return false;
}

// Unique TARGET buffer names, in first-seen order.
function bufferNamesOf(passes: ISFPass[]): string[] {
  const seen: string[] = [];
  for (const p of passes) {
    if (p.TARGET && !seen.includes(p.TARGET)) seen.push(p.TARGET);
  }
  return seen;
}

interface BufferTex {
  a: WebGLTexture;
  b: WebGLTexture;
  read: 'a' | 'b'; // which texture holds the latest content
  float: boolean;
}

// One image INPUT: another shader's poster, sampled as a static texture. `tex` is null until
// the poster image has loaded; draw() binds a 1x1 fallback in the meantime.
interface ImageInput {
  name: string;
  source: string; // source shader id
  tex: WebGLTexture | null;
}

// Where a source shader's still lives. The original 512x512 PNG is always kept (never
// overwritten by the AVIF/WebP re-encode), so it's the canonical, lossless texture source.
//
// Host settings. Set them once per JS realm (main thread, each worker) before loading shaders.
//  posterBase      origin the poster PNGs come from. '' (default) = root-relative, which is right on
//                  glslop.com itself; anything not served from glslop.com sets 'https://glslop.com'.
//  textureUrl      overrides where a source shader's still is fetched (e.g. a local cache).
//  blockingCompile skips KHR_parallel_shader_compile, so load() blocks in the link-status query for
//                  exactly as long as the driver works (cost probes; timers throttle in hidden windows).
//  captureTranslated keeps the driver's translated source (WEBGL_debug_shaders) in lastCompile. Off by
//                  default: for heavy shaders it is a large string copy on every compile.
export const runtimeConfig: {
  posterBase: string; textureUrl?: (shaderId: string) => string; blockingCompile?: boolean; captureTranslated?: boolean;
} = { posterBase: '' };
export function posterTextureUrl(shaderId: string): string {
  return runtimeConfig.textureUrl?.(shaderId) ?? `${runtimeConfig.posterBase}/posters/${encodeURIComponent(shaderId)}.png`;
}

// What the last load() actually handed the driver, for inspection tools.
export interface CompileRecord {
  fragmentSource: string;
  vertexSource: string;
  infoLog: string;
  /** WEBGL_debug_shaders output (HLSL / SPIR-V-ish GLSL / MSL, by backend) when runtimeConfig.captureTranslated
   *  is on and the browser exposes it; otherwise null. */
  translatedSource: string | null;
  /** ms from compileShader to COMPLETION_STATUS/first status query returning. */
  compileMs: number;
  parallelCompile: boolean;
}

export interface CompileResult {
  compileOk: boolean;
  errors: string[];
  inputs: ISFInput[];
  // True when a NEWER load() started before this one finished, so this result was thrown away
  // without touching renderer state. Callers must bail on it rather than treat it as a failure —
  // it is not a compile error and there is nothing to report. See GlslopRenderer.load().
  superseded?: boolean;
  // Why this load gave up, for callers that have to schedule around the driver rather than just
  // report to a user. `timedOut` is the watchdog: WE stopped waiting, the DRIVER did not stop
  // compiling, and issuing the next compile now stacks it on one that is still running. `lost` is a
  // dead context, which took the compile with it. Both are already described in `errors`; these are
  // the same facts in a form a scheduler can read. See src/lib/isf/compile-queue.ts.
  timedOut?: boolean;
  lost?: boolean;
}

export interface RenderOpts {
  width?: number;
  height?: number;
  time?: number;
  inputs?: Record<string, number | boolean | number[]>;
  benchmark?: boolean;
  // A stepped timeline instead of one still — see captureTimeline(). `time` and `benchmark` are
  // ignored when this is present.
  capture?: CaptureOpts;
}

// One capture on the shared stepped timeline (TIME=i/fps, TIMEDELTA=1/fps, FRAMEINDEX=i, feedback
// advancing once per frame). `frames` are absolute frame indices and come back in ascending order.
export interface CaptureOpts {
  fps?: number;
  frames: number[];
}

// Per-frame overrides for a deterministic driver (the video exporter, captureTimeline). Absent =
// live-loop defaults (TIMEDELTA=1/60, FRAMEINDEX=floor(TIME*60), DATE from the wall clock).
export interface FrameMeta {
  timeDelta?: number;
  frameIndex?: number;
  // [year, month, day, seconds since midnight]. Captures pin this so a DATE-driven shader reproduces.
  date?: readonly [number, number, number, number];
}

const VERT = `attribute vec2 a_pos;
varying vec2 isf_FragNormCoord;
void main(){
  isf_FragNormCoord = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const RESERVED = new Set([
  'TIME',
  'TIMEDELTA',
  'FRAMEINDEX',
  'PASSINDEX',
  'DATE',
  'RENDERSIZE',
]);

// KHR_parallel_shader_compile — not in lib.dom's WebGL extension map, so declare the one member.
interface KHRParallelShaderCompile {
  COMPLETION_STATUS_KHR: number;
}

// One beat between completion polls. rAF keeps the polling in step with the frame loop (so it never
// competes with rendering), but rAF is throttled to a standstill in a hidden tab — and headless
// poster/export runs may have no rAF at all — so fall back to a timer whenever it isn't usable.
function nextPollTick(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && !document.hidden) {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 8);
    }
  });
}

function uniformDecl(input: ISFInput): string {
  switch (input.TYPE) {
    case 'float':
      return `uniform float ${input.NAME};`;
    case 'bool':
    case 'event':
      return `uniform bool ${input.NAME};`;
    case 'long':
      return `uniform int ${input.NAME};`;
    case 'color':
      return `uniform vec4 ${input.NAME};`;
    case 'point2D':
      return `uniform vec2 ${input.NAME};`;
    case 'image':
      return `uniform sampler2D ${input.NAME};`; // sampled via the IMG_* macros
    default:
      return '';
  }
}

export function defaultFor(input: ISFInput): number | boolean | number[] {
  switch (input.TYPE) {
    case 'float':
      return typeof input.DEFAULT === 'number' ? input.DEFAULT : (input.MIN ?? 0);
    case 'bool':
    case 'event':
      return input.DEFAULT === true;
    case 'long':
      return typeof input.DEFAULT === 'number' ? input.DEFAULT : (input.VALUES?.[0] ?? 0);
    case 'color':
      return Array.isArray(input.DEFAULT) ? input.DEFAULT : [1, 1, 1, 1];
    case 'point2D':
      return Array.isArray(input.DEFAULT) ? input.DEFAULT : [0.5, 0.5];
    default:
      return 0;
  }
}

function buildFragment(body: string, inputs: ISFInput[], bufferNames: string[]): string {
  const decls = inputs
    .filter((i) => !RESERVED.has(i.NAME))
    .map(uniformDecl)
    .filter(Boolean)
    .join('\n');
  const samplers = bufferNames.map((n) => `uniform sampler2D ${n};`).join('\n');
  return `precision highp float;
precision highp int;
varying vec2 isf_FragNormCoord;
uniform vec2 RENDERSIZE;
uniform float TIME;
uniform float TIMEDELTA;
uniform int FRAMEINDEX;
uniform int PASSINDEX;
uniform vec4 DATE;
${samplers}
${decls}
${IMG_MACROS}
${body}`;
}

export class GlslopRenderer {
  readonly backend = 'webgl2' as const;
  // OffscreenCanvas so the whole renderer can run inside a Worker (grid preview path). The WebGL2
  // context API is identical either way; only image loading and toDataURL differ (handled below).
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private gl: WebGL2RenderingContext;
  private ownsContext: boolean;
  private quad: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private program: WebGLProgram | null = null;
  // Bumped by every load(); a load whose seq is stale when it finishes discards its program instead
  // of installing it, so rapid re-loads (the submit form recompiling per keystroke) can't race.
  private loadSeq = 0;
  lastCompile: CompileRecord | null = null;
  private parallelExt: KHRParallelShaderCompile | null;
  private inputs: ISFInput[] = [];
  private values = new Map<string, number | boolean | number[]>();
  private locs = new Map<string, WebGLUniformLocation | null>();
  private startTime = performance.now();

  // multipass / feedback state
  private passes: ISFPass[] = [];
  private bufferNames: string[] = [];
  private buffers = new Map<string, BufferTex>();
  private fbo: WebGLFramebuffer | null = null;
  private bufW = 0;
  private bufH = 0;
  private canFloat = false;

  // image INPUTS (poster-as-texture)
  private imageInputs: ImageInput[] = [];
  private fallbackTex: WebGLTexture | null = null;
  private imageLoads: Promise<void>[] = [];
  // host hook: called when an image input finishes loading, so a paused viewer can redraw
  onAssetLoad: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, sharedContext?: WebGL2RenderingContext) {
    this.canvas = canvas;
    if (sharedContext && sharedContext.canvas !== canvas) throw new Error('Shared renderer context must belong to this canvas');
    this.ownsContext = !sharedContext;
    // The union's getContext overloads don't collapse to one signature, so narrow the result here.
    const gl = sharedContext ?? (canvas as HTMLCanvasElement).getContext('webgl2', {
      preserveDrawingBuffer: true,
      antialias: true,
      premultipliedAlpha: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    // Enable before submitting compiler work, not after linkProgram.
    this.parallelExt = runtimeConfig.blockingCompile ? null : gl.getExtension('KHR_parallel_shader_compile') as KHRParallelShaderCompile | null;
    // float render targets (reaction-diffusion etc.) need this; degrade to RGBA8 if absent
    this.canFloat = !!gl.getExtension('EXT_color_buffer_float');
    // RGBA16F linear sampling is core WebGL2. OES_texture_half_float_linear is a WebGL1
    // extension, usually absent here; checking it incorrectly forced every float buffer to NEAREST.
    // fullscreen quad (TRIANGLE_STRIP, 4 verts)
    this.vao = gl.createVertexArray()!;
    this.quad = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    // 1x1 opaque-black placeholder for image inputs that haven't loaded yet
    this.fallbackTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fallbackTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  // Independent program/inputs/feedback over the SAME GL context. The owner outlives its siblings;
  // disposing a cached sibling releases only its resources, never the shared context.
  createSibling(): GlslopRenderer { return new GlslopRenderer(this.canvas, this.gl); }

  // Kick off async load of each image INPUT's source poster. The sampler binds to the 1x1
  // fallback until the image arrives; when it does we upload it and ping the host to redraw.
  private setupImageInputs(): void {
    const gl = this.gl;
    for (const inp of this.imageInputs) if (inp.tex) gl.deleteTexture(inp.tex);
    this.imageInputs = this.inputs
      .filter((i) => i.TYPE === 'image' && typeof i.SOURCE === 'string' && i.SOURCE)
      .map((i) => ({ name: i.NAME, source: i.SOURCE as string, tex: null }));
    this.imageLoads = this.imageInputs.map((ii) => this.loadImageInput(ii));
  }

  // Upload a decoded poster into a clamped LINEAR texture. `flipY` uses UNPACK_FLIP_Y_WEBGL for
  // HTMLImageElement sources (matching ISF y-up coords); ImageBitmap sources bake the flip in at
  // createImageBitmap time and pass flipY=false, because the pixel-store flag is a documented no-op
  // for ImageBitmap uploads.
  private uploadPosterTexture(source: TexImageSource, flipY: boolean): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private loadImageInput(ii: ImageInput): Promise<void> {
    // In a Worker there is no HTMLImageElement, so route to the fetch + createImageBitmap path. The
    // DOM path (main thread + headless poster/export) is kept byte-identical so render hashes don't move.
    if (typeof Image === 'undefined') return this.loadImageInputBitmap(ii);
    return new Promise<void>((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // /posters sends ACAO; avoids tainting toDataURL
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      // don't let a missing/slow poster hang a headless render
      const timer = setTimeout(done, 8000);
      img.onload = () => {
        clearTimeout(timer);
        if (this.imageInputs.includes(ii)) {
          ii.tex = this.uploadPosterTexture(img, true);
          this.onAssetLoad?.();
        }
        done();
      };
      img.onerror = () => {
        clearTimeout(timer);
        done();
      };
      img.src = posterTextureUrl(ii.source);
    });
  }

  // Worker-thread poster loader: fetch the PNG and decode via createImageBitmap, with the y-flip
  // baked in to match the DOM path's UNPACK_FLIP_Y_WEBGL. Missing/slow/errored posters resolve to
  // the black fallback exactly like the DOM path, and never hang the caller (8s timeout).
  private loadImageInputBitmap(ii: ImageInput): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const timer = setTimeout(done, 8000);
      (async () => {
        try {
          const resp = await fetch(posterTextureUrl(ii.source), { mode: 'cors' });
          if (!resp.ok) throw new Error('poster ' + resp.status);
          const bmp = await createImageBitmap(await resp.blob(), {
            imageOrientation: 'flipY',
            premultiplyAlpha: 'none',
          });
          if (!settled && this.imageInputs.includes(ii)) {
            ii.tex = this.uploadPosterTexture(bmp, false);
            this.onAssetLoad?.();
          }
          bmp.close();
        } catch {
          /* fall through to the black fallback, same as an errored <img> */
        } finally {
          clearTimeout(timer);
          done();
        }
      })();
    });
  }

  // Resolves once every image input has loaded (or errored/timed out). Headless renders
  // await this so the poster captures the texture, not the black fallback.
  imagesReady(): Promise<void> {
    return Promise.all(this.imageLoads).then(() => undefined);
  }

  // Resolves once the driver has finished building `program` — WITHOUT blocking the main thread.
  //
  // gl.compileShader/linkProgram are already asynchronous inside the driver; what actually stalls
  // the page is the first SYNCHRONOUS query (COMPILE_STATUS / LINK_STATUS / getUniformLocation),
  // which parks the main thread until the whole ANGLE -> HLSL -> FXC -> driver chain finishes. On
  // Windows/NVIDIA that is measured in SECONDS for heavy shaders (the worst in the live corpus is
  // ~16s on an RTX 3090), so the query has to wait for a non-blocking completion signal first.
  //
  // KHR_parallel_shader_compile's COMPLETION_STATUS_KHR is the one program query specified NOT to
  // block. Poll it off the main thread's critical path, and only once it reads true do we run the
  // ordinary (now free) status/infolog queries. Without the extension there is nothing to poll and
  // we fall through to the old blocking behaviour — same result, just with the freeze.
  private async awaitProgramReady(program: WebGLProgram, seq: number): Promise<'ready' | 'cancelled' | 'timeout'> {
    const gl = this.gl;
    const ext = this.parallelExt;
    // Without KHR there is no non-blocking readiness query. Interactive detail rendering runs in
    // a Worker for this reason; the headless/export paths still deliberately wait for the driver.
    if (!ext) return 'ready';
    return waitForCompile({
      ready: () => !!gl.getProgramParameter(program, ext.COMPLETION_STATUS_KHR),
      cancelled: () => seq !== this.loadSeq || gl.isContextLost(),
      tick: nextPollTick,
    });
  }

  // Async because the compile it waits on can take seconds — see awaitProgramReady. Callers must
  // bail when the result comes back `superseded` (a newer load started meanwhile).
  async load(isfSource: string): Promise<CompileResult> {
    const gl = this.gl;
    const seq = ++this.loadSeq;
    const parsed = parseISF(isfSource);
    if (!parsed.ok) return { compileOk: false, errors: [parsed.error], inputs: [] };

    for (const pass of parsed.isf.passes) {
      if (pass.FILTER !== undefined && !['LINEAR', 'NEAREST'].includes(pass.FILTER)) {
        return { compileOk: false, errors: ['PASSES FILTER must be LINEAR or NEAREST (glslop extension)'], inputs: parsed.isf.inputs };
      }
      if (pass.TARGET && parsed.isf.passes.some(p => p.TARGET === pass.TARGET && p.FILTER && pass.FILTER && p.FILTER !== pass.FILTER)) {
        return { compileOk: false, errors: [`Conflicting FILTER for target ${pass.TARGET}`], inputs: parsed.isf.inputs };
      }
    }
    this.inputs = parsed.isf.inputs;
    this.passes = parsed.isf.passes;
    this.bufferNames = bufferNamesOf(this.passes);
    this.disposeBuffers(); // new ISF -> rebuild targets lazily on next draw
    this.setupImageInputs(); // new ISF -> (re)load any poster textures
    const fragSrc = buildFragment(parsed.isf.body, this.inputs, this.bufferNames);

    // Kick off BOTH stages and the link before asking anything about any of them: every query is a
    // potential stall point, so they all belong after awaitProgramReady, not interleaved here.
    const compileT0 = performance.now();
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, VERT);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fragSrc);
    gl.compileShader(fs);

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.linkProgram(program);

    const completion = await this.awaitProgramReady(program, seq);

    const fail = (errors: string[]): CompileResult => {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(program);
      return { compileOk: false, errors, inputs: this.inputs };
    };
    if (seq !== this.loadSeq) {
      fail([]); // a newer load() won; drop this program without touching renderer state
      return { compileOk: false, errors: [], inputs: this.inputs, superseded: true };
    }
    if (completion !== 'ready') {
      const timedOut = completion === 'timeout';
      return {
        ...fail([timedOut
          ? 'Shader compilation exceeded three minutes. Live rendering stopped; try a simpler shader.'
          : 'WebGL context lost while compiling. Restart the viewer to try again.']),
        timedOut, lost: !timedOut,
      };
    }
    // Only a READY program may reach the synchronous status/infolog queries.
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      return fail(['vertex: ' + (gl.getShaderInfoLog(vs) || 'unknown compile error')]);
    }
    const fsOk = !!gl.getShaderParameter(fs, gl.COMPILE_STATUS);
    const dbg = runtimeConfig.captureTranslated ? gl.getExtension('WEBGL_debug_shaders') : null;
    this.lastCompile = {
      fragmentSource: fragSrc, vertexSource: VERT, infoLog: gl.getShaderInfoLog(fs) || '',
      translatedSource: dbg && fsOk ? dbg.getTranslatedShaderSource(fs) : null,
      compileMs: performance.now() - compileT0, parallelCompile: !!this.parallelExt,
    };
    if (!fsOk) {
      // Driver line numbers count the generated prelude; shift them to lines in the user's .fs file.
      const preludeLines = fragSrc.split('\n').length - parsed.isf.body.split('\n').length;
      const headerLines = isfSource.slice(0, isfSource.length - parsed.isf.body.length).split('\n').length - 1;
      return fail([cleanLog(gl.getShaderInfoLog(fs) || 'unknown compile error', headerLines - preludeLines)]);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || 'link failed';
      gl.deleteProgram(program);
      return { compileOk: false, errors: ['link: ' + log], inputs: this.inputs };
    }

    if (this.program) gl.deleteProgram(this.program);
    this.program = program;
    this.locs.clear();

    // init defaults (preserve any already-set values)
    for (const input of this.inputs) {
      if (!this.values.has(input.NAME)) this.values.set(input.NAME, defaultFor(input));
    }

    return { compileOk: true, errors: [], inputs: this.inputs };
  }

  // Lets pooled callers notice a dead context and rebuild.
  isContextLost(): boolean { return this.gl.isContextLost(); }

  getInputs(): ISFInput[] {
    return this.inputs;
  }

  setInputValue(name: string, value: number | boolean | number[]): void {
    this.values.set(name, value);
  }

  resize(w: number, h: number): void {
    this.canvas.width = Math.max(1, Math.floor(w));
    this.canvas.height = Math.max(1, Math.floor(h));
  }

  // Restart the live clock only. Deterministic seeks also explicitly clear feedback below.
  resetTime(): void {
    this.startTime = performance.now();
  }

  resetFeedback(): void { this.disposeBuffers(); }

  // Wall-clock draw + synchronization/readback, deliberately NOT advertised as GPU-only time.
  measureDraw(time: number): number {
    const pixel = new Uint8Array(4), gl = this.gl;
    const start = performance.now();
    this.draw(time);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return performance.now() - start;
  }

  diagnostics() {
    const gl = this.gl;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      parallelCompile: !!this.parallelExt,
      passes: this.bufferNames.map(target => {
        const passes = this.passes.filter(p => p.TARGET === target);
        const requestedFloat = passes.some(p => truthy(p.FLOAT));
        return { target, width: this.canvas.width, height: this.canvas.height,
          format: requestedFloat && this.canFloat ? 'RGBA16F' : 'RGBA8',
          filter: passes.find(p => p.FILTER)?.FILTER ?? 'LINEAR',
          persistent: passes.some(p => truthy(p.PERSISTENT)),
          fallback: requestedFloat && !this.canFloat,
          ignoredDimensions: passes.some(p => p.WIDTH !== undefined || p.HEIGHT !== undefined) };
      }),
    };
  }

  private loc(name: string): WebGLUniformLocation | null {
    if (!this.locs.has(name)) {
      this.locs.set(name, this.gl.getUniformLocation(this.program!, name));
    }
    return this.locs.get(name) ?? null;
  }

  // Common + INPUT uniforms for one pass. Buffer sampler bindings happen in draw().
  // meta lets a deterministic driver (the video exporter) override the live-loop defaults so motion
  // speed matches wall-clock at the export fps and feedback advances exactly once per output frame.
  private setUniforms(t: number, passIndex: number, meta?: FrameMeta): void {
    const gl = this.gl;
    gl.uniform2f(this.loc('RENDERSIZE'), this.canvas.width, this.canvas.height);
    gl.uniform1f(this.loc('TIME'), t);
    gl.uniform1f(this.loc('TIMEDELTA'), meta?.timeDelta ?? 1 / 60);
    gl.uniform1i(this.loc('FRAMEINDEX'), meta?.frameIndex ?? Math.floor(t * 60));
    gl.uniform1i(this.loc('PASSINDEX'), passIndex);
    if (meta?.date) gl.uniform4f(this.loc('DATE'), meta.date[0], meta.date[1], meta.date[2], meta.date[3]);
    else {
      const d = new Date();
      gl.uniform4f(this.loc('DATE'), d.getFullYear(), d.getMonth() + 1, d.getDate(),
        d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds());
    }

    for (const input of this.inputs) {
      if (RESERVED.has(input.NAME) || input.TYPE === 'image') continue;
      const loc = this.loc(input.NAME);
      if (!loc) continue;
      const v = this.values.get(input.NAME);
      switch (input.TYPE) {
        case 'float':
          gl.uniform1f(loc, Number(v));
          break;
        case 'bool':
        case 'event':
          gl.uniform1i(loc, v ? 1 : 0);
          break;
        case 'long':
          gl.uniform1i(loc, Number(v) | 0);
          break;
        case 'color': {
          const c = (v as number[]) ?? [1, 1, 1, 1];
          gl.uniform4f(loc, c[0] ?? 1, c[1] ?? 1, c[2] ?? 1, c[3] ?? 1);
          break;
        }
        case 'point2D': {
          const p = (v as number[]) ?? [0, 0];
          gl.uniform2f(loc, p[0] ?? 0, p[1] ?? 0);
          break;
        }
      }
    }
  }

  draw(time?: number, meta?: FrameMeta): void {
    const gl = this.gl;
    if (!this.program) return;
    const t = time ?? (performance.now() - this.startTime) / 1000;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const passList: ISFPass[] = this.passes.length ? this.passes : [{}];
    this.ensureBuffers();

    for (let pi = 0; pi < passList.length; pi++) {
      const target = passList[pi].TARGET;

      // destination: an offscreen buffer, or the screen (a pass with no TARGET)
      if (target) {
        const bt = this.buffers.get(target)!;
        const writeKey = bt.read === 'a' ? 'b' : 'a';
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, bt[writeKey], 0);
        gl.viewport(0, 0, this.bufW, this.bufH);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      }

      // bind every buffer's current (read) texture as a sampler — including the one being
      // written: ping-pong guarantees read != write, so a feedback pass reads last frame
      let unit = 0;
      for (const name of this.bufferNames) {
        const bt = this.buffers.get(name)!;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, bt[bt.read]);
        gl.uniform1i(this.loc(name), unit);
        unit++;
      }
      // bind image inputs (poster textures) on the units after the buffers
      for (const ii of this.imageInputs) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, ii.tex ?? this.fallbackTex);
        gl.uniform1i(this.loc(ii.name), unit);
        unit++;
      }

      this.setUniforms(t, pi, meta);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // what we just wrote becomes the latest content for later passes + next frame
      if (target) {
        const bt = this.buffers.get(target)!;
        bt.read = bt.read === 'a' ? 'b' : 'a';
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // True if any TARGET persists across frames — feedback. Posters warm these up.
  hasFeedback(): boolean {
    return this.passes.some((p) => !!p.TARGET && truthy(p.PERSISTENT));
  }

  // (Re)allocate ping-pong textures for every TARGET at the current canvas size.
  private ensureBuffers(): void {
    if (this.bufferNames.length === 0) return;
    const w = Math.max(1, this.canvas.width);
    const h = Math.max(1, this.canvas.height);
    if (this.buffers.size === this.bufferNames.length && this.bufW === w && this.bufH === h) return;
    this.disposeBuffers();
    const gl = this.gl;
    this.fbo = gl.createFramebuffer();
    const floats = new Set<string>();
    for (const p of this.passes) if (p.TARGET && truthy(p.FLOAT)) floats.add(p.TARGET);
    for (const name of this.bufferNames) {
      const float = floats.has(name) && this.canFloat;
      this.buffers.set(name, {
        a: this.createBufferTex(w, h, float, this.passes.find(p => p.TARGET === name && p.FILTER)?.FILTER),
        b: this.createBufferTex(w, h, float, this.passes.find(p => p.TARGET === name && p.FILTER)?.FILTER),
        read: 'a',
        float,
      });
    }
    this.bufW = w;
    this.bufH = h;
  }

  private createBufferTex(w: number, h: number, float: boolean, sampling: ISFPass['FILTER'] = 'LINEAR'): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const filter = sampling === 'NEAREST' ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (float) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    // clear to transparent black so frame-0 feedback starts from a clean slate
    const clearFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, clearFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(clearFbo);
    return tex;
  }

  private disposeBuffers(): void {
    const gl = this.gl;
    for (const bt of this.buffers.values()) {
      gl.deleteTexture(bt.a);
      gl.deleteTexture(bt.b);
    }
    this.buffers.clear();
    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo);
      this.fbo = null;
    }
    this.bufW = 0;
    this.bufH = 0;
  }

  // The drawn frame as bottom-up straight-alpha RGBA8 (the canvas is premultipliedAlpha:false). The
  // shared readback shape of the playback contract (lib/isf/playback.ts); the WebGPU runtime returns
  // the same layout, so an A/B host can diff the two without re-ordering rows.
  readPixels(): Uint8Array {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  // Block until every draw issued so far has executed on the GPU. gl.finish() is not a reliable
  // fence in Chrome (the command buffer may be flushed without the driver completing), so this reads
  // one pixel back, which cannot return before the work is done. Perf measurement only.
  finish(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }

  toDataURL(): string {
    // OffscreenCanvas has no toDataURL (it uses async convertToBlob) — but only the main-thread
    // headless/poster path calls this, and that always holds an HTMLCanvasElement.
    if (!('toDataURL' in this.canvas)) throw new Error('toDataURL is unavailable on an OffscreenCanvas');
    return this.canvas.toDataURL('image/png');
  }

  // Cheap average-hash over a downscaled read of the current frame (dedup signal).
  averageHash(): string {
    const gl = this.gl;
    const N = 8;
    const fw = this.canvas.width;
    const fh = this.canvas.height;
    const px = new Uint8Array(fw * fh * 4);
    gl.readPixels(0, 0, fw, fh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const cells: number[] = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const sx = Math.floor((x + 0.5) * (fw / N));
        const sy = Math.floor((y + 0.5) * (fh / N));
        const i = (sy * fw + sx) * 4;
        cells.push((px[i] + px[i + 1] + px[i + 2]) / 3);
      }
    }
    const avg = cells.reduce((a, b) => a + b, 0) / cells.length;
    let bits = '';
    for (const c of cells) bits += c >= avg ? '1' : '0';
    let hex = '';
    for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  }

  dispose(): void {
    this.loadSeq++;
    this.onAssetLoad = null;
    this.disposeBuffers();
    for (const ii of this.imageInputs) if (ii.tex) this.gl.deleteTexture(ii.tex);
    this.imageInputs = [];
    if (this.fallbackTex) this.gl.deleteTexture(this.fallbackTex);
    if (this.program) this.gl.deleteProgram(this.program);
    this.fallbackTex = null; this.program = null;
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.quad);
    if (this.ownsContext) this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function cleanLog(log: string, lineShift = 0): string {
  // GLSL logs are noisy; trim and prefix so the editor/agent shows something usable. "ERROR: 0:22:"
  // becomes "line 9:", counted in the .fs file being edited (lineShift maps prelude lines away).
  const lines = log.split('\n').filter(Boolean).slice(0, 6)
    .map((l) => l.replace(/^(ERROR|WARNING): \d+:(\d+):\s*/, (_m, kind: string, n: string) =>
      `${kind === 'WARNING' ? 'warning, ' : ''}line ${Math.max(1, +n + lineShift)}: `));
  return 'compile: ' + lines.join(' / ');
}

// Headless one-shot used by the /render contract page (and poster generation).
export interface HeadlessResult {
  compileOk: boolean;
  errors: string[];
  pngDataUrl: string | null;
  renderHash: string | null;
  inputs: ISFInput[];
  // Wall-clock ms for the shader compile + link alone (not the draw). Since load() went async this
  // is no longer time spent BLOCKING the main thread — it's how long the driver took, which is the
  // thing worth recording: it's a stable per-shader cost that the submitter's browser reports once
  // so every future visitor's detail page can decide whether to autoplay it (FAST_COMPILE_MS in
  // lib/hover-play.ts). Public grids never compile at all; they serve posters and recorded clips.
  compileMs: number | null;
  diagnostics?: ReturnType<GlslopRenderer['diagnostics']>;
  benchmark?: Awaited<ReturnType<typeof measureRenderFrames>>;
  // Only for a capture: the requested frames in ascending order. pngDataUrl/renderHash above are then
  // the last of them, so a caller that ignores this field still gets a valid still.
  frames?: CapturedFrame[];
}

// Shared canonical still semantics: clear persistent history, then exactly 120 steps (not time*fps).
// Preserve the existing poster path's TIMEDELTA=1/60 and FRAMEINDEX=floor(TIME*60). These are not
// a simulation timeline scrub. TIME=0 for persistent shaders retains the historical 2-second span.
export function validateStillOptions(opts: RenderOpts) {
  const width = opts.width ?? 512, height = opts.height ?? 512;
  if (![width, height].every(n => Number.isInteger(n) && n >= 1 && n <= 4096) || width * height > 4194304) throw new Error('Still dimensions must fit the 4-megapixel budget (1–4096 per side)');
  if (opts.time !== undefined && (!Number.isFinite(opts.time) || opts.time < 0 || opts.time > 86400)) throw new Error('Invalid still time');
  return { width, height };
}
export async function renderPosterFrame(r: Pick<GlslopRenderer, 'resize' | 'resetFeedback' | 'setInputValue' | 'imagesReady' | 'hasFeedback' | 'draw'>, opts: RenderOpts = {}) {
  const { width, height } = validateStillOptions(opts);
  r.resize(width, height);
  await renderPosterAtCurrentSize(r, opts);
}

// Interactive viewers own their display-resolution policy, rather than the authoring API's 4 MP
// capture budget. Keep the same bounded asset wait and canonical feedback replay in both paths.
export async function renderPosterAtCurrentSize(r: Pick<GlslopRenderer, 'resetFeedback' | 'setInputValue' | 'imagesReady' | 'hasFeedback' | 'draw'>, opts: Pick<RenderOpts, 'time' | 'inputs'> = {}) {
  validateStillOptions({ time: opts.time });
  r.resetFeedback();
  if (opts.inputs) for (const [k, v] of Object.entries(opts.inputs)) r.setInputValue(k, v);
  await r.imagesReady();
  if (r.hasFeedback()) {
    const span = (opts.time ?? 0) > 0 ? opts.time! : 2;
    for (let i = 1; i <= 120; i++) r.draw(span * i / 120);
  } else r.draw(opts.time ?? 0);
}

// Call after the initial deterministic still. Restore that still after measuring sequential draws.
export async function measureRenderFrames(r: GlslopRenderer, opts: RenderOpts) {
  const samples: number[] = [];
  for (let i = 0; i < 15; i++) {
    const elapsed = r.measureDraw((opts.time ?? 0) + i / 60);
    if (i >= 3) samples.push(elapsed);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  samples.sort((a, b) => a - b);
  await renderPosterFrame(r, opts);
  return { method: 'draw-plus-synchronized-readback-wall-ms', samples,
    medianMs: samples[Math.floor(samples.length / 2)], p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
    width: r.canvas.width, height: r.canvas.height, time: opts.time ?? 0,
    note: 'Includes synchronization/readback overhead. Not pure GPU time or a general FPS promise.' };
}

// ---- the stepped timeline -----------------------------------------------------------------------
// Every deterministic driver — the video exporter, the clip batch behind it, captureTimeline — steps
// the SAME timeline: frame i is drawn at TIME=i/fps with TIMEDELTA=1/fps and FRAMEINDEX=i, so feedback
// advances exactly once per frame and motion matches wall-clock at that fps. It is defined once, here,
// so a capture can never disagree with the clip a visitor downloads.
export function timelineMeta(frame: number, fps: number, extra?: Partial<FrameMeta>): FrameMeta {
  return { ...extra, timeDelta: 1 / fps, frameIndex: frame };
}
export function drawTimelineFrame(r: Pick<GlslopRenderer, 'draw'>, frame: number, fps: number, extra?: Partial<FrameMeta>): void {
  r.draw(frame / fps, timelineMeta(frame, fps, extra));
}
const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
// Step frames [from, to) without capturing: the warm-up that makes "start at frame N" correct for a
// feedback shader, whose history cannot be seeked. Yields every eight frames so a long warm-up never
// freezes the tab. The exporter passes a rAF yield so the page can paint progress; a headless capture
// keeps the default task yield, which also runs in a background tab.
export async function advanceTimeline(
  r: Pick<GlslopRenderer, 'draw'>, from: number, to: number, fps: number,
  opts: { signal?: AbortSignal; meta?: Partial<FrameMeta>; yieldNow?: () => Promise<void> } = {},
): Promise<void> {
  const yieldNow = opts.yieldNow ?? yieldTask;
  for (let i = from; i < to; i++) {
    if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    drawTimelineFrame(r, i, fps, opts.meta);
    if ((i & 7) === 0) await yieldNow();
  }
}

// Bounds for one capture call. The frame ceiling is the export UI's own (five minutes at 60 fps); the
// returned-frame ceiling keeps a single postMessage reply to tens of megabytes at the 4 MP size cap.
export const CAPTURE_CAPS = { maxFps: 60, maxFrame: 18000, maxFrames: 120 } as const;
// DATE is pinned during a capture so the same input gives the same pixels — a live DATE makes every
// shader that reads it irreproducible. A real date, so month/day arithmetic in a shader stays sane.
export const CAPTURE_DATE: readonly [number, number, number, number] = [2000, 1, 1, 0];

export function validateCaptureOptions(c: CaptureOpts | undefined): { fps: number; frames: number[] } {
  if (!c || typeof c !== 'object' || !Array.isArray(c.frames)) throw new Error('capture.frames must be an array of frame indices');
  const fps = c.fps ?? 60;
  if (!Number.isInteger(fps) || fps < 1 || fps > CAPTURE_CAPS.maxFps) throw new Error(`capture.fps must be an integer between 1 and ${CAPTURE_CAPS.maxFps}`);
  if (c.frames.length < 1 || c.frames.length > CAPTURE_CAPS.maxFrames) throw new Error(`capture.frames must list 1–${CAPTURE_CAPS.maxFrames} frames`);
  for (const f of c.frames) if (!Number.isInteger(f) || f < 0 || f > CAPTURE_CAPS.maxFrame) throw new Error(`capture frame indices must be integers between 0 and ${CAPTURE_CAPS.maxFrame}`);
  return { fps, frames: [...new Set(c.frames)].sort((a, b) => a - b) };
}

export interface CapturedFrame { frame: number; time: number; pngDataUrl: string; renderHash: string }

// A stepped capture — the honest simulation timeline that the 120-step poster is not (rendering.txt).
// Clears history, steps from frame 0 with real per-frame state, and returns the listed frames. A shader
// with no persistent target carries nothing between frames, so only the listed frames are drawn: the
// same pixels at a fraction of the cost.
export async function captureTimeline(
  r: Pick<GlslopRenderer, 'resize' | 'resetFeedback' | 'setInputValue' | 'imagesReady' | 'hasFeedback' | 'draw' | 'toDataURL' | 'averageHash'>,
  opts: RenderOpts,
): Promise<CapturedFrame[]> {
  const { width, height } = validateStillOptions({ width: opts.width, height: opts.height });
  const { fps, frames } = validateCaptureOptions(opts.capture);
  r.resize(width, height);
  r.resetFeedback();
  if (opts.inputs) for (const [k, v] of Object.entries(opts.inputs)) r.setInputValue(k, v);
  await r.imagesReady();
  const meta: Partial<FrameMeta> = { date: CAPTURE_DATE };
  const out: CapturedFrame[] = [];
  let next = 0; // the first frame the feedback state has not yet seen
  for (const frame of frames) {
    if (r.hasFeedback()) { await advanceTimeline(r, next, frame, fps, { meta }); next = frame + 1; }
    drawTimelineFrame(r, frame, fps, meta);
    out.push({ frame, time: frame / fps, pngDataUrl: r.toDataURL(), renderHash: r.averageHash() });
    await yieldTask();
  }
  return out;
}

export async function renderHeadless(isfSource: string, opts: RenderOpts = {}): Promise<HeadlessResult> {
  const { width, height } = validateStillOptions(opts);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  let r: GlslopRenderer;
  try {
    r = new GlslopRenderer(canvas);
  } catch (e) {
    return { compileOk: false, errors: [(e as Error).message], pngDataUrl: null, renderHash: null, inputs: [], compileMs: null };
  }
  const t0 = performance.now();
  const res = await r.load(isfSource);
  const compileMs = Math.round(performance.now() - t0);
  if (!res.compileOk) {
    r.dispose();
    return { compileOk: false, errors: res.errors, pngDataUrl: null, renderHash: null, inputs: res.inputs, compileMs };
  }
  if (opts.inputs) {
    for (const [k, v] of Object.entries(opts.inputs)) r.setInputValue(k, v);
  }
  try {
    if (opts.capture) {
      const frames = await captureTimeline(r, { ...opts, width, height });
      const last = frames[frames.length - 1];
      return { compileOk: true, errors: [], pngDataUrl: last.pngDataUrl, renderHash: last.renderHash,
        inputs: res.inputs, compileMs, diagnostics: r.diagnostics(), frames };
    }
    await renderPosterFrame(r, { ...opts, width, height });
    const benchmark = opts.benchmark ? await measureRenderFrames(r, opts) : undefined;
    return { compileOk: true, errors: [], pngDataUrl: r.toDataURL(), renderHash: r.averageHash(),
      inputs: res.inputs, compileMs, diagnostics: r.diagnostics(), ...(benchmark ? { benchmark } : {}) };
  } finally { r.dispose(); }
}
