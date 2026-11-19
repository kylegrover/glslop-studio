#!/usr/bin/env node
// MCP (stdio) adapter for a running glslop studio. Zero dependencies.
//
// It is a thin proxy: tools/list and tools/call are forwarded to the studio's localhost bridge, so any
// tool a mod registers shows up for your agent on the next list (we send list_changed when it moves).
//
//   claude mcp add glslop-studio -- node /path/to/glslop-studio/bin/glslop-studio-mcp.mjs
//   codex / cursor / pi: register the same command as a stdio MCP server.
//
// The studio must be running; the bridge address + token are read from ~/.glslop-studio/bridge.json
// (GLSLOP_STUDIO_HOME overrides) on every call, so restarting the studio needs no reconfiguration.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const HOME = process.env.GLSLOP_STUDIO_HOME || join(homedir(), '.glslop-studio');
const bridge = () => JSON.parse(readFileSync(join(HOME, 'bridge.json'), 'utf8'));
// MCP tool names must match ^[a-zA-Z0-9_-]{1,64}$ in several clients, so "corpus.search" -> "corpus__search".
const toMcp = (n) => n.replace(/\./g, '__');
const fromMcp = (n) => n.replace(/__/g, '.');

async function studio(path, body) {
  const { url, token } = bridge();
  const r = await fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
let lastNames = '';

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'glslop-studio', version: '0.1.0' },
      instructions: 'Tools of a running glslop studio (desktop ISF shader workbench). Results are JSON; images are written to files and returned as paths — open them to look. viewer__* tools change what the human sees.',
    };
  }
  if (method === 'tools/list') {
    let j;
    try { j = await studio('/tools'); } catch (e) {
      return { tools: [{ name: 'studio_not_running', description: `glslop studio is not reachable (${e.message}). Start it, then list tools again.`, inputSchema: { type: 'object' } }] };
    }
    lastNames = j.tools.map((t) => t.name).join(',');
    return { tools: j.tools.map((t) => ({ name: toMcp(t.name), description: t.description, inputSchema: t.input ?? { type: 'object' } })) };
  }
  if (method === 'tools/call') {
    try {
      const j = await studio(`/tools/${encodeURIComponent(fromMcp(params.name))}`, params.arguments ?? {});
      if (j.error) return { content: [{ type: 'text', text: j.error }], isError: true };
      const text = typeof j.result === 'string' ? j.result : JSON.stringify(j.result, null, 1);
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `glslop studio unreachable: ${e.message}` }], isError: true };
    }
  }
  if (method === 'ping') return {};
  if (id !== undefined) throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  return undefined; // notifications
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message } });
  }
});

// Tell the client when mods add/remove tools.
setInterval(async () => {
  try {
    const names = (await studio('/tools')).tools.map((t) => t.name).join(',');
    if (lastNames && names !== lastNames) { lastNames = names; send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); }
  } catch { /* studio closed; keep waiting */ }
}, 3000).unref();
