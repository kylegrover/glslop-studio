// Webview half of the agent bridge. Rust's localhost server emits `bridge:call`; we run the tool and
// reply with `bridge_reply`. Any registered, non-hidden tool is callable — including ones a mod added
// a second ago. See docs/AGENT-API.md.
import type { Studio } from './api';

export function toolListing(studio: Studio, all = false) {
  return studio.tools.list()
    .filter((t) => all || !t.hidden)
    .map((t) => ({ name: t.name, description: t.description, input: t.input ?? { type: 'object' }, source: t.source }));
}

export async function startBridge(studio: Studio): Promise<void> {
  const { host } = studio;
  if (!host.listen || !host.invoke) return;
  await host.listen('bridge:call', async ({ id, tool, args }: { id: string; tool: string; args: any }) => {
    let reply: unknown;
    try {
      if (tool === '__list') reply = { tools: toolListing(studio, !!args?.all), studio: studio.version, backend: host.boot.angleBackend };
      else reply = { result: jsonSafe(await studio.call(tool, args, { caller: 'bridge' })) };
    } catch (e) {
      reply = { error: String((e as Error)?.message ?? e) };
    }
    await host.invoke!('bridge_reply', { id, result: reply });
  });
  // Rust holds incoming calls until this arrives, so a call made right after launch isn't lost.
  await host.invoke('bridge_ready');
}

function jsonSafe(v: unknown): unknown {
  return v === undefined ? null : JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x)));
}
