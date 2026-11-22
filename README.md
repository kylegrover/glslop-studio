# glslop studio

A desktop app (Tauri 2) for browsing and making [glslop](https://glslop.com) ISF shaders on Windows,
macOS and Linux. Your own agent drives it over MCP or HTTP, and you can mod nearly all of it without
forking.

**Why desktop:** on Windows, browsers compile WebGL through ANGLE → D3D11 → FXC, which takes seconds to
minutes for heavy raymarchers. The studio starts its webview with ANGLE on **Vulkan**. On an RTX 3090,
the heaviest shaders in the corpus reach their first frame roughly **10–200× faster** from cold (the
worst goes from 351 s to about 12 s), and near-instantly once the GPU driver has cached them. Every
shader compiles. See [docs/COMPILE-COST.md](docs/COMPILE-COST.md).

Current release, what's next and what's parked: [ROADMAP.md](ROADMAP.md). How to ship one: [RELEASING.md](RELEASING.md).

## Run

```sh
npm install
npm run app          # tauri dev (needs Rust + the Tauri prerequisites for your OS)
npm run dev          # UI only, in a browser at http://localhost:1420 (browser's own backend, no bridge)
npm run app:build    # installers
```

## Test

```sh
npm run check                    # typecheck + unit tests (tests/*.test.ts)
cd src-tauri && cargo test       # Rust unit tests
npx tauri build --no-bundle      # then, against that build:
npm run test:app                 # ~40 checks on a hidden, isolated copy (editing, autosave, updates, permissions)
npm run test:publish             # sign-in + the real publish window, against a local glslop dev server
```

Both app tests use their own home folder and keychain entry, so they never touch your real app or
sign-in. `test:publish` refuses anything but a localhost server; how to start one is in its header.

Backend: **settings → graphics backend** (relaunches), or set `GLSLOP_ANGLE=d3d11|vulkan|gl|default` for
one launch. `GLSLOP_NO_GPU_CACHE=1` disables Chromium's shader disk cache (the GPU driver keeps its own).
macOS (Metal) and Linux (GL) ignore the ANGLE switch.

## What's here

- **browse**: glslop.com's grid, searchable and sortable. Hovering a shader plays it live.
- **shader pages**: live render, ISF controls, source, lineage, image and video export.
- **new**: glslop's highlighted editor with hot reload, the translated (driver-side) source, and the
  compile **advisor**, which warns when a shader will be slow for glslop.com visitors.
- **account**: sign in with glslop and publish. Publishing always asks you first, in a window that shows exactly what will be sent.
- **bench** (Settings → shader weight, or Ctrl+4): compile the corpus on the current backend and compare it with the D3D11 reference.
- **settings**: backend, paths, mods (enable/disable/reload and errors), and the tool list.

## Agents

```sh
claude mcp add glslop-studio -- node /path/to/glslop-studio/bin/glslop-studio-mcp.mjs
```

Or use HTTP with the token from `~/.glslop-studio/bridge.json`, or `node bin/studio.mjs <tool> '<json>'`.
That token is full control of the app, so keep it private. Neither it nor a mod can read your glslop
login or publish without your click. → [docs/AGENT-API.md](docs/AGENT-API.md)

## Mods

Drop a `.js` file into `~/.glslop-studio/mods/` to add or replace tools, views, commands and advisor
rules, or to swap out the whole shell. Built-in features use the same API, so they can be disabled too.
Mods are trusted code with the same file access as the app: only install ones you would run as a script.
→ [docs/MODDING.md](docs/MODDING.md) · example: [examples/mods/hello-mod](examples/mods/hello-mod/index.js)

## Layout

```
src-tauri/src/         native shell: backend flags, file access, studio:// scheme, agent bridge, sign-in
src/studio/            the Studio API (registries, events), host abstraction, mod loader, bridge
src/core/              built-in features, each written as a mod: corpus, gl, thumbs, bench, advisor, account
src/ui/                Svelte views
src/engine/            the thumbnail worker
packages/core/         @glslop/core: the WebGL2 ISF runtime, compile-budget estimator, video export
packages/ui/           @glslop/ui: the editor, export panel and glslop's stylesheet
bin/                   MCP server + CLI client (zero deps)
```

`packages/core` is glslop.com's own engine, kept here so the site and the app can share one copy.

License: [CC0-1.0](LICENSE), public domain. Shaders from glslop.com are CC0 too.

## Data, caching and server load

The studio is built to be fast for you and nearly free for glslop.com:

- **Sync:** the slim public list (3 requests), plus source **once** per new shader. Shader source is
  immutable, so it is never re-downloaded. The first run fetches everything in one bulk export page
  (about 1.1 MB). Syncs are throttled to one every 15 minutes, and a warm launch makes **zero**
  requests.
- **Visibility matches the site:** browse shows what glslop.com's public list shows. Superseded
  versions are kept unlisted, for lineage. Anything moderated away upstream is deleted locally,
  thumbnail included.
- **Thumbnails are rendered locally** on your GPU with glslop's poster semantics, in two background
  workers, then cached as content-addressed images in `cache/thumbs` and served `immutable`. Posters
  are downloaded only if a local compile fails, or on Linux, where the system webview cannot render
  in workers (configurable).
- **Hover plays live.** There is one shared GL context and an LRU of 24 compiled shaders, so
  re-hovering resumes instantly. Across launches, Chromium's GPU program cache keeps linked
  binaries. Timing tools deliberately bypass it.
- Lineage, forks, texture edges and technique galleries are all derived locally. Nothing is fetched.
- **Update checks** go to `glslop.com/studio/latest.json` at launch and every 6 hours. The first one
  each UTC day also sends this app's version and OS (`x-glslop-daily: 1`, `x-glslop-version`,
  `x-glslop-os`), and glslop.com adds one to that day's count. That is the whole usage count: no
  install id, no account, nothing about what you do in the app. Turn it off with Settings →
  "send daily usage count" (`dailyCount: false`); updates keep working.
