// The studio object: the ONE surface everything plugs into — built-in features included.
//
// Every built-in feature (corpus, browse, viewer, bench, advisor...) is a "core mod" that uses exactly
// this API, so anything a core mod does, a user mod can undo, wrap or replace. Nothing here is private
// by policy; `window.studio` is the same object, so an agent poking around in devtools sees the truth.
//
// See docs/MODDING.md for the contract. Keep this file small and boring: it is the stable part.

import { host, type Host } from './host';
import { argNames, argProblems } from './schema';

declare const __APP_VERSION__: string; // package.json version, injected by vite.config.ts

export type JsonSchema = Record<string, unknown>;

export interface ToolContext {
  studio: Studio;
  /** Where the call came from: 'ui', 'bridge' (an agent over HTTP/MCP), 'mod', 'console'. */
  caller: string;
  signal?: AbortSignal;
  /** Report progress; the UI shows it, the bridge ignores it. */
  progress: (msg: string, fraction?: number) => void;
}

export interface Tool<A = any, R = any> {
  name: string;
  description: string;
  /** JSON schema for args. Shown to agents verbatim (MCP inputSchema). */
  input?: JsonSchema;
  run: (args: A, ctx: ToolContext) => Promise<R> | R;
  /** Who registered it (filled in by the registry). */
  source?: string;
  /** Hide from agent listings (UI-only helpers). */
  hidden?: boolean;
}

export interface View {
  id: string;
  title: string;
  /** Lower sorts first in the nav. */
  order?: number;
  /** Framework-agnostic: render into `el`, return a cleanup. Svelte, lit, vanilla — your call. */
  mount: (el: HTMLElement, studio: Studio, params: Record<string, unknown>) => void | (() => void);
  /** Hide from the nav (reachable via studio.views.open). */
  hidden?: boolean;
  source?: string;
}

export interface Command {
  id: string;
  title: string;
  /** e.g. "Ctrl+K". Matched against keydown; optional. */
  key?: string;
  run: (studio: Studio) => unknown;
  source?: string;
}

type Listener = (payload: any) => void;

/** A tiny event bus. Names are free-form; the built-ins use "noun:verb" (see docs/MODDING.md). */
export class Events {
  private map = new Map<string, Set<Listener>>();
  on(name: string, fn: Listener): () => void {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name)!.add(fn);
    return () => this.map.get(name)?.delete(fn);
  }
  emit(name: string, payload?: unknown): void {
    for (const fn of [...(this.map.get(name) ?? [])]) {
      try { fn(payload); } catch (e) { console.error(`[event ${name}]`, e); }
    }
    for (const fn of [...(this.map.get('*') ?? [])]) {
      try { fn({ name, payload }); } catch (e) { console.error('[event *]', e); }
    }
  }
}

/** A keyed registry that remembers who registered what and announces changes. */
export class Registry<T extends { source?: string }> {
  readonly items = new Map<string, T>();
  constructor(private kind: string, private events: Events, private key: (t: T) => string) {}
  /** Add or REPLACE. Replacing is a feature, not an error: that is how mods override core behaviour. */
  add(item: T, source = currentSource()): () => void {
    const k = this.key(item);
    const prev = this.items.get(k);
    const tagged = { ...item, source } as T;
    this.items.set(k, tagged);
    this.events.emit(`${this.kind}:changed`, { key: k, item: tagged, replaced: prev ?? null });
    return () => { if (this.items.get(k) === tagged) this.remove(k); };
  }
  remove(k: string): boolean {
    const had = this.items.delete(k);
    if (had) this.events.emit(`${this.kind}:changed`, { key: k, item: null });
    return had;
  }
  get(k: string): T | undefined { return this.items.get(k); }
  list(): T[] { return [...this.items.values()]; }
  /** Wrap an existing entry: `wrap('render', old => ({...old, run: async (a, c) => { ...; return old.run(a, c) }}))`. */
  wrap(k: string, fn: (old: T) => T): () => void {
    const old = this.items.get(k);
    if (!old) throw new Error(`${this.kind} "${k}" is not registered`);
    return this.add(fn(old));
  }
}

// Which mod is currently activating — so registrations are attributed without ceremony.
let activating = 'console';
export function currentSource() { return activating; }
export function withSource<T>(source: string, fn: () => T): T {
  const prev = activating;
  activating = source;
  try { return fn(); } finally { activating = prev; }
}

export interface ModInfo {
  id: string;
  /** 'core' (ships with the app) or 'user' (from the mods folder) or 'inline' (added at runtime). */
  kind: 'core' | 'user' | 'inline';
  path?: string;
  enabled: boolean;
  error?: string;
  description?: string;
  dispose?: () => void;
}

