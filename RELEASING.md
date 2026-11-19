# Releasing

1. Bump `version` in `package.json`. That is the only place: Tauri and the app both read it from there.
2. `git tag vX.Y.Z && git push --tags`. A tag with a hyphen (`v0.2.0-beta.1`) is published as a
   prerelease.
3. The `release` workflow builds Windows (NSIS), macOS (universal, ad-hoc signed) and Linux
   (AppImage/deb). It uploads them to a **draft** GitHub Release along with signed updater
   artifacts and `latest.json`.
4. Check the draft, then publish it. Installed apps pick it up on their next launch: they check
   `https://glslop.com/studio/latest.json`, which a Cloudflare redirect rule points at
   `https://github.com/kylegrover/glslop-studio/releases/latest/download/latest.json`.

The updater signing key lives outside the repo (`~/.tauri/glslop-studio.key` and its password
file). It is also stored as the GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. **If the key is lost, installed apps can never update
again.** Keep a backup in your password manager.

Unsigned builds:
- **macOS:** the first launch needs System Settings → Privacy & Security → "Open Anyway". Or run
  `xattr -dr com.apple.quarantine "/Applications/glslop studio.app"`.
- **Windows:** SmartScreen shows "More info → Run anyway".
