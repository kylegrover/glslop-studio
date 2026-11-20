# @glslop/ui

Svelte 5 components and styles shared by [glslop.com](https://glslop.com) and
[glslop studio](https://glslop.com/studio). CC0: public domain, no attribution needed.

```sh
npm install @glslop/ui @glslop/core svelte
# VideoExport also needs: npm install mediabunny gifenc
```

Shipped as Svelte/TypeScript source, so use it from a Svelte-aware bundler (Vite with
`@sveltejs/vite-plugin-svelte`, SvelteKit, Astro with `@astrojs/svelte`).

| Import | What it is |
|---|---|
| `@glslop/ui/IsfCodeArea.svelte` | a textarea with live ISF syntax highlighting, file drop and a size warning (`bind:value`) |
| `@glslop/ui/VideoExport.svelte` | the "export clip" panel: MP4/WebM/GIF of a shader, rendered in the browser |
| `@glslop/ui/brutal.css` | glslop's site stylesheet |
| `@glslop/ui/code.css` | the code-highlighting colours (IsfCodeArea imports it itself) |

## VideoExport props

```svelte
<VideoExport isf={source} name="my-shader" />
```

The defaults give the website's behaviour (a browser download). A host changes them with props:

- `save(blob, filename)`: where the file goes; return a label for the "show" button.
- `onStart()`: called before anything is allocated. Return a string to refuse the export (shown to
  the user), e.g. while another renderer can't be paused. Use it to pause your live preview.
- `onEnd()`: the export finished, failed or was cancelled; resume your preview.
- `reveal(label)`: shows a "show" button after saving (desktop).
- `liveInputs`: the viewer's current knob values, so the clip matches what's on screen.
- `where`, `savedWord`: wording ("in your browser" + "downloaded" by default).

Developed in https://github.com/kylegrover/glslop-studio (`packages/ui`).
