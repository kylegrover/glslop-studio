# @glslop/core

The shader engine behind [glslop.com](https://glslop.com) and [glslop studio](https://glslop.com/studio):
an ISF parser, a WebGL2 renderer (multipass, feedback, image inputs), a static compile-cost estimator,
feature extraction, and client-side video export. Framework-free TypeScript that runs on the main
thread or in a worker (OffscreenCanvas). CC0: public domain, no attribution needed.

```sh
npm install @glslop/core
# for video export also: npm install mediabunny gifenc
```

Each module is its own entry point, so you only pay for what you import:

```ts
import { parseISF } from '@glslop/core/parse';
import { GlslopRenderer, renderPosterFrame, runtimeConfig } from '@glslop/core/runtime';

runtimeConfig.posterBase = 'https://glslop.com'; // where image-input textures come from (see below)

const canvas = document.querySelector('canvas')!;
const r = new GlslopRenderer(canvas);
const res = await r.load(isfSource);
if (!res.compileOk) console.error(res.errors); // "compile: line 12: 'foo' : undeclared identifier"

r.resize(canvas.width, canvas.height);
const loop = (t: number) => { r.draw(t / 1000); requestAnimationFrame(loop); };
requestAnimationFrame(loop);
```

| Entry point | What it does |
|---|---|
| `@glslop/core/parse` | `parseISF(src)`: the JSON header, inputs and passes of an ISF shader |
| `@glslop/core/runtime` | `GlslopRenderer` (load, draw, inputs, readPixels), poster/timeline/capture helpers, `runtimeConfig` |
| `@glslop/core/budget` | `loopBudget(isf)`: static estimate of how heavy a shader is to compile on Windows (D3D11/FXC) |
| `@glslop/core/extract` | `extractFeatures(isf)`: techniques and vocabulary glslop uses for tags and technique pages |
| `@glslop/core/export-video` | `exportVideo(isf, opts)`: MP4/WebM (mediabunny) or GIF (gifenc), in the browser |
| `@glslop/core/auto-motion` | knob automation for exported clips |
| `@glslop/core/highlight` | `highlightIsf(src)`: HTML syntax highlighting for ISF |
| `@glslop/core/jitter` | the browse grid's deterministic per-card tilt |
| `@glslop/core/glsl-pages` | the technique pages' content |
| `@glslop/core/limits` | `MAX_ISF_BYTES`: the size glslop.com accepts |
| `@glslop/core/types`, `compile-wait`, `avc-config`, `vocab` | supporting types and helpers |

## runtimeConfig

Set once per JS realm (the page, and again inside each worker) before loading shaders:

- `posterBase`: origin that shader posters (image inputs) are fetched from. `''` (default) means
  root-relative, which is right on glslop.com itself. Anywhere else, set `'https://glslop.com'`.
- `textureUrl(shaderId)`: override where a source shader's still comes from, e.g. a local cache.
- `captureTranslated`: keep the driver's translated source in `renderer.lastCompile` (off by default;
  it is a large string for heavy shaders).
- `blockingCompile`: skip `KHR_parallel_shader_compile`, so `load()` blocks for exactly the driver's
  time. Useful for cost measurements in hidden windows, where timers are throttled.

## Notes

- ISF here means glslop's dialect: GLSL ES 1.00 bodies with an ISF JSON header, rendered in WebGL2.
  See https://glslop.com/isf.txt.
- Shipped as compiled ES2022 JavaScript with type declarations, plus the TypeScript source and source
  maps. Developed in https://github.com/kylegrover/glslop-studio (`packages/core`).
- Pre-1.0: minor versions may change APIs. Pin `~0.1.0` if that matters to you.
