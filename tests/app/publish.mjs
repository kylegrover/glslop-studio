// The real publish flow, end to end, against a LOCAL glslop dev server and a throwaway dev account.
// Never points at glslop.com and never touches the real app's sign-in.
//
//   1. in the glslop repo, a dev server with dev sign-in on a test database:
//        PGLITE_DIR=.data/pg-oauth-test DEV_AUTH=1 PUBLIC_SITE_URL=http://127.0.0.1:4399 \
//          npx astro dev --host 127.0.0.1 --port 4399
//   2. npx tauri build --no-bundle   (here)
//   3. npm run test:publish          [-- http://127.0.0.1:4399]
//
// Signs a hidden, isolated copy in through the real OAuth flow (consent posted over HTTP as a dev
// user), then publishes through the real confirmation window, driven over a debug port. Windows only:
// the debug port is a WebView2 feature.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32') { console.log('skipped: the publish window test needs WebView2 (Windows)'); process.exit(0); }
const SERVER = (process.argv[2] ?? 'http://127.0.0.1:4399').replace(/\/+$/, '');
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SERVER)) { console.error('refusing: only a local dev server'); process.exit(2); }
const exe = resolve('src-tauri/target/release/glslop-studio.exe');
if (!existsSync(exe)) { console.error('build first: npx tauri build --no-bundle'); process.exit(2); }
const DEBUG_PORT = 9341;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + String(detail).slice(0, 180) : ''}`); };

const health = await fetch(`${SERVER}/healthz`).then((r) => r.ok, () => false);
if (!health) { console.error(`no dev server at ${SERVER} (see the header of this file)`); process.exit(2); }

// --- a cookie jar of one, for the dev user's browser session
let cookie = '';
async function web(path, init = {}) {
  const r = await fetch(SERVER + path, { redirect: 'manual', ...init, headers: { ...(init.headers ?? {}), cookie, origin: SERVER } });
  const set = r.headers.getSetCookie?.() ?? [];
  for (const c of set) { const kv = c.split(';')[0]; const name = kv.split('=')[0]; cookie = [...cookie.split('; ').filter((x) => x && !x.startsWith(name + '=')), kv].join('; '); }
  return r;
}
const HANDLE = `studiotest${Date.now().toString(36).slice(-5)}`;
let r = await web('/login?next=/', { method: 'POST', body: new URLSearchParams({ handle: HANDLE }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
check('dev user signed in to the local server', r.status === 302 && cookie.includes('='), `${r.status} ${HANDLE}`);
// The dev user's shaders, from their profile page (the public list API delays new shaders on purpose).
const countMine = async () => {
  const html = await fetch(`${SERVER}/u/${HANDLE}`).then((x) => x.text()).catch(() => '');
  return new Set(html.match(/\/shader\/[a-z0-9]{8}/g) ?? []).size;
};

// --- the isolated app copy, pointed at the local server
const HOME = mkdtempSync(join(tmpdir(), 'glslop-studio-publish-'));
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ autoSync: false, autoUpdate: false, dailyCount: false, browserProbe: false, glslopBase: SERVER }));
const app = spawn(exe, [], {
  env: { ...process.env, GLSLOP_STUDIO_HOME: HOME, GLSLOP_STUDIO_HIDDEN: '1', GLSLOP_STUDIO_NO_BROWSER: '1', GLSLOP_STUDIO_PUBLISH_DEBUG_PORT: String(DEBUG_PORT) },
  stdio: 'ignore',
});
const bridge = () => JSON.parse(readFileSync(join(HOME, 'bridge.json'), 'utf8'));
async function call(tool, args = {}, ms = 180_000) {
  const { url, token } = bridge();
  const x = await fetch(`${url}/tools/${encodeURIComponent(tool)}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(ms),
  });
  return x.json();
}
const ev = async (code) => { const j = await call('mods.eval', { code }); if (j.error) throw new Error(j.error); return j.result; };

