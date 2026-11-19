// Tiny bridge client: node bin/studio.mjs <tool> [json-args | @file.json | @file.js (sent as {code})]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const home = process.env.GLSLOP_STUDIO_HOME || join(homedir(), '.glslop-studio');
const die = (msg) => { console.error(msg); process.exit(2); };
let bridge;
try { bridge = JSON.parse(readFileSync(join(home, 'bridge.json'), 'utf8')); } catch {
  die(`glslop studio is not running (no ${join(home, 'bridge.json')}). Start it and try again.`);
}
const { url, token } = bridge;
const [tool = '', arg = '{}'] = process.argv.slice(2);
let body = arg;
if (arg.startsWith('@')) body = arg.endsWith('.js') ? JSON.stringify({ code: readFileSync(arg.slice(1), 'utf8') }) : readFileSync(arg.slice(1), 'utf8');
let r;
try {
  r = await fetch(tool ? `${url}/tools/${tool}` : `${url}/tools`, { method: tool ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` }, body: tool ? body : undefined });
} catch (e) {
  die(`glslop studio is not reachable at ${url} (${e.cause?.code ?? e.message}). Is it still running?`);
}
const j = await r.json();
console.log(JSON.stringify(j.result ?? j, null, 1));
if (!r.ok) process.exit(1);
