// Core mod: your glslop account, publishing, and app updates.
//
// Credentials never enter the webview. Sign-in runs in Rust (src-tauri/src/auth.rs: PKCE + loopback,
// refresh token in the OS keychain). This side gets two authenticated doors, both in Rust:
// `glslop_api` (GET only) and `glslop_publish`, which shows the native confirm dialog itself and then
// sends the request itself. So nothing here, no mod and no agent on the bridge, can publish without a
// human click. With no account, `publish` falls back to an anonymous draft plus a review link.
import type { Studio, StudioMod } from '../studio/api';
import { renderPosterFrame } from '@glslop/core/runtime';
import { loopBudget } from '@glslop/core/budget';
import { dailyCountHeaders, updateChannel, updateIntervalMs } from './updates';

const mod: StudioMod = {
  description: 'Sign in with glslop, publish shaders, check for app updates.',
  activate(studio: Studio) {
    const base = () => ((studio.settings.glslopBase as string) || 'https://glslop.com').replace(/\/+$/, '');
    const inv = studio.host.invoke;
    const tauri = studio.host.kind === 'tauri' && !!inv;
    studio.state.account = { signedIn: false, handle: null as string | null };

    const setStatus = (s: { signed_in: boolean; handle: string | null }) => {
      studio.state.account = { signedIn: s.signed_in, handle: s.handle };
      studio.events.emit('account:changed', studio.state.account);
      return studio.state.account;
    };

    studio.tools.add({
      name: 'account.status',
      description: 'Who is signed in to glslop in this studio (handle), if anyone.',
      async run() {
        if (!tauri) return { signedIn: false, handle: null, note: 'sign-in needs the desktop app' };
        return setStatus((await inv!('auth_status', { base: base() })) as any);
      },
    });
    studio.tools.add({
      name: 'account.signIn',
      description: 'Open the browser to sign in with glslop (one consent click). Resolves when done.',
      async run() {
        if (!tauri) throw new Error('sign-in needs the desktop app');
        const s = setStatus((await inv!('auth_sign_in', { base: base() })) as any);
        studio.toast(`signed in as @${s.handle}`);
        return s;
      },
    });
    studio.tools.add({
      name: 'account.signOut',
      description: 'Sign out and revoke this studio\'s grant on glslop.com.',
      async run() {
        if (tauri) await inv!('auth_sign_out', { base: base() });
        return setStatus({ signed_in: false, handle: null });
      },
    });

    /** Authenticated READ (GET /api/*) as the signed-in user; the token stays in Rust. */
    const api = async (path: string) => {
      const r = (await inv!('glslop_api', { base: base(), method: 'GET', path })) as { status: number; body: any };
      if (r.status >= 400) throw new Error(r.body?.error ?? `HTTP ${r.status}`);
      return r.body;
    };
    studio.state.glslopApi = api;

    async function poster(isf: string) {
      const { renderer } = await studio.state.gl.compileOnce(isf, { cold: false, keep: true });
      if (!renderer) throw new Error('shader does not compile here');
      try {
        await renderPosterFrame(renderer, { width: 512, height: 512, time: 0.8 });
        return { png: renderer.toDataURL(), hash: renderer.averageHash(), compileMs: Math.round(renderer.lastCompile?.compileMs ?? 0) };
      } finally { renderer.dispose(); }
    }

    studio.tools.add({
      name: 'publish',
      description: 'Publish a shader to glslop.com as the signed-in user. Always asks the human first, in a confirmation window that shows every field being sent. ' +
        'If not signed in (or draft:true), stages an anonymous draft and returns a review URL instead.',
      input: {
        type: 'object',
        properties: {
          isf: { type: 'string' }, path: { type: 'string' }, id: { type: 'string', description: 'publish the source of a corpus shader (e.g. your edited fork)' },
          title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
          parents: { type: 'array', items: { type: 'string' }, description: 'shader ids this derives from' },
          supersedes: { type: 'string', description: 'your earlier shader this replaces (new version)' },
          generator: { type: 'object', description: '{ model, provider, prompt } if an AI made it' },
          made_with: { type: 'string' }, draft: { type: 'boolean' },
        },
        required: ['title'],
      },
      async run(args: any, ctx) {
        const isf: string = await studio.state.gl.sourceOf(args);
        ctx.progress('compiling + rendering poster…');
        const p = await poster(isf);
        // What Windows Chrome visitors will pay: the measured browser gauge if we have one, else the estimate.
        const w = studio.state.weight;
        const b = w ? await w.probe(isf, 'publish').catch(() => null) : null;
        const budget = loopBudget(isf);
        const est = budget.inlined >= 4000 ? 'over 10 s' : budget.inlined >= 1000 ? 'several seconds' : budget.inlined >= 400 ? 'over 500 ms' : 'under 500 ms';
        const browserLine = b?.ms != null && b.kind === 'measured'
          ? `Opens in about ${b.ms >= 1000 ? (b.ms / 1000).toFixed(1) + ' s' : b.ms + ' ms'} in Chrome on Windows (measured). ${b.ms < 500 ? 'It autoplays on glslop.com.' : 'Over 500 ms, so on glslop.com it starts on a click.'}`
          : `Estimated to open in ${est} in Chrome on Windows.`;
        const meta = {
          title: String(args.title).slice(0, 120), tags: (args.tags ?? []).slice(0, 8), parents: args.parents, supersedes: args.supersedes,
          generator: args.generator, made_with: args.made_with ?? 'glslop studio',
        };
        const signedIn = tauri && (await studio.call('account.status')).signedIn;
        if (args.draft || !signedIn) {
          const r = await fetch(`${base()}/api/v1/drafts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isf, ...meta }) });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
          studio.host.open(j.review_url);
          return { draft: true, review_url: j.review_url, note: 'opened the review page; publish it from there' };
        }
        // Rust builds and shows the dialog (account, server and title come from its own state and this
        // exact payload), then sends the request. `note` is only the extra detail line.
        const r = (await inv!('glslop_publish', {
          base: base(),
          payload: { isf, compile_ok: true, poster: p.png, render_hash: p.hash, ...meta },
          note: browserLine,
          byAgent: ctx.caller === 'bridge',
        })) as { published: boolean; reason?: string; status?: number; body?: any };
        if (!r.published) {
          if (r.reason) return { published: false, reason: r.reason };
          throw new Error(r.body?.error ?? `HTTP ${r.status}`);
        }
        const res = r.body ?? {};
        studio.toast(`published "${meta.title}"`);
        studio.call('corpus.sync', { force: true }).catch(() => {});
        return { published: true, ...res, url: res.url ? base() + res.url : undefined };
      },
    });

    studio.tools.add({
      name: 'app.checkUpdate',
      description: 'Check for a new glslop studio release; install:true downloads, installs and restarts. Follows the stable channel unless the betaUpdates setting is on (or this copy is itself a beta).',
      input: { type: 'object', properties: { install: { type: 'boolean' } } },
      async run(args: { install?: boolean }, ctx) {
        if (!tauri) return { available: false, note: 'browser mode' };
        const { check } = await import('@tauri-apps/plugin-updater');
        const channel = updateChannel(studio.settings, studio.version);
        // The server offers stable builds unless asked; the header is how a copy asks for betas.
        // The day's first check also carries the daily usage count (version + os, nothing else).
        const dayFile = `${studio.host.paths.config}/daily-count-day`;
        const lastDay = await studio.host.readText(dayFile).then((s) => s.trim()).catch(() => null);
        const daily = dailyCountHeaders(studio.settings, lastDay, studio.version, studio.host.boot.platform);
        const u = await check({ headers: { 'x-glslop-channel': channel, ...daily.headers }, timeout: 30_000 });
        // Only after the check got an answer, so a failed check retries the count later that day.
        if (daily.day) await studio.host.writeText(dayFile, daily.day).catch(() => {});
        studio.state.updateCheckedAt = new Date().toISOString();
        if (!u) {
          studio.state.update = null;
          studio.events.emit('update:available', null);
          return { available: false, current: studio.version, channel };
        }
        const info = { available: true, current: u.currentVersion, version: u.version, notes: u.body, date: u.date, channel };
        studio.state.update = info;
        studio.events.emit('update:available', info);
        if (!args.install) return info;
        let got = 0, total = 0;
        await u.downloadAndInstall((e) => {
          if (e.event === 'Started') total = e.data.contentLength ?? 0;
          if (e.event === 'Progress') { got += e.data.chunkLength; ctx.progress(`downloading update ${total ? Math.round((got / total) * 100) + '%' : ''}`, total ? got / total : undefined); }
        });
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
        return info;
      },
    });

    studio.host.listen?.('auth:url', (url: string) => { studio.state.authUrl = url; studio.events.emit('auth:url', url); });

    // Quietly check status + updates after boot (never blocks startup, never nags twice), then look
    // for updates again every few hours: the app is often left open for days. Checking only shows the
    // update button; nothing is downloaded until the human clicks it.
    if (tauri) {
      const autoCheck = () => {
        if (studio.settings.autoUpdate !== false && !import.meta.env.DEV) studio.call('app.checkUpdate').catch(() => {});
      };
      setTimeout(() => {
        studio.call('account.status').catch(() => {});
        autoCheck();
      }, 1500);
      const timer = setInterval(autoCheck, updateIntervalMs(studio.settings));
      return () => clearInterval(timer);
    }
  },
};
export default mod;
