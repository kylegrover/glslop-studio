# Modding glslop studio

The studio is built to be changed without forking it. Every built-in feature is a **core mod** that uses
the same API you get, so anything core does, you can replace, wrap or switch off.

## Where mods live

```
~/.glslop-studio/            (GLSLOP_STUDIO_HOME overrides)
  settings.json              persisted settings; mods may add keys
  mods/
    my-mod.js                a single-file mod, or
    my-mod/index.js          a folder mod (may `import './other.js'`)
  workspace/                 renders, snapshots, saved shaders, bench CSVs
  cache/corpus.json          the downloaded corpus + local compile measurements
  bridge.json                agent bridge URL + token (rewritten every launch)
```

Names starting with `.` or `_` are ignored. Mods load after core, in alphabetical order. Files are served to the webview at
`studio.host.fileUrl('mods' | 'cache' | 'workspace', rel)` (the `studio://` scheme).

## A mod

```js
export const description = 'what it does';
export function activate(studio) {
  studio.tools.add({ name: 'my.tool', description: '...', input: { type: 'object' }, run: async (args, ctx) => ({}) });
  return () => { /* optional cleanup */ };
}
```

`export default { activate, description }` also works. Registrations made during `activate` are
attributed to your mod and removed automatically when it is disabled or reloaded. Return a cleanup for
anything else (event listeners, pushes into `studio.state` arrays). See `examples/mods/hello-mod`.

Reload without restarting: **settings → reload user mods**, or the `mods.reload` tool. Mod errors appear
in settings next to the mod and never stop the app from booting.

## The `studio` object

It is also `window.studio`, so devtools (right-click → Inspect in a dev build) shows the real thing.

| Member | What it is |
|---|---|
| `studio.tools` | Registry of tools. `add(tool)` adds **or replaces** by name; `wrap(name, old => newTool)`; `remove(name)`; `list()`; `get(name)`. |
| `studio.call(name, args)` | Run a tool. UI buttons, agents and mods all go through this. |
| `studio.views` | Registry of views. Same API, plus `open(id, params)`. A view is `{ id, title, order?, hidden?, mount(el, studio, params) => cleanup? }`. Any framework or none. |
| `studio.commands` | Registry of `{ id, title, key?, run(studio) }`. `key` like `Ctrl+Shift+K`. |
| `studio.events` | `on(name, fn) => off`, `emit(name, payload)`. `'*'` receives everything. |
| `studio.state` | Shared mutable bag. Core puts things here deliberately (below). |
| `studio.settings` / `saveSettings()` | Persisted JSON settings. |
| `studio.host` | Native access: `readText`, `writeText`, `writeBase64`, `writeBytes`, `fileUrl(area, rel)`, `list`, `mkdir`, `remove`, `exists`, `open`, `relaunch`, `paths`, `boot`, raw `invoke`/`listen` for Tauri. **Unrestricted**: mods are trusted code. |
| `studio.addMod(id, mod)` / `removeMod(id)` | Activate a mod object from code. |
| `studio.toast(msg, kind)` | Message the human. |

### Things core puts in `studio.state`

| Key | Meaning |
|---|---|
| `corpus` | `{ version, base, syncedAt, shaders[] }`, each with `isf`, `listed`, `ref_compile_ms`, `local[backend]` |
| `shader(id)` / `lineage(id)` | Fast lookup, plus locally derived parents/children/versions/texture edges |
| `saveCorpus()` / `saveCorpusSoon()` | Persist `corpus` to disk (now / debounced) |
| `thumbs` | `{ cached(id), request(id, priority), cancel(id), failed(id), stats() }` local thumbnail cache |
| `live` | `{ play(id, frameEl), stop(), cached(id), size() }` shared hover-play GL context + LRU |
| `browse` | Browse view state (q, sort, tag, author, seed, scroll) |
| `back()` | Navigate back |
| `account` | `{ signedIn, handle }` for the configured server |
| `glslopApi(path)` | Authenticated **GET** `/api/*` as the signed-in user. Read-only; publishing goes through the `publish` tool, which asks the human in a native dialog |
| `gl` | `{ GlslopRenderer, compileOnce(isf, {cold, keep}), sourceOf({isf\|id\|path}) }` |
| `viewer` | The live viewer session: `id, title, source, values, errors, compileMs, renderer, canvas, setSource(), setValue(), open(), play(), snapshot()` |
| `advisorRules` | Array of `{ id, description, check(input) => findings[] }` used by the `advise` tool. Push, filter or replace. |
| `activeView` | Id of the mounted view |
| `mountShell` | Set this **in a mod** to `(el, studio) => void` to replace the entire app frame (nav and layout). |

### Events emitted by core

`studio:ready`, `corpus:removed`, `thumbs:ready`, `thumbs:compiled`, `thumbs:cleared`, `live:compiled`,
`export:start`, `export:end`, `export:saved`, `browse:filter`, `tools:changed`, `views:changed`, `commands:changed`, `mods:changed`, `settings:changed`,
`tool:before`, `tool:after`, `tool:error`, `tool:progress`, `view:open`, `view:mounted`,
`corpus:changed`, `bench:start`, `bench:result`, `bench:end`, `viewer:compiled`, `viewer:open`,
`render:done`, `toast`.

## Recipes

- **Replace a view:** `studio.views.add({ id: 'browse', title: 'browse', mount(el) { ... } })`.
- **Hide a view:** `studio.views.wrap('bench', v => ({ ...v, hidden: true }))`.
- **Remove a core feature:** add `"core:bench"` to `settings.json` → `disabledMods`. Core mod ids are
  `core:corpus`, `core:gl`, `core:thumbs`, `core:live`, `core:bench`, `core:advisor`, `core:views`.
- **Point at another glslop:** `"glslopBase": "http://127.0.0.1:4399"` in settings.json, then `corpus.fetch`.
- **Intercept every tool call:** `studio.events.on('tool:before', ...)`, or wrap specific tools.
- **Add a Svelte view:** mods are plain ES modules loaded at runtime and are not compiled by the app's
  build, so either ship a pre-built bundle, or write views in vanilla DOM / lit / preact-htm from a CDN.

## Changing the app itself

Mods cover almost everything a webview can do. For changes that need Rust (new native commands,
plugins) or the build, fork the repo. Keep core changes in `src/core/*`, because each one is just a mod
that ships inside the app.
