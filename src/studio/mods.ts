// Mod loading. Order: core mods (shipped in src/core) -> user mods (~/.glslop-studio/mods/*).
// A user mod is either `mods/<name>.js` or `mods/<name>/index.js` (ES module; may import siblings).
// settings.json `disabledMods: ["core:advisor", "my-mod"]` skips any of them, core included.
import type { Studio, StudioMod } from './api';
import { joinPath } from './host';

export async function loadCoreMods(studio: Studio, core: Record<string, StudioMod>): Promise<void> {
  const disabled = new Set<string>(studio.settings.disabledMods ?? []);
  for (const [name, mod] of Object.entries(core)) {
    const id = `core:${name}`;
    if (disabled.has(id)) { studio.mods.set(id, { id, kind: 'core', enabled: false, description: mod.description }); continue; }
    await studio.addMod(id, mod, 'core');
  }
}

export async function discoverUserMods(studio: Studio): Promise<{ id: string; url: string; path: string }[]> {
  const dir = studio.host.paths.mods;
  const entries = await studio.host.list(dir).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    if (!e.dir && /\.m?js$/.test(e.name)) out.push({ id: e.name.replace(/\.m?js$/, ''), url: studio.host.modUrl(e.name), path: e.path });
    else if (e.dir && (await studio.host.exists(joinPath(e.path, 'index.js')))) out.push({ id: e.name, url: studio.host.modUrl(`${e.name}/index.js`), path: e.path });
  }
  return out;
}

export async function loadUserMod(studio: Studio, m: { id: string; url: string; path: string }) {
  try {
    const ns = await import(/* @vite-ignore */ `${m.url}?v=${Date.now()}`);
    const mod: StudioMod = ns.default?.activate ? ns.default : ns.activate ? { activate: ns.activate, description: ns.description } : ns.default;
    if (!mod?.activate) throw new Error('mod must export `activate(studio)` or a default { activate }');
    return studio.addMod(m.id, mod, 'user', m.path);
  } catch (e) {
    const info = { id: m.id, kind: 'user' as const, path: m.path, enabled: false, error: String((e as Error)?.stack ?? e) };
    studio.mods.set(m.id, info);
    studio.events.emit('mods:changed', info);
    console.error(`[mod ${m.id}]`, e);
    return info;
  }
}

export async function loadUserMods(studio: Studio): Promise<void> {
  const disabled = new Set<string>(studio.settings.disabledMods ?? []);
  for (const m of await discoverUserMods(studio)) {
    if (disabled.has(m.id)) { studio.mods.set(m.id, { id: m.id, kind: 'user', path: m.path, enabled: false }); continue; }
    await loadUserMod(studio, m);
  }
}

/** Tools for managing mods — so an agent can install/reload/remove mods without touching the UI. */
export function registerModTools(studio: Studio, core: Record<string, StudioMod>) {
  studio.tools.add({
    name: 'mods.list',
    description: 'List loaded mods (core and user), their status and errors, and the mods folder path.',
    run: () => ({ folder: studio.host.paths.mods, mods: [...studio.mods.values()].map(({ dispose, ...m }) => m) }),
  }, 'core:mods');

  studio.tools.add({
    name: 'mods.reload',
    description: 'Reload one user mod (id) or rescan and reload all user mods. Use after editing files in the mods folder.',
    input: { type: 'object', properties: { id: { type: 'string' } } },
    async run(args: { id?: string }) {
      const found = await discoverUserMods(studio);
      const targets = args.id ? found.filter((m) => m.id === args.id) : found;
      if (args.id && !targets.length) {
        if (core[args.id.replace(/^core:/, '')]) return studio.addMod(`core:${args.id.replace(/^core:/, '')}`, core[args.id.replace(/^core:/, '')], 'core');
        throw new Error(`no mod "${args.id}" in ${studio.host.paths.mods}`);
      }
      const results = [];
      for (const m of targets) results.push(await loadUserMod(studio, m));
      return results.map(({ dispose, ...r }: any) => r);
    },
  }, 'core:mods');

  studio.tools.add({
    name: 'mods.disable',
    description: 'Unload a mod (core or user) now; persist:true also keeps it disabled across launches.',
    input: { type: 'object', properties: { id: { type: 'string' }, persist: { type: 'boolean' } }, required: ['id'] },
    async run(args: { id: string; persist?: boolean }) {
      studio.removeMod(args.id);
      if (args.persist) {
        studio.settings.disabledMods = [...new Set([...(studio.settings.disabledMods ?? []), args.id])];
        await studio.saveSettings();
      }
      return { disabled: args.id };
    },
  }, 'core:mods');

  studio.tools.add({
    name: 'mods.enable',
    description: 'Re-enable a disabled mod and remove it from the persisted disabled list.',
    input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run(args: { id: string }) {
      studio.settings.disabledMods = (studio.settings.disabledMods ?? []).filter((x: string) => x !== args.id);
      await studio.saveSettings();
      return studio.call('mods.reload', { id: args.id });
    },
  }, 'core:mods');

  studio.tools.add({
    name: 'mods.write',
    description: 'Write a file into the mods folder (e.g. "my-mod/index.js") and reload that mod. The fastest way for an agent to change the app.',
    input: { type: 'object', properties: { file: { type: 'string' }, contents: { type: 'string' }, reload: { type: 'boolean' } }, required: ['file', 'contents'] },
    async run(args: { file: string; contents: string; reload?: boolean }) {
      if (/(^|[\\/])\.\.([\\/]|$)/.test(args.file)) throw new Error('file must stay inside the mods folder');
      const path = joinPath(studio.host.paths.mods, args.file);
      await studio.host.writeText(path, args.contents);
      const id = args.file.split(/[\\/]/)[0].replace(/\.m?js$/, '');
      return { path, reloaded: args.reload === false ? null : await studio.call('mods.reload', { id }).catch((e) => ({ error: String(e.message) })) };
    },
  }, 'core:mods');

  studio.tools.add({
    name: 'mods.eval',
    description: 'Evaluate JavaScript in the studio window with `studio` in scope; returns the (awaited) result. For quick experiments; persist real changes with mods.write.',
    input: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    async run(args: { code: string }) {
      const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
      return await new AsyncFn('studio', args.code)(studio);
    },
  }, 'core:mods');
}
