//! glslop studio — the native shell.
//!
//! This file is intentionally thin. Everything interesting (tools, views, the renderer, mods) lives in
//! the webview, where GL runs and where mods can reach it. Rust only does what a webview cannot:
//!
//! 1. Picks the graphics backend before the webview starts (WebView2 `--use-angle=...` on Windows).
//! 2. Gives the frontend plain file access (`fs_*` commands). Mods are trusted code; there is no sandbox.
//! 3. Serves the mods/cache/workspace folders over the `studio://` scheme (mods as ES modules,
//!    content-addressed thumbnails as immutable images).
//! 4. Runs the agent bridge: a localhost HTTP server whose calls are forwarded into the webview's tool
//!    registry (`bridge:call` event -> `bridge_reply` command). See docs/AGENT-API.md.

mod auth;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_BRIDGE_PORT: u16 = 47615;

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BootSettings {
    /// "vulkan" | "d3d11" | "gl" | "default". Windows/WebView2 only; ignored elsewhere.
    angle_backend: Option<String>,
    /// Disable Chromium's GPU program/shader caches so compile timings are cold every run.
    disable_gpu_cache: Option<bool>,
    /// Extra raw WebView2 browser arguments, appended verbatim.
    extra_browser_args: Option<String>,
    bridge_port: Option<u16>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Paths {
    config: String,
    mods: String,
    workspace: String,
    cache: String,
    settings: String,
    bridge_file: String,
    app_resources: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BootInfo {
    angle_backend: String,
    browser_args: String,
    gpu_cache_disabled: bool,
    platform: String,
    bridge_url: Option<String>,
    paths: Paths,
}

struct Pending(Mutex<HashMap<String, Sender<Value>>>);

fn config_dir() -> PathBuf {
    if let Ok(p) = std::env::var("GLSLOP_STUDIO_HOME") {
        return PathBuf::from(p);
    }
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".glslop-studio")
}

fn paths(app: &tauri::AppHandle) -> Paths {
    let c = config_dir();
    let res = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    Paths {
        config: c.display().to_string(),
        mods: c.join("mods").display().to_string(),
        workspace: c.join("workspace").display().to_string(),
        cache: c.join("cache").display().to_string(),
        settings: c.join("settings.json").display().to_string(),
        bridge_file: c.join("bridge.json").display().to_string(),
        app_resources: res.display().to_string(),
    }
}

fn read_settings() -> BootSettings {
    fs::read_to_string(config_dir().join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Env beats settings so a launcher/agent can force a backend for one run.
fn chosen_backend(s: &BootSettings) -> String {
    std::env::var("GLSLOP_ANGLE")
        .ok()
        .or_else(|| s.angle_backend.clone())
        .unwrap_or_else(|| "vulkan".into())
}

fn browser_args(backend: &str, s: &BootSettings) -> (String, bool) {
    // Setting additional args REPLACES wry's defaults, so restate them.
    let mut a = vec!["--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection".to_string()];
    if backend != "default" {
        a.push(format!("--use-angle={backend}"));
    }
    // WEBGL_debug_shaders (translated source) and the unmasked renderer string.
    a.push("--enable-privileged-webgl-extensions".into());
    a.push("--ignore-gpu-blocklist".into());
    let no_cache = std::env::var("GLSLOP_NO_GPU_CACHE").map(|v| v == "1").unwrap_or(false) || s.disable_gpu_cache.unwrap_or(false);
    if no_cache {
        a.push("--disable-gpu-program-cache".into());
        a.push("--disable-gpu-shader-disk-cache".into());
    }
    if let Some(extra) = &s.extra_browser_args {
        a.push(extra.clone());
    }
    (a.join(" "), no_cache)
}

// ---------------------------------------------------------------- fs commands (deliberately broad)

#[tauri::command]
fn fs_read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn fs_write_text(path: String, contents: String) -> Result<(), String> {
    if let Some(p) = Path::new(&path).parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn fs_write_base64(path: String, data: String) -> Result<(), String> {
    let bytes = b64_decode(&data).ok_or("invalid base64")?;
    if let Some(p) = Path::new(&path).parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))
}

/// Binary write without base64: invoke('fs_write_bytes', uint8array, { headers: { 'x-path': encodeURIComponent(path) } }).
#[tauri::command]
fn fs_write_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("missing x-path header")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw (Uint8Array) body".into());
    };
    if let Some(p) = Path::new(&path).parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    dir: bool,
    size: u64,
    modified_ms: u128,
}

