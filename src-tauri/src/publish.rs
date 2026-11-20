//! The publish confirmation window.
//!
//! `glslop_publish` (called from the main window) stores the exact request here, keyed by the label of
//! a new window it opens just for this decision. That window loads the bundled `publish.html` (no mods,
//! no bridge, nothing else of the app), asks Rust what it should show (`publish_view`), and reports the
//! human's choice (`publish_decide`). Both commands only answer the webview whose label owns the
//! pending request, using Tauri's own record of which webview invoked them.
//!
//! What this protects against: an agent or a mod calling the publish tool, or the main window calling
//! the decide command, cannot approve on the human's behalf; the human sees every field that will be
//! sent, and what is sent is exactly what was shown (the payload never leaves Rust after this point).
//! What it doesn't: code that already runs natively on this machine (and a hostile mod has ways to get
//! there through the app's broad file access). Mods are trusted code; see docs/MODDING.md.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const DECIDE_TIMEOUT: Duration = Duration::from_secs(600);

pub struct Pending {
    pub view: Value,
    decide: Option<std::sync::mpsc::Sender<bool>>,
}

#[derive(Default)]
pub struct PublishState {
    pending: Mutex<HashMap<String, Pending>>,
}

fn random_label() -> String {
    let mut b = [0u8; 12];
    getrandom::fill(&mut b).expect("os rng");
    format!("publish-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

/// Open the confirmation window for `view` and wait for the human. Returns true only on approve.
/// One at a time: a second request while one is open is refused, not stacked.
pub async fn ask(app: &tauri::AppHandle, view: Value) -> Result<bool, String> {
    let state = app.state::<PublishState>();
    let label = random_label();
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    {
        let mut p = state.pending.lock().unwrap();
        if !p.is_empty() {
            return Err("a publish confirmation is already open".into());
        }
        p.insert(label.clone(), Pending { view, decide: Some(tx) });
    }

    let main = app.get_webview_window("main");
    let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("publish.html".into()))
        .title("Publish to glslop")
        .inner_size(780.0, 860.0)
        .min_inner_size(560.0, 520.0)
        .center()
        .focused(true)
        .minimizable(false)
        .maximizable(false)
        // Only the bundled page; never navigate anywhere else or open new windows.
        .on_navigation(|url| matches!(url.scheme(), "tauri" | "http" | "https") && url.host_str().map_or(false, |h| h == "tauri.localhost" || h == "localhost"))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    if let Some(m) = &main {
        b = b.parent(m).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        // Its own profile: nothing the main window stored (storage, caches, service workers) is shared.
        b = b.data_directory(crate::config_dir().join("webview").join("publish"));
    }
    let win = match b.build() {
        Ok(w) => w,
        Err(e) => {
            state.pending.lock().unwrap().remove(&label);
            return Err(e.to_string());
        }
    };
    let _ = win.set_focus();

    // Closing the window = cancel. (A native event, not something a page can fake.)
    {
        let app2 = app.clone();
        let label2 = label.clone();
        win.on_window_event(move |e| {
            if matches!(e, tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }) {
                finish(&app2, &label2, false);
            }
        });
    }

    let approved = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(DECIDE_TIMEOUT).unwrap_or(false))
        .await
        .unwrap_or(false);
    // Whatever happened, the request is over: drop it and close the window.
    state.pending.lock().unwrap().remove(&label);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.destroy();
    }
    if let Some(m) = &main {
        let _ = m.set_focus();
    }
    Ok(approved)
}

/// First decision wins; later ones (a late click, the close event after approve) do nothing.
fn finish(app: &tauri::AppHandle, label: &str, approve: bool) -> bool {
    let state = app.state::<PublishState>();
    let mut p = state.pending.lock().unwrap();
    match p.get_mut(label).and_then(|e| e.decide.take()) {
        Some(tx) => tx.send(approve).is_ok(),
        None => false,
    }
}

/// What the confirmation window shows. Answers only the window that owns the pending request.
#[tauri::command]
pub fn publish_view(webview: tauri::Webview, state: tauri::State<'_, PublishState>) -> Result<Value, String> {
    let p = state.pending.lock().unwrap();
    p.get(webview.label()).map(|e| e.view.clone()).ok_or_else(|| "no publish request for this window".into())
}

/// The human's choice. Answers only the window that owns the pending request.
#[tauri::command]
pub fn publish_decide(webview: tauri::Webview, app: tauri::AppHandle, approve: bool) -> Result<bool, String> {
    if !webview.label().starts_with("publish-") {
        return Err("not a publish window".into());
    }
    Ok(finish(&app, webview.label(), approve))
}

/// The view model for one request: every field that will be sent, plus context from Rust.
pub fn view_model(payload: &Value, handle: &str, base: &str, note: Option<&str>, by_agent: bool) -> Value {
    let s = |k: &str| payload[k].as_str().map(str::to_string);
    let isf = payload["isf"].as_str().unwrap_or("");
    // Posters are PNG data URLs made by the app; anything else is not shown.
    let poster = s("poster").filter(|p| p.starts_with("data:image/png;base64,") && p.len() < 4_000_000);
    json!({
        "title": s("title"),
        "handle": handle,
        "server": base,
        "license": "CC0 (public domain): anyone can use, change and repost it, forever",
        "tags": payload["tags"],
        "parents": payload["parents"],
        "supersedes": s("supersedes"),
        "made_with": s("made_with"),
        "generator": payload["generator"],
        "poster": poster,
        "source": isf,
        "source_bytes": isf.len(),
        "source_lines": isf.lines().count(),
        "note": note,
        "by_agent": by_agent,
        "other_fields": payload.as_object().map(|o| o.keys()
            .filter(|k| !["isf", "title", "tags", "parents", "supersedes", "made_with", "generator", "poster", "compile_ok", "render_hash"].contains(&k.as_str()))
            .cloned().collect::<Vec<_>>()),
    })
}
