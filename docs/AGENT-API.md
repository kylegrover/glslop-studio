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
- **Publish without you.** The `publish` tool opens a confirmation window that shows every field being
  sent (title, tags, AI credit and prompt, poster, the full source). The native layer opens it and sends
  the request itself, and only that window can approve. There is no other write path to your account;
  the authenticated API door for mods is read-only. (A hostile *mod* is a different matter: mods run with
  the app's full file access, so they are trusted code. See the README.)

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
| `viewer.open` (id → detail page, isf/path → editor) / `viewer.setSource` / `viewer.undo` / `viewer.setInputs` / `viewer.state` / `viewer.getSource` / `viewer.snapshot` | Work in front of the human: hot-reload what they are watching, and read their edits and slider values |
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
| `GLSLOP_STUDIO_HOME` | Use this folder instead of `~/.glslop-studio` (settings, cache, mods, `bridge.json`). Such a copy also has its own sign-in: it never sees or uses the real app's glslop account. |
| `GLSLOP_STUDIO_NO_BROWSER=1` | `account.signIn` doesn't open the default browser. Read the sign-in URL from `studio.state.authUrl` (or the `auth:url` event) and open it in your own browser. |
| `GLSLOP_STUDIO_SIGNIN_WAIT_S` | How long sign-in waits for the browser (default 600). Short values test the "sign-in expired" page. |
| `GLSLOP_STUDIO_HIDDEN=1` | No visible window. The app runs normally and answers the bridge: for tests and for agents that don't need a human watching. |

Only one studio runs per user: a second launch focuses the first and exits. A run with its own
`GLSLOP_STUDIO_HOME` is separate, so test copies can run next to the real one.

Point a test copy at a local glslop dev server with `{"glslopBase": "http://127.0.0.1:4399"}` in its
`settings.json`. Sign-ins are stored per server, so this never touches a real glslop.com login.

## Editing next to a human

The editor is shared, so `viewer.setSource` won't replace text the human is still typing:

- `viewer.state` reports `dirty: true` while the human has edits they haven't applied.
- `viewer.setSource` is then refused with an error. Read the edits with `viewer.getSource`, merge
  them into your version and send that. `force: true` replaces them anyway.
- Your own update that failed to compile doesn't count as the human's: send the fix without `force`.
- Every update keeps what it replaced (20 steps). `viewer.undo` puts the last one back; the human has
  the same undo link next to the "updated by agent" badge.
- `viewer.open` waits for the shader to load and returns `loaded: true`.
- Edits to anything but the scratch buffer are autosaved to `workspace/autosave/` and offered back
  the next time a shader with that title is opened.

Uncaught errors in the window are shown to the human and kept in `studio.state.errors` (last 50).

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
