# Driving glslop studio from your agent

The studio does not include its own chat or model. Your agent drives it from outside, with whatever
harness you already use. There are three ways in. All three go to the same tool registry, so a tool a
mod adds shows up everywhere.

## 1. MCP (recommended for Claude Code, Codex, Cursor, pi, …)

```sh
claude mcp add glslop-studio -- node /path/to/glslop-studio/bin/glslop-studio-mcp.mjs
```

This is a zero-dependency stdio server that forwards to the running studio. Dots in tool names become
`__` (`corpus.search` → `corpus__search`). When mods change the tool list, the server sends
`notifications/tools/list_changed`.

## 2. HTTP

When the studio launches, it writes `~/.glslop-studio/bridge.json`:

```json
{ "url": "http://127.0.0.1:47615", "token": "…", "pid": 1234 }
```

```
GET  /tools                 -> { tools: [{ name, description, input, source }], backend }
POST /tools/<name>  {args}  -> { result } | { error }   (400 on error)
Authorization: Bearer <token>
```

It binds to localhost only, and the token changes every launch. Calls can take minutes (for example
`bench.corpus` on d3d11), and the timeout is 10 minutes.

**The token is full control of the studio.** Anything holding it can run code in the app (`mods.eval`),
install mods, and read and write files as you. Treat `bridge.json` like an SSH key: don't paste it into
chats or commit it. On macOS and Linux the file is readable only by you.

What the token (and any mod) cannot do:

- **Read your glslop login.** Tokens stay in the native layer and are only ever sent to the server
  you signed in to.
- **Publish without you.** The `publish` tool ends in a native dialog that the native layer shows and
  then acts on itself. There is no other write path to your account; the authenticated API door for
  mods is read-only.

## 3. CLI

```sh
node bin/studio.mjs                          # list tools
node bin/studio.mjs compile '{"id":"mtxplbl7"}'
node bin/studio.mjs mods.eval @script.js     # a .js file is sent as {code}
```

## Starter tools

| Tool | Purpose |
|---|---|
| `gpu.env` | Backend, GPU, extensions. Include it in every timing report. |
| `corpus.sync` / `corpus.search` / `corpus.get` / `corpus.lineage` | The glslop corpus, cached locally. Search covers listed shaders only, matching the site; lineage is derived locally |
| `thumbs.prefetch` / `thumbs.stats` / `thumbs.clear` | Locally rendered thumbnail cache |
| `parse` | ISF header: inputs and passes |
| `compile` | Cold compile on this GPU: ok, errors, ms, translated size (`translated:true` returns the driver's source) |
| `render` | PNG still (poster semantics) or stepped `frames`, written to a file. **Look at the image.** |
| `advise` | Compile-cost estimate, plus findings with concrete fixes (`measure:true` also compiles). See COMPILE-COST.md |
| `bench.corpus` / `bench.summary` / `bench.stop` | Corpus compile times on this backend vs the D3D11 reference |
| `viewer.open` (id → detail page, isf/path → editor) / `viewer.setSource` / `viewer.setInputs` / `viewer.state` / `viewer.getSource` / `viewer.snapshot` | Work in front of the human: hot-reload what they are watching, and read their edits and slider values |
| `ui.toast` / `ui.openView` | Talk to the human, or switch views |
| `mods.list` / `mods.write` / `mods.reload` / `mods.disable` / `mods.enable` / `mods.eval` | Change the studio itself |

Every tool accepts `{isf}`, `{id}` (corpus) or `{path}` where it makes sense.

## Changing the studio from an agent

```
mods.write { "file": "my-tools/index.js", "contents": "export function activate(studio){ ... }" }
```

That writes the file into the mods folder and reloads it, so the new tools are callable right away. Use
`mods.eval` for one-off experiments, and `mods.write` for anything that should still be there after a
restart. Read docs/MODDING.md first.

## Habits that worked (from the glslop blindtests)

- Look at every render before you believe it. A compile that succeeds can still produce a black or
  wrong image.
- Report compile times together with their backend. Vulkan/Metal times say nothing about what a Windows
  Chrome visitor pays (D3D11/FXC), so run `advise` before publishing.
- Test a performance theory with one measurement before acting on it.
- Publishing to glslop.com stays with the human. The studio has no publish tool by default.

## Testing the app from an agent

Environment variables for running a disposable copy of the app:

| Variable | Effect |
|---|---|
| `GLSLOP_STUDIO_HOME` | Use this folder instead of `~/.glslop-studio` (settings, cache, mods, `bridge.json`). |
| `GLSLOP_STUDIO_NO_BROWSER=1` | `account.signIn` doesn't open the default browser. Read the sign-in URL from `studio.state.authUrl` (or the `auth:url` event) and open it in your own browser. |
| `GLSLOP_STUDIO_SIGNIN_WAIT_S` | How long sign-in waits for the browser (default 600). Short values test the "sign-in expired" page. |

Point a test copy at a local glslop dev server with `{"glslopBase": "http://127.0.0.1:4399"}` in its
`settings.json`. Sign-ins are stored per server, so this never touches a real glslop.com login.

## Shader weight

Every shader stage shows three gauges: **fps**, **desktop** (cold compile through the first frame on
the studio's backend) and **browser** (the same on ANGLE D3D11 + FXC, what glslop.com visitors on
Windows Chrome pay; glslop.com autoplays shaders under 500 ms). On Windows the browser number is
measured in a hidden background window; on Mac and Linux, or with the `browserProbe` setting off, it's
a static estimate and says so.

- `weight.measure` `{isf | path | id}`: both numbers for any source (defaults to the open shader).
- `viewer.setSource` `{isf, weight: true}`: apply and wait for the numbers in one call.
- `viewer.state` includes the current gauges under `weight`.

Measure before and after a change you expect to be heavy. A cold compile here can be 4–5× faster than
what visitors get.