// --- drive the confirmation window over the DevTools protocol
async function publishWindow() {
  const targets = await until(async () => {
    const t = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`).then((x) => x.json()).catch(() => null);
    return t?.find((p) => p.type === 'page' && /publish\.html/.test(p.url)) ?? null;
  }, 20_000);
  if (!targets) return null;
  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  // The first evaluate can land while the page is still loading (its context is replaced); retry.
  const evalIn = async (expression) => {
    for (let i = 0; i < 20; i++) {
      const d = await evalOnce(expression);
      if (!d.error && !d.result?.exceptionDetails && d.result?.result?.value !== undefined) return d.result.result.value;
      await sleep(200);
    }
    return undefined;
  };
  const evalOnce = (expression) => new Promise((ok) => { const n = ++id; pending.set(n, ok); ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  return { evalIn, close: () => ws.close() };
}
const clickWhenReady = (w, label) => w.evalIn(`(async () => {
  for (let i = 0; i < 100; i++) {
    const b = [...document.querySelectorAll('footer button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (b && !b.disabled) { b.click(); return true; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})()`);

const SHADER = '/*{ "INPUTS": [] }*/\nvoid main(){ gl_FragColor = vec4(isf_FragNormCoord, 0.3, 1.0); }\n';
try {
  if (!(await until(() => existsSync(join(HOME, 'bridge.json')), 60_000))) throw new Error('the app never wrote bridge.json');

  // --- sign in through the real OAuth flow: the app waits on its loopback port; we play the browser
  const signIn = call('account.signIn', {}, 120_000);
  const authUrl = await until(() => ev('return studio.state.authUrl ?? null'), 15_000);
  check('the app produced a sign-in URL for the local server', authUrl?.startsWith(`${SERVER}/oauth/authorize?`), authUrl);
  const u = new URL(authUrl);
  r = await web(u.pathname + u.search);
  check('the consent page is shown to the signed-in dev user', r.status === 200, r.status);
  const form = Object.fromEntries(u.searchParams);
  r = await web('/oauth/authorize', { method: 'POST', body: new URLSearchParams({ ...form, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const back = r.headers.get('location');
  check('allowing redirects to the app\'s loopback port', r.status === 302 && /^http:\/\/127\.0\.0\.1:\d+\//.test(back ?? ''), `${r.status} ${back}`);
  await fetch(back).catch(() => null);
  const s = await signIn;
  check(`the app is signed in as the dev user`, s.result?.handle === HANDLE, JSON.stringify(s));
  const startCount = await countMine();

  // --- 1. cancel sends nothing
  let pub = call('publish', { isf: SHADER, title: 'studio publish test (cancel)' });
  let w = await publishWindow();
  check('the confirmation window opens', !!w);
  const shown = await w?.evalIn(`(async () => { for (let i = 0; i < 100; i++) { const h = document.querySelector('h1'); if (h) return h.textContent; await new Promise((r) => setTimeout(r, 100)); } return null; })()`);
  check('it shows the title being sent', shown === 'studio publish test (cancel)', shown);
  await clickWhenReady(w, 'not yet'); w?.close();
  let res = await pub;
  check('"not yet" cancels', res.result?.published === false && /cancel/.test(res.result?.reason ?? ''), JSON.stringify(res));
  check('...and nothing reached the server', (await countMine()) === startCount);

  // --- 2. closing the window = cancel
  pub = call('publish', { isf: SHADER, title: 'studio publish test (close)' });
  w = await publishWindow();
  await w?.evalIn(`(async () => { for (let i = 0; i < 100; i++) { if (document.querySelector('h1')) return 1; await new Promise((r) => setTimeout(r, 100)); } })()`);
  w?.close();
  // A native close, as the X button sends (a page can't close its own Tauri window).
  const closed = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('tests/app/close-window.ps1'), '-ProcessId', String(app.pid), '-Title', 'Publish to glslop'], { encoding: 'utf8' });
  check('sent a native close to the window', closed.stdout.trim() === '1', closed.stdout.trim() || closed.stderr);
  res = await Promise.race([pub, sleep(20_000).then(() => ({ error: 'still waiting 20 s after the window closed' }))]);
  check('closing the window cancels', res.result?.published === false, JSON.stringify(res));
  check('...and nothing reached the server', (await countMine()) === startCount);

  // --- 3. approve sends exactly one
  pub = call('publish', { isf: SHADER, title: 'studio publish test (approve)', tags: ['test'] });
  w = await publishWindow();
  const clicked = await clickWhenReady(w, 'publish');
  // a second click (double-click) must not send twice
  await w?.evalIn(`document.querySelector('footer .go')?.click(); true`).catch(() => null);
  w?.close();
  res = await pub;
  check('"publish" publishes', clicked && res.result?.published === true && /\/shader\//.test(res.result?.url ?? ''), JSON.stringify(res));
  await sleep(500);
  check('...exactly once', (await countMine()) === startCount + 1, `${await countMine()} vs ${startCount + 1}`);
} catch (e) {
  check('the run finished', false, e?.stack ?? e);
} finally {
  spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(500);
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* temp dir */ }
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed  (dev user @${HANDLE} on ${SERVER})`);
process.exit(results.every(Boolean) ? 0 : 1);
