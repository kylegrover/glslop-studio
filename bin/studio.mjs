// Tiny bridge client: node bin/studio.mjs <tool> [json-args | @file.json | @file.js (sent as {code})]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const home = process.env.GLSLOP_STUDIO_HOME || join(homedir(), '.glslop-studio');
const { url, token } = JSON.parse(readFileSync(join(home, 'bridge.json'), 'utf8'));
const [tool = '', arg = '{}'] = process.argv.slice(2);
let body = arg;
if (arg.startsWith('@')) body = arg.endsWith('.js') ? JSON.stringify({ code: readFileSync(arg.slice(1), 'utf8') }) : readFileSync(arg.slice(1), 'utf8');
const r = await fetch(tool ? `${url}/tools/${tool}` : `${url}/tools`, { method: tool ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` }, body: tool ? body : undefined });
const j = await r.json();
console.log(JSON.stringify(j.result ?? j, null, 1));
if (!r.ok) process.exit(1);
