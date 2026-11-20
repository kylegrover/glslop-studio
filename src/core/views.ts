// Core mod: the built-in views and the viewer-driving tools. Each view is a Svelte component wrapped
// in the framework-agnostic View.mount contract — a user mod registering the same id replaces it.
import { mount, unmount } from 'svelte';
import type { Studio, StudioMod } from '../studio/api';
import Browse from '../ui/Browse.svelte';
import Viewer from '../ui/Viewer.svelte';
import ShaderPage from '../ui/ShaderPage.svelte';
import Glsl from '../ui/Glsl.svelte';
import Bench from '../ui/Bench.svelte';
import Settings from '../ui/Settings.svelte';

export function svelteView(Component: any) {
  return (el: HTMLElement, studio: Studio, params: Record<string, unknown>) => {
    const c = mount(Component, { target: el, props: { studio, params } });
    return () => unmount(c);
  };
}

const mod: StudioMod = {
  description: 'Built-in views (browse, shader, new, glsl, bench, settings) and viewer tools.',
  activate(studio: Studio) {
    studio.views.add({ id: 'browse', title: 'browse', order: 10, mount: svelteView(Browse) });
    studio.views.add({ id: 'viewer', title: 'new', order: 20, mount: svelteView(Viewer) });
    studio.views.add({ id: 'glsl', title: 'glsl', order: 30, mount: svelteView(Glsl) });
    studio.views.add({ id: 'bench', title: 'bench', order: 40, mount: svelteView(Bench) });
    // A shader's detail page (glslop.com /shader/[id]); reached from browse, not the nav.
    studio.views.add({ id: 'shader', title: 'shader', hidden: true, mount: svelteView(ShaderPage) });
    studio.views.add({ id: 'settings', title: 'settings', order: 90, mount: svelteView(Settings) });

    const viewer = async () => {
      if (!['viewer', 'shader', 'glsl'].includes(studio.state.activeView) || !studio.state.viewer) {
        studio.views.open('viewer', {});
        await new Promise((r) => setTimeout(r, 50));
      }
      return studio.state.viewer;
    };

    studio.tools.add({
      name: 'viewer.open',
      description: 'Show a shader to the human: a corpus id opens its detail page; a file path or raw isf opens the editor.',
      input: { type: 'object', properties: { id: { type: 'string' }, path: { type: 'string' }, isf: { type: 'string' }, title: { type: 'string' } } },
      async run(args: any) {
        studio.views.open(args.id && !args.isf && !args.path ? 'shader' : 'viewer', args);
        await new Promise((r) => setTimeout(r, 50));
        const v = studio.state.viewer;
        await new Promise((r) => setTimeout(r, 0));
        return { title: v?.title, id: v?.id };
      },
    });

    studio.tools.add({
      name: 'viewer.setSource',
      description: 'Replace the live viewer\'s source (hot reload). The human sees it immediately, with an "updated by agent" flash. Returns the compile result; pass weight:true to also get the gauges (desktop + browser/d3d11 compile-to-first-frame; glslop.com autoplays under 500 ms).',
      input: { type: 'object', properties: { isf: { type: 'string' }, title: { type: 'string' }, weight: { type: 'boolean' } }, required: ['isf'] },
      async run(args: { isf: string; title?: string; weight?: boolean }, ctx) {
        const v = await viewer();
        const r = await v.setSource(args.isf, args.title, ctx.caller === 'ui' ? 'you' : 'agent');
        if (!args.weight || !r.ok || !studio.state.weight) return r;
        return { ...r, weight: await studio.call('weight.measure', { isf: args.isf }, { caller: ctx.caller }) };
      },
    });

    studio.tools.add({
      name: 'viewer.state',
      description: 'What the human is looking at: shader id/title, current input values, compile errors/time.',
      async run() {
        const v = studio.state.viewer;
        if (!v) return { open: false };
        return { open: studio.state.activeView === 'viewer', id: v.id, title: v.title, values: v.values, errors: v.errors, compileMs: v.compileMs, sourceBytes: v.source.length, weight: v.weight ?? null };
      },
    });

    studio.tools.add({
      name: 'viewer.getSource',
      description: 'The live viewer\'s current source (including the human\'s unsaved edits).',
      async run() { return { isf: studio.state.viewer?.source ?? null }; },
    });

    studio.tools.add({
      name: 'viewer.setInputs',
      description: 'Set ISF input values on the live viewer, e.g. {"values": {"speed": 2}}.',
      input: { type: 'object', properties: { values: { type: 'object' } }, required: ['values'] },
      async run(args: { values: Record<string, unknown> }) {
        const v = await viewer();
        for (const [k, x] of Object.entries(args.values)) v.setValue(k, x);
        return { values: v.values };
      },
    });

    studio.tools.add({
      name: 'viewer.snapshot',
      description: 'Save what the viewer is showing right now (exact pixels, current size) as a PNG; returns the path.',
      input: { type: 'object', properties: { out: { type: 'string' } } },
      async run(args: { out?: string }) {
        const v = await viewer();
        const path = args.out ?? `${studio.host.paths.workspace}/snapshots/${(v.id ?? 'scratch')}-${Date.now()}.png`;
        await studio.host.writeBase64(path, v.snapshot());
        return { path };
      },
    });

    studio.tools.add({
      name: 'ui.toast',
      description: 'Show a short message to the human in the studio window.',
      input: { type: 'object', properties: { msg: { type: 'string' }, kind: { type: 'string', enum: ['info', 'error'] } }, required: ['msg'] },
      run(args: { msg: string; kind?: 'info' | 'error' }) { studio.toast(args.msg, args.kind); return { shown: true }; },
    });

    studio.tools.add({
      name: 'ui.openView',
      description: 'Switch the studio to a view by id (browse, viewer, bench, settings, or any mod view).',
      input: { type: 'object', properties: { id: { type: 'string' }, params: { type: 'object' } }, required: ['id'] },
      run(args: { id: string; params?: Record<string, unknown> }) { studio.views.open(args.id, args.params ?? {}); return { views: studio.views.list().map((v) => v.id) }; },
    });

    studio.commands.add({ id: 'goto.browse', title: 'Browse', key: 'Ctrl+1', run: (s) => s.views.open('browse') });
    studio.commands.add({ id: 'goto.viewer', title: 'Viewer', key: 'Ctrl+2', run: (s) => s.views.open('viewer') });
    studio.commands.add({ id: 'goto.glsl', title: 'GLSL techniques', key: 'Ctrl+3', run: (s) => s.views.open('glsl') });
    studio.commands.add({ id: 'goto.bench', title: 'Bench', key: 'Ctrl+4', run: (s) => s.views.open('bench') });
  },
};
export default mod;
