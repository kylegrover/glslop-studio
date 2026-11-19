// Core mod: the glslop corpus, synced cheaply and cached forever.
//
// Server-load contract (keep it this way — glslop.com is a small server):
//  - A shader's ISF never changes after posting (PATCH can only touch title/tags), so source is fetched
//    ONCE per id and kept on disk. Metadata (title, tags, stats) refreshes from the slim list.
//  - First run: slim list (3 small pages) + ONE /api/v1/export page for all the source (~1.1 MB brotli).
//    Later runs: the slim list + one GET per genuinely new shader. Nothing else, no polling.
//  - Syncs are throttled (settings.syncIntervalMin, default 15) unless forced from the UI or a tool.
//
// Visibility mirrors glslop.com browse: the public list is authoritative. Listed = in /api/v1/shaders
// (which already excludes superseded versions). Superseded versions stay cached, unlisted, for lineage
// links. Anything else that vanished upstream (moderated away) is deleted locally, thumbnails included.
import type { Studio, StudioMod } from '../studio/api';
import { joinPath } from '../studio/host';

export interface CorpusShader {
  id: string;
  title: string;
  author_name?: string;
  tags: string[];
  parents: string[];
  created_at: string;
  poster_url?: string;
  provenance_type?: string;
  made_with?: string;
  license?: string;
  stats?: { slops: number; views: number; forks: number };
  supersedes?: string;
  superseded_by?: string;
  generator?: { model?: string; provider?: string; prompt?: string; params?: unknown };
  isf: string;
  /** studio: true when glslop.com's public list shows it (what browse shows). */
  listed: boolean;
  /** studio: reference compile time (D3D11/FXC, RTX 3090) when known. */
  ref_compile_ms?: number;
  /** studio: compile time measured here, keyed by backend. */
  local?: Record<string, { compile_ms: number; ok: boolean; at: string; error?: string }>;
}

export interface Corpus { version: 2; base: string; syncedAt: string | null; shaders: CorpusShader[] }

const PAGE = 100; // /api/v1/shaders caps at 100
const EXPORT_PAGE = 500; // /api/v1/export caps at 500
const PER_ID_MAX = 25; // more missing than this -> one export page beats N requests

