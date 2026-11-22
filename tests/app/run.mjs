// Integration checks against a real, hidden copy of the app, driven over its agent bridge.
//
//   npx tauri build --no-bundle
//   npm run test:app             [-- path/to/glslop-studio.exe]
//
// Each run gets a fresh home folder (GLSLOP_STUDIO_HOME) with its own settings and its own keychain
// entry, so it never sees or touches the real app's files or glslop sign-in. GLSLOP_STUDIO_HIDDEN=1
// keeps the window off screen. The only network call is the update check (no account involved).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const win = process.platform === 'win32';
const exe = resolve(process.argv[2] ?? `src-tauri/target/release/glslop-studio${win ? '.exe' : ''}`);
if (!existsSync(exe)) { console.error(`no app binary at ${exe}; build it first (npx tauri build --no-bundle)`); process.exit(2); }

const HOME = mkdtempSync(join(tmpdir(), 'glslop-studio-test-'));
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ autoSync: false, autoUpdate: false, dailyCount: false, browserProbe: win }));
const app = spawn(exe, [], { env: { ...process.env, GLSLOP_STUDIO_HOME: HOME, GLSLOP_STUDIO_HIDDEN: '1' }, stdio: 'ignore' });
const stop = () => {
  if (win) spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  else app.kill('SIGKILL');
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bridge = () => JSON.parse(readFileSync(join(HOME, 'bridge.json'), 'utf8'));
async function call(tool, args = {}) {
  const { url, token } = bridge();
  const r = await fetch(`${url}/tools/${encodeURIComponent(tool)}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(180_000),
  });
  return r.json();
}
const ev = async (code) => { const j = await call('mods.eval', { code }); if (j.error) throw new Error(j.error); return j.result; };
const tryInvoke = (cmd, args = {}) => ev(`try { return { ok: true, value: await studio.host.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}) } } catch (e) { return { ok: false, error: String(e) } }`);
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };

const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + String(detail).slice(0, 160) : ''}`); };
const section = (s) => console.log(`\n# ${s}`);

const V1 = '/*{ "INPUTS": [] }*/\nvoid main(){ gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }\n';
const V2 = '/*{ "INPUTS": [] }*/\nvoid main(){ gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0); }\n';
const V3 = '/*{ "INPUTS": [] }*/\nvoid main(){ gl_FragColor = vec4(0.0, 0.0, 1.0, 1.0); }\n';
const BROKEN = '/*{ "INPUTS": [] }*/\nvoid main(){ gl_FragColor = vec4(nope); }\n';
const typeInEditor = (suffix) => ev(`const ta = document.querySelector('.pane-editor textarea'); ta.value = ta.value + ${JSON.stringify(suffix)}; ta.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 50)); return ta.value.length;`);
const source = async () => (await call('viewer.getSource')).result?.isf;
const autosaves = () => { const d = join(HOME, 'workspace', 'autosave'); return existsSync(d) ? readdirSync(d) : []; };
const banner = () => ev(`return document.querySelector('.recover')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null`);

