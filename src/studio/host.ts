// Host = what the native shell provides. Two implementations:
//  - Tauri: real files under ~/.glslop-studio, the agent bridge, backend switching.
//  - Browser (plain `npm run dev` in Chrome): localStorage-backed fake fs, no bridge. Handy for UI work
//    and for A/B'ing the browser's own default backend against the desktop one.

export interface BootInfo {
  angleBackend: string;
  browserArgs: string;
  gpuCacheDisabled: boolean;
  platform: string;
  bridgeUrl: string | null;
  paths: { config: string; mods: string; workspace: string; cache: string; settings: string; bridgeFile: string; appResources: string };
}

export interface DirEntry { name: string; path: string; dir: boolean; size: number; modified_ms: number }

export interface Host {
  kind: 'tauri' | 'browser';
  boot: BootInfo;
  paths: BootInfo['paths'];
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  writeBase64(path: string, base64OrDataUrl: string): Promise<void>;
  /** Binary write, no base64 round trip (thumbnails, video exports). */
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  list(path: string): Promise<DirEntry[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** URL the webview can load a file from: area is 'mods' | 'cache' | 'workspace', rel is relative to it.
   *  Mods are ES modules (relative imports work); cache files are served immutable. */
  fileUrl(area: 'mods' | 'cache' | 'workspace', relPath: string): string;
  /** @deprecated use fileUrl('mods', rel) */
  modUrl(relPath: string): string;
  /** Open a file/folder/URL with the OS. */
  open(target: string): Promise<void>;
  relaunch(): Promise<void>;
  /** Raw Tauri invoke for mods that add their own Rust commands in a fork, or call plugins. */
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen?: (event: string, fn: (payload: any) => void) => Promise<() => void>;
}

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export let host: Host = null as unknown as Host;

export async function initHost(): Promise<Host> {
  host = isTauri ? await tauriHost() : browserHost();
  return host;
}

async function tauriHost(): Promise<Host> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const boot = (await invoke('boot_info')) as BootInfo;
  const win = navigator.userAgent.includes('Windows');
  const fileUrl = (area: string, rel: string) => (win ? 'http://studio.localhost/' : 'studio://localhost/') + area + '/' + rel.split(/[\\/]/).map(encodeURIComponent).join('/');
  return {
    kind: 'tauri', boot, paths: boot.paths,
    readText: (path) => invoke('fs_read_text', { path }) as Promise<string>,
    writeText: (path, contents) => invoke('fs_write_text', { path, contents }) as Promise<void>,
    writeBase64: (path, data) => invoke('fs_write_base64', { path, data }) as Promise<void>,
    list: (path) => invoke('fs_list', { path }) as Promise<DirEntry[]>,
    mkdir: (path) => invoke('fs_mkdir', { path }) as Promise<void>,
    remove: (path) => invoke('fs_remove', { path }) as Promise<void>,
    exists: (path) => invoke('fs_exists', { path }) as Promise<boolean>,
    writeBytes: (path, bytes) => invoke('fs_write_bytes', bytes, { headers: { 'x-path': encodeURIComponent(path) } }) as Promise<void>,
    fileUrl: fileUrl as Host['fileUrl'],
    modUrl: (rel) => fileUrl('mods', rel),
    open: async (target) => {
      const { openPath, openUrl } = await import('@tauri-apps/plugin-opener').catch(() => ({} as any));
      if (/^https?:/.test(target)) await (openUrl ?? window.open)(target);
      else await openPath?.(target);
    },
    relaunch: () => invoke('relaunch') as Promise<void>,
    invoke: (cmd, args) => invoke(cmd, args),
    listen: async (event, fn) => listen(event, (e) => fn(e.payload)),
  };
}

function browserHost(): Host {
  const P = 'glslop-studio-fs:';
  const root = '/studio';
  const paths = {
    config: root, mods: `${root}/mods`, workspace: `${root}/workspace`, cache: `${root}/cache`,
    settings: `${root}/settings.json`, bridgeFile: `${root}/bridge.json`, appResources: '/',
  };
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  return {
    kind: 'browser',
    boot: { angleBackend: 'browser-default', browserArgs: '', gpuCacheDisabled: false, platform: navigator.platform, bridgeUrl: null, paths },
    paths,
    async readText(p) { const v = localStorage.getItem(P + norm(p)); if (v === null) throw new Error(`${p}: not found`); return v; },
    async writeText(p, t) { try { localStorage.setItem(P + norm(p), t); } catch { /* quota: browser mode is best-effort */ } },
    async writeBase64() { /* no-op in browser mode */ },
    async writeBytes() { /* no-op in browser mode */ },
    async list(dir) {
      const d = norm(dir) + '/';
      const names = new Map<string, boolean>();
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        if (!k.startsWith(P + d)) continue;
        const rest = k.slice((P + d).length);
        const [first, ...more] = rest.split('/');
        names.set(first, more.length > 0 || names.get(first) === true);
      }
      return [...names].map(([name, isDir]) => ({ name, path: d + name, dir: isDir, size: 0, modified_ms: 0 }));
    },
    async mkdir() {},
    async remove(p) { const k = P + norm(p); for (const key of Object.keys(localStorage)) if (key === k || key.startsWith(k + '/')) localStorage.removeItem(key); },
    async exists(p) { return localStorage.getItem(P + norm(p)) !== null; },
    fileUrl: (area, rel) => `/${area}/${rel}`,
    modUrl: (rel) => `/mods/${rel}`,
    async open(t) { window.open(t, '_blank'); },
    async relaunch() { location.reload(); },
  };
}

export function joinPath(...parts: string[]): string {
  const sep = parts[0]?.includes('\\') ? '\\' : '/';
  return parts.filter(Boolean).map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep);
}