#[tauri::command]
fn fs_list(path: String) -> Result<Vec<DirEntry>, String> {
    let rd = match fs::read_dir(&path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("{path}: {e}")),
    };
    let mut out = vec![];
    for e in rd.flatten() {
        let md = e.metadata().ok();
        out.push(DirEntry {
            name: e.file_name().to_string_lossy().into(),
            path: e.path().display().to_string(),
            dir: md.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            size: md.as_ref().map(|m| m.len()).unwrap_or(0),
            modified_ms: md
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
fn fs_mkdir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_remove(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }.map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_exists(path: String) -> bool {
    Path::new(&path).exists()
}

// ---------------------------------------------------------------- boot + backend switching

#[tauri::command]
fn boot_info(state: tauri::State<'_, Arc<Mutex<BootInfo>>>) -> BootInfo {
    state.lock().unwrap().clone()
}

/// Restart the app with a different ANGLE backend (persisted to settings.json first by the frontend).
#[tauri::command]
fn relaunch(app: tauri::AppHandle) {
    app.restart();
}

// ---------------------------------------------------------------- publish confirmation

/// Native confirm dialog; resolves to true only on a real click of the OK button.
pub(crate) async fn confirm(app: &tauri::AppHandle, title: String, message: String, ok: String) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok, "Cancel".into()))
        .show(move |r| { let _ = tx.send(r); });
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false)).await.unwrap_or(false)
}

/// The same dialog, for mods. It is a courtesy, not a security boundary: webview code decides what
/// to do with the answer. Publishing is gated separately, in Rust (auth::glslop_publish).
#[tauri::command]
async fn confirm_native(app: tauri::AppHandle, title: String, message: String, ok: String) -> bool {
    confirm(&app, title, message, ok).await
}

// ---------------------------------------------------------------- agent bridge

#[tauri::command]
fn bridge_reply(id: String, result: Value, pending: tauri::State<'_, Arc<Pending>>) {
    if let Some(tx) = pending.0.lock().unwrap().remove(&id) {
        let _ = tx.send(result);
    }
}

/// Write a file only this user can read (0600 on Unix). On Windows the profile folder's ACL already
/// limits it to the user.
fn write_private(path: &Path, contents: &str) {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let _ = fs::remove_file(path);
        if let Ok(mut f) = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path) {
            let _ = f.write_all(contents.as_bytes());
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = fs::write(path, contents);
    }
}

fn start_bridge(app: tauri::AppHandle, pending: Arc<Pending>, port: u16) -> Option<String> {
    let server = (port..port + 20).find_map(|p| tiny_http::Server::http(("127.0.0.1", p)).ok().map(|s| (s, p)));
    let (server, port) = server?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let url = format!("http://127.0.0.1:{port}");
    let bridge_file = config_dir().join("bridge.json");
    let _ = fs::create_dir_all(config_dir());
    // The token is full control of the studio: keep the file private to this user where the OS lets us.
    write_private(&bridge_file, &serde_json::to_string_pretty(&json!({ "url": url, "token": token, "pid": std::process::id() })).unwrap());
    let url_out = url.clone();
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let app = app.clone();
            let pending = pending.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                let reply = |req: tiny_http::Request, code: u16, body: Value| {
                    let h = tiny_http::Header::from_bytes("content-type", "application/json").unwrap();
                    let _ = req.respond(tiny_http::Response::from_string(body.to_string()).with_status_code(code).with_header(h));
                };
                let authed = req.headers().iter().any(|h| {
                    h.field.equiv("authorization") && h.value.as_str() == format!("Bearer {token}")
                });
                // Same-machine only, but other local pages could still try to reach us; require the token.
                if !authed {
                    return reply(req, 401, json!({ "error": "missing or wrong bearer token; read it from bridge.json" }));
                }
                let url = req.url().to_string();
                let mut body = String::new();
                let _ = req.as_reader().take(64 * 1024 * 1024).read_to_string(&mut body);
                let args: Value = if body.trim().is_empty() { json!({}) } else {
                    match serde_json::from_str(&body) {
                        Ok(v) => v,
                        Err(e) => return reply(req, 400, json!({ "error": format!("invalid JSON body: {e}") })),
                    }
                };
                // GET /tools -> list, POST /tools/<name> -> call. Everything is answered by the webview.
                let path = url.split('?').next().unwrap_or("");
                let (tool, args) = if path == "/tools" || path == "/" {
                    ("__list".to_string(), json!({}))
                } else if let Some(name) = path.strip_prefix("/tools/") {
                    (name.to_string(), args)
                } else {
                    return reply(req, 404, json!({ "error": "use GET /tools or POST /tools/<name>" }));
                };
                let id = uuid::Uuid::new_v4().simple().to_string();
                let (tx, rx) = channel();
                pending.0.lock().unwrap().insert(id.clone(), tx);
                let _ = app.emit("bridge:call", json!({ "id": id, "tool": tool, "args": args }));
                match rx.recv_timeout(Duration::from_secs(600)) {
                    Ok(v) => {
                        let code = if v.get("error").is_some() { 400 } else { 200 };
                        reply(req, code, v)
                    }
                    Err(_) => {
                        pending.0.lock().unwrap().remove(&id);
                        reply(req, 504, json!({ "error": "the studio window did not answer within 10 minutes" }))
                    }
                }
            });
        }
    });
    Some(url_out)
}

