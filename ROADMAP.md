# Roadmap

Where glslop studio is and what comes next. Update it when a release ships or a decision changes.

## Now: 0.1.1 (stable, 2026-11-21)

Tested as installed copies updated through three betas on Windows 11, macOS 26 (M2) and Pop!_OS 22.04
(GNOME X11). In 0.1.1: safer editing next to agents, autosave per document, Ctrl+Q, second launch
focuses the window (GNOME too), tool arguments checked against their schemas, stable/beta update
channels, and a daily usage count (version + OS, no id, Settings switch). Release notes: GitHub.

Usage numbers: glslop.com/admin/audience → "glslop studio · 30d" (download clicks via glslop.com,
installs opened per day by version/OS). GitHub's per-file download counts are the full total.
Copies on 0.1.0 send no daily count until they update.

## Next: watch three people use it, then decide 0.2

The task, unchanged: install, fork a shader, change it, close the app, come back, share the result.
One person uses their own agent. Watch where they stop; don't coach unless they're stuck. Write
down each stop. Whatever stops two of three is 0.2's first job.

Likely candidates, in the order we expect them:
1. **Mac first launch.** Unsigned: macOS blocks it until "Open Anyway" or `xattr`. If a tester is on
   a Mac, sort out an Apple Developer ID ($99/yr) and notarization in CI *before* the sessions.
   Windows SmartScreen is one click and can wait.
2. **Finding yesterday's work.** Resume last shader / a short recent-work list showing local, forked
   from the site, and unpublished changes. Not full version history.
3. **Site → studio.** "Open from glslop.com URL": paste a shader link, get a local fork with its
   parent recorded. Deep links later.
4. **Show what the agent changed** in the current edit, so the human can keep parts and take over.

## 0.1.2 (on main, not yet released)

- Motion: live-shader startup splash; the opened shader flies from its hover frame into the stage and
  carries on from the same moment; the grid deals in; softer compile blinks. Setting `motion`
  (auto: full on Windows/macOS, calm on Linux or when the OS asks for reduced motion).
- Viewing a shader shows no gauges (fps and compile time are on the canvas hover); they appear once
  you edit, and only then does the app measure compile cost in the background.
- Fixed: after ~16 edits on one page, the next apply could fail as "broken" (measurements used a
  fresh WebGL context each time and the webview evicted the editor's).
- Fixed: relaunch and in-app updates open behind other windows on Windows.
- Second launch puts the cursor in browse's search box.
- Opt-in custom title bar (`titleBar: custom`), a prototype; Mac and Linux untested.

## Small fixes, not yet done

- Linux AppImage: after an update the old launcher process stays until quit, and the file keeps its
  old version in its name. Cosmetic; comes from Tauri's AppImage updater.
- Svelte `state_referenced_locally` warnings (50). Harmless; clean up when touching those files.

## Later, each needing its own decision

- **Mod file access** and `extraBrowserArgs`: what trusted mods may do (today: everything).
- **Main-window CSP.**
- **Bench**: time through the first frame before publishing more speed comparisons.
- Window size memory; checksums on the download page.

## Parked, with what would un-park it

- Embedded agent: external MCP repeatedly blocks real sessions.
- Mod marketplace: people already exchanging mods. First write two mods using only the documented
  API (a poster contact sheet, a custom input controller) and note every private thing they needed.
- Linux runtime swap: a supported Linux workflow that is measurably unusable.
- Sync endpoint: sync costing users time or the server money.

## Testing a release

See RELEASING.md. In short: `npm run check`, `cargo test`, `npm run test:app` (all platforms, against
`npx tauri build --no-bundle`), `npm run test:publish` (Windows, local glslop dev server), then a beta
updated on each OS before stable.