try {
  if (!(await until(() => existsSync(join(HOME, 'bridge.json')), 60_000))) throw new Error('the app never wrote bridge.json');
  const list = await (await fetch(bridge().url + '/tools', { headers: { authorization: `Bearer ${bridge().token}` } })).json();
  console.log(`studio ${list.studio}, ${list.tools.length} tools, home ${HOME}`);

  // ------------------------------------------------------------------------------------------------
  section('opening documents');
  let r = (await call('viewer.open', { isf: V1, title: 'guardtest' })).result;
  check('viewer.open reports the newly loaded shader', r?.loaded === true && r?.title === 'guardtest.fs', JSON.stringify(r));
  let st = (await call('viewer.state')).result;
  check('fresh editor: not dirty, nothing to undo', st.dirty === false && st.undoDepth === 0, JSON.stringify(st));
  r = await call('viewer.open', { path: join(HOME, 'does-not-exist.fs') });
  check('opening a missing file is an error, not a stale success', /no such file/.test(r.error ?? ''), r.error ?? JSON.stringify(r));
  st = (await call('viewer.state')).result;
  check('...and the editor that was showing is still there', st.title === 'guardtest.fs', st.title);
  r = await call('viewer.open', { id: 'zzzzzzzz' });
  check('opening an unknown shader id is an error', /no shader with id/.test(r.error ?? ''), r.error ?? JSON.stringify(r));
  await call('ui.openView', { id: 'settings' });
  await sleep(300);
  st = (await call('viewer.state')).result;
  check('a closed editor no longer answers viewer calls', st.open === false && (await source()) === null, JSON.stringify(st));
  const backBtn = await ev(`return !!document.querySelector('nav.main button[title^="back"]')`);
  check('after moving between views, the header shows the ← back button', backBtn === true);

  // ------------------------------------------------------------------------------------------------
  await call('viewer.open', { isf: V1, title: 'guardtest' });
  r = await call('viewer.setSource', { source: V2 });
  check('wrong arguments get a plain error naming what the tool takes', /isf is required.*it takes: isf/.test(r.error ?? ''), r.error ?? JSON.stringify(r));
  st = (await call('viewer.state')).result;
  check('...and leave the editor working', st.title === 'guardtest.fs' && typeof st.sourceBytes === 'number', JSON.stringify(st));

  section('agent edits next to a human');
  await call('viewer.open', { isf: V1, title: 'guardtest' });
  r = await call('viewer.setSource', { isf: V2 });
  check('setSource with no human edits succeeds', r.result?.ok === true, JSON.stringify(r));
  check('one undo step recorded', (await call('viewer.state')).result.undoDepth === 1);
  await typeInEditor('\n// the human is typing');
  check('typing makes the editor dirty', (await call('viewer.state')).result.dirty === true);
  r = await call('viewer.setSource', { isf: V3 });
  check('setSource is refused while the human has unapplied edits', /unapplied edits/.test(r.error ?? ''), r.error ?? JSON.stringify(r));
  check("the human's text is untouched after the refusal", (await source()).includes('// the human is typing'));
  r = await call('viewer.undo');
  check('agent undo is refused too, while the human has typed since the update', /edited since/.test(r.error ?? ''), r.error ?? JSON.stringify(r));
  check("...and the human's text survives it", (await source()).includes('// the human is typing'));
  r = await call('viewer.setSource', { isf: V3, force: true });
  check('force:true replaces it', r.result?.ok === true);
  r = (await call('viewer.undo')).result;
  check("viewer.undo then brings the human's text back", r?.undone === true && (await source()).includes('// the human is typing'), JSON.stringify(r));
  await call('viewer.setSource', { isf: V1, force: true });
  await call('viewer.setSource', { isf: V2 });
  await sleep(6500); // the "updated by agent" badge fades after 6 s
  const undoLink = await ev(`return !!document.querySelector('.undo-btn')`);
  check('the human\'s undo link outlives the 6 s "updated by agent" badge', undoLink === true && (await ev(`return !document.querySelector('.agent-badge')`)));
  await ev(`document.querySelector('.undo-btn').click(); await new Promise(r => setTimeout(r, 400)); return 1`);
  check('clicking it undoes the last update', (await source()).trimEnd() === V1.trimEnd());
  r = await call('viewer.setSource', { isf: BROKEN });
  check('a broken agent update reports errors with the right line', r.result?.ok === false && /line 2/.test(r.result.errors?.[0] ?? ''), r.result?.errors?.[0]);
  r = await call('viewer.setSource', { isf: V2 });
  check('the agent can replace its own broken update without force', r.result?.ok === true, r.error);

  // ------------------------------------------------------------------------------------------------
  section('autosave');
  await call('viewer.open', { isf: V1, title: 'savetest' });
  await ev(`window.__stage = studio.state.viewer; return 1`);
  await typeInEditor('\n// keep me');
  const saved1 = await until(() => autosaves().some((f) => f.startsWith('savetest-')), 4000);
  check('opening a shader mounts the editor once (typing right away is kept)', await ev(`return window.__stage === studio.state.viewer`));
  check('edits to a named shader are autosaved', saved1, autosaves().join(', '));
  await call('viewer.open', { isf: V1, title: 'savetest' });
  await until(async () => !!(await banner()), 5000);
  check('reopening offers to restore them', /autosaved/.test((await banner()) ?? ''), await banner());
  await ev(`document.querySelector('.recover button').click(); await new Promise(r => setTimeout(r, 400)); return 1`);
  check('"restore them" puts the edits back', (await source()).includes('// keep me'));

  // two files with the same name in different folders: separate autosaves
  const a = join(HOME, 'proj-a', 'main.fs'), b = join(HOME, 'proj-b', 'main.fs');
  for (const p of [a, b]) { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, V1); }
  await call('viewer.open', { path: a });
  await typeInEditor('\n// edits to A');
  await until(() => autosaves().filter((f) => f.startsWith('main-')).length === 1, 4000);
  await call('viewer.open', { path: b });
  await sleep(600);
  check('the other main.fs is not offered A\'s autosave', (await banner()) === null, await banner());
  await typeInEditor('\n// edits to B');
  const two = await until(() => autosaves().filter((f) => f.startsWith('main-')).length === 2, 4000);
  check('each main.fs gets its own autosave file', two, autosaves().join(', '));
  await call('viewer.open', { path: a });
  await until(async () => !!(await banner()), 5000);
  await ev(`[...document.querySelectorAll('.recover button')].find(x => x.textContent.includes('discard'))?.click(); await new Promise(r => setTimeout(r, 400)); return 1`);
  await sleep(300);
  const left = autosaves().filter((f) => f.startsWith('main-'));
  const bText = left.length === 1 ? readFileSync(join(HOME, 'workspace', 'autosave', left[0]), 'utf8') : '';
  check("discarding A's autosave leaves B's alone", left.length === 1 && bText.includes('// edits to B'), left.join(', '));

  // ------------------------------------------------------------------------------------------------
  section('updates');
  // A beta build follows betas by default; pin stable explicitly so this works on any build.
  await ev(`studio.settings.betaUpdates = false; await studio.saveSettings(); return 1`);
  r = await call('app.checkUpdate', {});
  check('update check works on the stable channel', r.result?.channel === 'stable' && typeof r.result?.available === 'boolean', JSON.stringify(r));
  await ev(`studio.settings.betaUpdates = true; await studio.saveSettings(); return 1`);
  r = await call('app.checkUpdate', {});
  check('with betaUpdates on, the check asks for the beta channel', r.result?.channel === 'beta', JSON.stringify(r));
  await ev(`studio.settings.betaUpdates = false; await studio.saveSettings(); return 1`);
  await call('ui.openView', { id: 'settings' });
  await sleep(500);
  const msg = await ev(`
    const btn = [...document.querySelectorAll('.settings button')].find(b => b.textContent.trim() === 'check for updates');
    if (!btn) return null;
    btn.click();
    for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 200)); if (!btn.disabled) break; }
    return btn.parentElement.querySelector('span')?.textContent ?? null;`);
  check('Settings: "check for updates" reports a result', /up to date|is available/.test(msg ?? ''), msg);

  // ------------------------------------------------------------------------------------------------
  section('window permissions and sign-in isolation');
  r = await tryInvoke('boot_info');
  check('main: boot_info allowed', r.ok && !!r.value?.paths, r.error);
  r = await tryInvoke('fs_exists', { path: HOME });
  check('main: file commands allowed', r.ok && r.value === true, r.error);
  r = await call('account.status');
  check('a test copy is not signed in (its own keychain entry)', r.result?.signedIn === false, JSON.stringify(r));
  for (const [cmd, args] of [['publish_view', {}], ['publish_decide', { approve: true }]]) {
    r = await tryInvoke(cmd, args);
    check(`main: ${cmd} refused by permissions`, !r.ok && /not allowed/i.test(r.error ?? ''), r.error ?? JSON.stringify(r));
  }
  r = await tryInvoke('no_such_command');
  check('main: unknown command refused', !r.ok, r.error);
  if (win) {
    const p = await call('weight.probe', { isf: '/*{ "INPUTS": [] }*/\nvoid main(){ gl_FragColor = vec4(isf_FragNormCoord, 0.5, 1.0); }\n' });
    check('probe window (events only) still measures on D3D11', p.result?.kind === 'measured' && p.result?.ok === true, JSON.stringify(p.result ?? p));
  }
  const visible = await ev(`try { return await studio.host.invoke('plugin:window|is_visible', { label: 'main' }) } catch (e) { return 'err: ' + e }`);
  check('the test window is hidden', visible === false, visible);

  // ------------------------------------------------------------------------------------------------
  section('errors (last: it adds one on purpose)');
  const before = await ev('return (studio.state.errors ?? []).map(e => e.msg)');
  check('no uncaught errors during the run', before.length === 0, JSON.stringify(before));
  await ev(`for (let i = 0; i < 5; i++) Promise.reject(new Error('boom-test')); await new Promise(r => setTimeout(r, 300)); return 1`);
  const n = await ev(`return (studio.state.errors ?? []).filter(e => e.msg.includes('boom-test')).length`);
  check('an uncaught error is recorded once, not five times', n === 1, `count ${n}`);

  // ------------------------------------------------------------------------------------------------
  section('quit (last: it ends the app)');
  const hasQuit = await ev(`return studio.commands.list().some(c => c.key === 'Ctrl+Q')`);
  if (process.platform === 'darwin') check('macOS has no Ctrl+Q command (Cmd+Q comes from the system menu)', hasQuit === false);
  else {
    check('Ctrl+Q is a command', hasQuit === true);
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', ctrlKey: true, bubbles: true })); return 1`).catch(() => null);
    const exited = await until(() => app.exitCode !== null || app.signalCode !== null, 8000);
    check('pressing it quits the app', exited, `exit ${app.exitCode}`);
    check('...and removes bridge.json', !existsSync(join(HOME, 'bridge.json')));
  }
} catch (e) {
  check('the run finished', false, e?.stack ?? e);
} finally {
  stop();
  await sleep(500);
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* webview may still hold files; temp dir */ }
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