// ---------------------------------------------------------------- mods:// scheme

fn mime_for(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "html" => "text/html",
        "png" => "image/png",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "wasm" => "application/wasm",
        "fs" | "glsl" | "frag" | "txt" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn base64_engine() -> &'static [u8; 64] {
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.split(',').last()?.trim(); // tolerate data URLs
    let mut map = [255u8; 256];
    for (i, c) in base64_engine().iter().enumerate() {
        map[*c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        if c == b'=' || c.is_ascii_whitespace() { continue; }
        let v = map[c as usize];
        if v == 255 { return None; }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings = read_settings();
    let backend = chosen_backend(&settings);
    let (args, no_cache) = browser_args(&backend, &settings);
    let pending = Arc::new(Pending(Mutex::new(HashMap::new())));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(auth::AuthState::default())
        .register_uri_scheme_protocol("studio", |_ctx, req| {
            // studio://localhost/<area>/<path>  (Windows: http://studio.localhost/<area>/<path>)
            // Serves the user's studio folders to the webview: mods (ES modules), cache (thumbnails,
            // texture posters), workspace (renders, exports). Nothing outside those three.
            let rel = percent_decode(req.uri().path().trim_start_matches('/'));
            let mut parts = rel.splitn(2, '/');
            let area = parts.next().unwrap_or("");
            let rest = parts.next().unwrap_or("");
            let builder = tauri::http::Response::builder().header("access-control-allow-origin", "*");
            if !matches!(area, "mods" | "cache" | "workspace") {
                return builder.status(404).body(b"unknown area".to_vec()).unwrap();
            }
            let root = config_dir().join(area);
            let p = root.join(rest);
            let ok = p.canonicalize().ok().zip(root.canonicalize().ok()).map(|(p, r)| p.starts_with(r)).unwrap_or(false);
            // Cache files are content-addressed (hash in the name), so they never change in place.
            let cache = if area == "cache" { "public, max-age=31536000, immutable" } else { "no-cache" };
            match (ok, fs::read(&p)) {
                (true, Ok(bytes)) => builder.header("content-type", mime_for(&p)).header("cache-control", cache).status(200).body(bytes).unwrap(),
                _ => builder.status(404).body(format!("not found: {rel}").into_bytes()).unwrap(),
            }
        })
        .manage(pending.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            let bridge_url = start_bridge(handle.clone(), pending.clone(), settings.bridge_port.unwrap_or(DEFAULT_BRIDGE_PORT));
            let p = paths(&handle);
            for d in [&p.mods, &p.workspace, &p.cache] {
                let _ = fs::create_dir_all(d);
            }
            app.manage(Arc::new(Mutex::new(BootInfo {
                angle_backend: backend.clone(),
                browser_args: args.clone(),
                gpu_cache_disabled: no_cache,
                platform: std::env::consts::OS.into(),
                bridge_url,
                paths: p,
            })));

            let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(format!("glslop studio · {backend}"))
                .inner_size(1440.0, 920.0)
                .min_inner_size(720.0, 480.0);
            // WebView2 refuses to share a user-data folder between different browser args, so give
            // every backend/cache combination its own profile. Harmless on other platforms.
            #[cfg(windows)]
            {
                let tag = format!("{backend}{}", if no_cache { "-nocache" } else { "" });
                b = b.additional_browser_args(&args).data_directory(config_dir().join("webview").join(tag));
            }
            b.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            boot_info, relaunch, bridge_reply, confirm_native,
            auth::auth_sign_in, auth::auth_status, auth::auth_sign_out, auth::glslop_api, auth::glslop_publish, fs_read_text, fs_write_text, fs_write_base64, fs_write_bytes, fs_list, fs_mkdir, fs_remove, fs_exists
        ])
        .run(tauri::generate_context!())
        .expect("error while running glslop studio");
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into()
}