export class Studio {
  readonly version: string = __APP_VERSION__;
  readonly events = new Events();
  readonly tools = new Registry<Tool>('tools', this.events, (t) => t.name);
  readonly views = Object.assign(new Registry<View>('views', this.events, (v) => v.id), {
    open: (id: string, params: Record<string, unknown> = {}) => this.events.emit('view:open', { id, params }),
  });
  readonly commands = new Registry<Command>('commands', this.events, (c) => c.id);
  readonly mods = new Map<string, ModInfo>();
  readonly host: Host = host;
  /** Free-form shared state for mods to coordinate through. Core uses studio.state.corpus etc. */
  readonly state: Record<string, any> = {};
  /** Persisted settings (settings.json in the config dir). Mods may add keys freely. */
  settings: Record<string, any> = {};

  /** Call a tool by name. Everything — UI buttons, agents, other mods — goes through here. */
  async call<R = any>(name: string, args: any = {}, opts: Partial<ToolContext> = {}): Promise<R> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`no tool named "${name}". Known: ${[...this.tools.items.keys()].join(', ')}`);
    // Wrong arguments get a plain answer before the tool runs (and can't leave it half-done).
    const problems = argProblems(args ?? {}, tool.input);
    if (problems.length) {
      const names = argNames(tool.input);
      const e = new Error(`${name}: ${problems.join('; ')}${names.length ? ` (it takes: ${names.join(', ')})` : ''}`);
      this.events.emit('tool:error', { name, args, caller: opts.caller ?? 'console', error: e.message });
      throw e;
    }
    const ctx: ToolContext = {
      studio: this, caller: opts.caller ?? 'console', signal: opts.signal,
      progress: opts.progress ?? ((msg, fraction) => this.events.emit('tool:progress', { tool: name, msg, fraction })),
    };
    this.events.emit('tool:before', { name, args, caller: ctx.caller });
    const t0 = performance.now();
    try {
      const result = await tool.run(args ?? {}, ctx);
      this.events.emit('tool:after', { name, args, caller: ctx.caller, ms: performance.now() - t0, result });
      return result;
    } catch (e) {
      this.events.emit('tool:error', { name, args, caller: ctx.caller, error: String((e as Error)?.message ?? e) });
      throw e;
    }
  }

  async saveSettings(): Promise<void> {
    await this.host.writeText(this.host.paths.settings, JSON.stringify(this.settings, null, 2));
    this.events.emit('settings:changed', this.settings);
  }

  /** Register + activate a mod from code (an agent can do this over the bridge with `mods.eval`). */
  async addMod(id: string, mod: StudioMod, kind: ModInfo['kind'] = 'inline', path?: string): Promise<ModInfo> {
    this.mods.get(id)?.dispose?.();
    const info: ModInfo = { id, kind, path, enabled: true, description: mod.description };
    const disposers: (() => void)[] = [];
    try {
      // Track every registration so disabling the mod removes exactly what it added.
      const un = this.events.on('*', ({ name, payload }) => {
        if (/^(tools|views|commands):changed$/.test(name) && payload?.item?.source === id) {
          const reg = name.startsWith('tools') ? this.tools : name.startsWith('views') ? this.views : this.commands;
          disposers.push(() => { if (reg.get(payload.key)?.source === id) reg.remove(payload.key); });
        }
      });
      let cleanup: unknown;
      try {
        cleanup = await withSourceAsync(id, () => mod.activate(this));
      } finally { un(); }
      info.dispose = () => {
        if (typeof cleanup === 'function') try { (cleanup as () => void)(); } catch (e) { console.error(e); }
        disposers.reverse().forEach((d) => d());
      };
    } catch (e) {
      info.enabled = false;
      info.error = String((e as Error)?.stack ?? e);
      console.error(`[mod ${id}]`, e);
    }
    this.mods.set(id, info);
    this.events.emit('mods:changed', info);
    return info;
  }

  removeMod(id: string): void {
    const info = this.mods.get(id);
    info?.dispose?.();
    if (info) { info.enabled = false; this.events.emit('mods:changed', info); }
  }

  toast(msg: string, kind: 'info' | 'error' = 'info'): void { this.events.emit('toast', { msg, kind }); }
}

async function withSourceAsync<T>(source: string, fn: () => T | Promise<T>): Promise<T> {
  // Mods activate one at a time (the loader awaits each), so everything registered until activate()
  // settles — including after awaits — is attributed to this mod. Late registrations (from a timer
  // or an event long after activation) should pass `source` to registry.add explicitly.
  const prev = activating;
  activating = source;
  try { return await fn(); } finally { activating = prev; }
}

/** What a mod module exports (default export or named `activate`). */
export interface StudioMod {
  description?: string;
  /** Return a cleanup to run when the mod is disabled/reloaded. */
  activate: (studio: Studio) => unknown;
}