const mod: StudioMod = {
  description: 'glslop corpus: cheap incremental sync, local cache, search.',
  activate(studio: Studio) {
    const base = () => ((studio.settings.glslopBase as string) || 'https://glslop.com').replace(/\/+$/, '');
    const file = () => joinPath(studio.host.paths.cache, 'corpus.json');
    studio.state.corpus = null as Corpus | null;
    let byId = new Map<string, CorpusShader>();
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let syncing: Promise<unknown> | null = null;

    const index = () => { byId = new Map((studio.state.corpus?.shaders ?? []).map((s: CorpusShader) => [s.id, s])); };
    const save = async () => { if (studio.state.corpus) await studio.host.writeText(file(), JSON.stringify(studio.state.corpus)); };
    // Bench writes measurements one by one; coalesce disk writes.
    const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 1500); };
    studio.state.saveCorpus = save;
    studio.state.saveCorpusSoon = saveSoon;
    studio.state.shader = (id: string) => byId.get(id);

    // Children, forks and texture edges are derived locally — no lineage API calls.
    studio.state.lineage = (id: string) => {
      const all: CorpusShader[] = studio.state.corpus?.shaders ?? [];
      const s = byId.get(id);
      const sources = s ? textureSources(s.isf) : [];
      return {
        parents: (s?.parents ?? []).map((p) => byId.get(p)).filter(Boolean),
        children: all.filter((c) => c.parents?.includes(id)),
        replaces: s?.supersedes ? byId.get(s.supersedes) ?? null : null,
        newer: s?.superseded_by ? byId.get(s.superseded_by) ?? null : null,
        textureSources: sources.map((t) => byId.get(t) ?? { id: t, title: t }),
        textureUsers: all.filter((c) => c.id !== id && textureSources(c.isf).includes(id)),
      };
    };

    async function getJson(path: string) {
      const r = await fetch(base() + path);
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    }

    async function sync(force: boolean, progress: (m: string) => void) {
      const c: Corpus = studio.state.corpus ?? { version: 2, base: base(), syncedAt: null, shaders: [] };
      const intervalMs = (studio.settings.syncIntervalMin ?? 15) * 60_000;
      if (!force && c.base === base() && c.syncedAt && Date.now() - Date.parse(c.syncedAt) < intervalMs) {
        return { skipped: true, reason: `synced ${Math.round((Date.now() - Date.parse(c.syncedAt)) / 60000)} min ago`, count: c.shaders.length };
      }
      if (c.base !== base()) { c.shaders = []; c.base = base(); }
      const known = new Map(c.shaders.map((s) => [s.id, s]));
      let requests = 0;

      // 1. The authoritative, slim, listed set.
      const listed: any[] = [];
      for (let offset = 0; ; offset += PAGE) {
        progress(`listing shaders… ${listed.length}`);
        const j = await getJson(`/api/v1/shaders?limit=${PAGE}&offset=${offset}`); requests++;
        listed.push(...(j.shaders ?? []));
        if ((j.shaders ?? []).length < PAGE) break;
      }

      // 2. Source for anything we have never seen. Source is immutable per id.
      const missing = listed.filter((s) => !known.get(s.id)?.isf).map((s) => s.id);
      const fetched = new Map<string, any>();
      if (missing.length > PER_ID_MAX) {
        for (let offset = 0; ; offset += EXPORT_PAGE) {
          progress(`downloading source (bulk)…`);
          const j = await getJson(`/api/v1/export?limit=${EXPORT_PAGE}&offset=${offset}`); requests++;
          for (const s of j.shaders ?? []) fetched.set(s.id, s);
          if (!j.next) break;
        }
      } else {
        let done = 0;
        await pool(missing, 4, async (id) => {
          const j = await getJson(`/api/v1/shaders/${id}`); requests++;
          if (j.shader) fetched.set(id, j.shader);
          progress(`downloading source ${++done}/${missing.length}`);
        });
      }
      const ref = (await studio.call('corpus.referenceTimes').catch(() => ({}))) as Record<string, number>;
      const upsert = (row: any, isListed: boolean) => {
        const prev = known.get(row.id);
        const isf = row.isf ?? prev?.isf ?? fetched.get(row.id)?.isf;
        if (!isf) return;
        const next: CorpusShader = {
          ...(prev ?? {}), ...stripApi(fetched.get(row.id) ?? {}), ...stripApi(row),
          isf, listed: isListed, local: prev?.local,
          ref_compile_ms: ref[row.id] ?? prev?.ref_compile_ms,
        } as CorpusShader;
        known.set(row.id, next);
      };
      const listedIds = new Set(listed.map((s) => s.id));
      for (const row of listed) upsert(row, true);
      // Bulk export also carries superseded versions; keep them for lineage, unlisted.
      for (const row of fetched.values()) if (!listedIds.has(row.id)) upsert(row, false);

      // 3. Keep listed shaders and their supersede chains; drop what was moderated away upstream.
      const keep = new Set(listedIds);
      for (const id of listedIds) {
        let cur = known.get(id);
        while (cur?.supersedes && !keep.has(cur.supersedes)) {
          const prevId = cur.supersedes;
          keep.add(prevId);
          const prev = known.get(prevId);
          if (prev) { prev.superseded_by = cur.id; prev.listed = false; }
          cur = prev;
        }
      }
      const removed = [...known.keys()].filter((id) => !keep.has(id));
      for (const id of removed) known.delete(id);
      for (const s of known.values()) if (listedIds.has(s.id)) delete s.superseded_by;

      c.shaders = [...known.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
      c.syncedAt = new Date().toISOString();
      studio.state.corpus = c;
      index();
      await save();
      studio.events.emit('corpus:changed', c);
      if (removed.length) studio.events.emit('corpus:removed', removed);
      return { count: c.shaders.length, listed: listedIds.size, new: missing.length, removed: removed.length, requests, base: c.base };
    }

    studio.tools.add({
      name: 'corpus.sync',
      description: 'Sync the local corpus with glslop.com: slim list + source only for new shaders. Throttled unless force:true.',
      input: { type: 'object', properties: { force: { type: 'boolean' } } },
      async run(args: { force?: boolean }, ctx) {
        if (syncing) return syncing;
        syncing = sync(!!args.force, (m) => ctx.progress(m)).finally(() => { syncing = null; });
        return syncing;
      },
    });
    // Back-compat name from v0.1.
    studio.tools.add({ name: 'corpus.fetch', description: 'Alias of corpus.sync {force:true}.', hidden: true, run: (_a, ctx) => studio.call('corpus.sync', { force: true }, ctx) });

    studio.tools.add({
      name: 'corpus.referenceTimes',
      description: 'Reference compile times in ms (D3D11/FXC through ANGLE on an RTX 3090) keyed by shader id.',
      hidden: true,
      async run() {
        const r = await fetch('/reference-compile-ms.d3d11-rtx3090.json');
        return r.ok ? r.json() : {};
      },
    });

    studio.tools.add({
      name: 'corpus.search',
      description: 'Search the cached corpus (listed shaders only unless all:true). Returns slim rows (no source). Sort: new|slop|seen|random|title|slowest|fastest|speedup.',
      input: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'substring over title, tags, author, id' },
          tag: { type: 'string' }, author: { type: 'string' },
          sort: { type: 'string', enum: ['new', 'slop', 'seen', 'random', 'title', 'slowest', 'fastest', 'speedup'] },
          seed: { type: 'string' }, limit: { type: 'number' }, all: { type: 'boolean' },
        },
      },
      run(args: { q?: string; tag?: string; author?: string; sort?: string; seed?: string; limit?: number; all?: boolean }) {
        const all: CorpusShader[] = studio.state.corpus?.shaders ?? [];
        const q = (args.q ?? '').toLowerCase();
        const backend = studio.host.boot.angleBackend;
        let rows = all.filter((s) => (args.all || s.listed)
          && (!q || [s.id, s.title, s.author_name, ...(s.tags ?? [])].join(' ').toLowerCase().includes(q))
          && (!args.tag || s.tags?.includes(args.tag))
          && (!args.author || s.author_name === args.author));
        const localMs = (s: CorpusShader) => s.local?.[backend]?.compile_ms;
        const newest = (a: CorpusShader, b: CorpusShader) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id);
        const seed = args.seed ?? 'studio';
        const sorts: Record<string, (a: CorpusShader, b: CorpusShader) => number> = {
          new: newest,
          slop: (a, b) => (b.stats?.slops ?? 0) - (a.stats?.slops ?? 0) || newest(a, b),
          seen: (a, b) => (b.stats?.views ?? 0) - (a.stats?.views ?? 0) || newest(a, b),
          random: (a, b) => hash(a.id + seed) - hash(b.id + seed),
          title: (a, b) => a.title.localeCompare(b.title),
          slowest: (a, b) => (b.ref_compile_ms ?? -1) - (a.ref_compile_ms ?? -1),
          fastest: (a, b) => (a.ref_compile_ms ?? 1e9) - (b.ref_compile_ms ?? 1e9),
          speedup: (a, b) => ((b.ref_compile_ms ?? 0) / (localMs(b) ?? 1e9)) - ((a.ref_compile_ms ?? 0) / (localMs(a) ?? 1e9)),
        };
        rows = rows.slice().sort(sorts[args.sort ?? 'new'] ?? newest);
        return rows.slice(0, args.limit ?? 5000).map(({ isf, ...rest }) => ({ ...rest, bytes: isf.length }));
      },
    });

    studio.tools.add({
      name: 'corpus.get',
      description: 'One shader from the cached corpus, including its ISF source and locally derived lineage.',
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run(args: { id: string }) {
        const s = byId.get(args.id);
        if (!s) throw new Error(`no shader ${args.id} in the cached corpus (corpus.sync?)`);
        return s;
      },
    });

    studio.tools.add({
      name: 'corpus.lineage',
      description: 'Parents, forks, version chain and texture edges for a shader, derived from the local corpus.',
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run(args: { id: string }) {
        const l = studio.state.lineage(args.id);
        const slim = (s: any) => s && { id: s.id, title: s.title };
        return { parents: l.parents.map(slim), children: l.children.map(slim), replaces: slim(l.replaces), newer: slim(l.newer), textureSources: l.textureSources.map(slim), textureUsers: l.textureUsers.map(slim) };
      },
    });

    // Load the disk cache (instant), then sync in the background if it's stale.
    return (async () => {
      try {
        const c = JSON.parse(await studio.host.readText(file()));
        if (c.version === 2) { studio.state.corpus = c; index(); studio.events.emit('corpus:changed', c); }
      } catch { /* first run */ }
      if (studio.settings.autoSync !== false) {
        studio.call('corpus.sync', {}, { caller: 'ui' }).catch((e) => studio.toast(`corpus sync failed: ${e.message}`, 'error'));
      }
    })();
  },
};
export default mod;

function stripApi(row: any) {
  const { self, author, author_url, status, compile_ok, render_hash, made_with_app, ...rest } = row ?? {};
  return rest;
}

/** Shader ids whose posters this ISF samples (image INPUTS with SOURCE). */
export function textureSources(isf: string): string[] {
  const m = isf.match(/^\s*\/\*\s*(\{[\s\S]*?\})\s*\*\//);
  if (!m || !/"SOURCE"/.test(m[1])) return [];
  try {
    const h = JSON.parse(m[1]);
    return (h.INPUTS ?? []).filter((i: any) => i.TYPE === 'image' && typeof i.SOURCE === 'string').map((i: any) => i.SOURCE);
  } catch { return []; }
}

function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

async function pool<T>(items: T[], n: number, work: (t: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}
