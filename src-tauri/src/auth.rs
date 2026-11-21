//! "Sign in with glslop": OAuth 2.1 authorization code + PKCE over a loopback redirect (RFC 8252).
//!
//! Security model: the refresh token lives in the OS keychain and the short-lived access token in
//! Rust memory. NEITHER is ever handed to the webview, and both are keyed by server origin, so a
//! token for glslop.com is only ever sent to glslop.com.
//!
//! The webview (UI, mods, agents over the bridge) gets exactly two authenticated doors:
//! - `glslop_api`: GET requests to /api/* (reads).
//! - `glslop_publish`: the one write. Rust opens the confirmation window (src/publish.rs) and Rust
//!   sends the request, so a mod or agent calling the publish tool can't approve it for the human.

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const CLIENT_ID: &str = "glslop-studio";
const SCOPES: &str = "shaders:write drafts:write profile:read";
const KEYRING_SERVICE: &str = "glslop-studio";

/// Everything is keyed by server origin (see `origin`), never shared between servers.
#[derive(Default)]
pub struct AuthState {
    access: Mutex<HashMap<String, (String, Instant)>>, // origin -> (token, expiry)
    handle: Mutex<HashMap<String, String>>,            // origin -> handle
    /// Bumped by every sign-in; an older attempt that sees a newer number stops waiting.
    attempt: std::sync::Arc<AtomicU64>,
}

/// How long the app waits for the browser. Logging in to glslop first can take a few minutes.
const SIGN_IN_WAIT: Duration = Duration::from_secs(600);
/// After giving up, keep answering the old callback port with an "expired" page for this long, so a
/// late "allow" gets a clear message instead of the browser's own connection-refused error.
const EXPIRED_GRACE: Duration = Duration::from_secs(3600);

#[derive(Serialize)]
pub struct AuthStatus {
    signed_in: bool,
    handle: Option<String>,
    base: String,
}

/// Normalise a server URL to its origin ("https://glslop.com"). Tokens and keychain entries are
/// keyed by this, so every spelling of one server shares a login and no other server can borrow it.
/// Plain http is allowed only for a local dev server.
fn origin(base: &str) -> Result<String, String> {
    let u = url::Url::parse(base.trim()).map_err(|e| format!("bad server URL: {e}"))?;
    let host = u.host_str().ok_or("server URL needs a host")?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err("server URL must not contain credentials".into());
    }
    let local = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    match u.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return Err("server URL must be https (http is allowed only for localhost)".into()),
    }
    Ok(u.origin().ascii_serialization())
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random(n: usize) -> String {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).expect("os rng");
    b64(&buf)
}

/// The keychain service name. A run with its own home folder (GLSLOP_STUDIO_HOME: tests, side-by-side
/// copies) gets its own name, so it can never read or use the real app's sign-in.
fn keyring_service(home: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    match home.map(str::trim).filter(|h| !h.is_empty()) {
        None => KEYRING_SERVICE.to_string(),
        Some(h) => {
            let hex: String = Sha256::digest(h.as_bytes()).iter().take(6).map(|b| format!("{b:02x}")).collect();
            format!("{KEYRING_SERVICE}:{hex}")
        }
    }
}

fn entry(base: &str) -> Result<keyring::Entry, String> {
    // One credential per server, so a dev server and glslop.com don't overwrite each other.
    let service = keyring_service(std::env::var("GLSLOP_STUDIO_HOME").ok().as_deref());
    keyring::Entry::new(&service, base).map_err(|e| e.to_string())
}

fn post_form(url: &str, form: &[(&str, &str)]) -> Result<Value, String> {
    let resp = ureq::post(url).config().http_status_as_error(false).build().send_form(form.iter().copied()).map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body: Value = resp.into_body().read_json().map_err(|e| e.to_string())?;
    if status >= 400 {
        return Err(format!("{}: {}", body["error"].as_str().unwrap_or("error"), body["error_description"].as_str().unwrap_or("")));
    }
    Ok(body)
}

fn store_tokens(state: &AuthState, base: &str, tok: &Value) -> Result<(), String> {
    let access = tok["access_token"].as_str().ok_or("no access_token")?.to_string();
    let ttl = tok["expires_in"].as_u64().unwrap_or(3600);
    state.access.lock().unwrap().insert(base.to_string(), (access, Instant::now() + Duration::from_secs(ttl.saturating_sub(60))));
    if let Some(r) = tok["refresh_token"].as_str() {
        entry(base)?.set_password(r).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn forget(state: &AuthState, base: &str) {
    state.access.lock().unwrap().remove(base);
    state.handle.lock().unwrap().remove(base);
}

/// A valid access token for `base`, refreshing (and rotating the stored refresh token) if needed.
fn access_token(state: &AuthState, base: &str) -> Result<String, String> {
    if let Some((t, exp)) = state.access.lock().unwrap().get(base).cloned() {
        if Instant::now() < exp {
            return Ok(t);
        }
    }
    let refresh = entry(base)?.get_password().map_err(|_| "not signed in".to_string())?;
    match post_form(&format!("{base}/oauth/token"), &[("grant_type", "refresh_token"), ("client_id", CLIENT_ID), ("refresh_token", &refresh)]) {
        Ok(tok) => {
            store_tokens(state, base, &tok)?;
            Ok(tok["access_token"].as_str().unwrap_or_default().to_string())
        }
        Err(e) => {
            // invalid_grant = revoked/expired/reused: forget it so the UI shows "sign in" again.
            if e.starts_with("invalid_grant") {
                let _ = entry(base)?.delete_credential();
                forget(state, base);
            }
            Err(e)
        }
    }
}

/// The small page the browser shows after the redirect back to the app.
fn page(title: &str, body: &str) -> String {
    let html = format!("<!doctype html><meta charset=utf-8><title>glslop studio</title><body style=\"font:16px ui-monospace,monospace;background:#c4c2b4;padding:40px;max-width:640px\"><h1 style=\"font-family:Times,serif\">{title}</h1><p>{body}</p>");
    format!("HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
content-length: {}
cache-control: no-store
connection: close

{}", html.len(), html)
}

/// Read one HTTP request from the loopback socket and return its path + query, if it's /callback.
fn read_callback(sock: &mut std::net::TcpStream) -> Option<HashMap<String, String>> {
    sock.set_nonblocking(false).ok();
    sock.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut buf = [0u8; 8192];
    let n = sock.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]);
    let path = req.split_whitespace().nth(1).unwrap_or("/");
    let u = url::Url::parse(&format!("http://127.0.0.1{path}")).ok()?;
    if u.path() != "/callback" {
        let _ = sock.write_all(b"HTTP/1.1 404 Not Found
content-length: 0
connection: close

");
        return None;
    }
    Some(u.query_pairs().into_owned().collect())
}

/// The app stopped waiting (timed out, or a newer sign-in started). Keep the port answering for a
/// while with an explanation, then let it go.
fn serve_expired(listener: TcpListener, reason: &'static str) {
    std::thread::spawn(move || {
        let until = Instant::now() + EXPIRED_GRACE;
        while Instant::now() < until {
            match listener.accept() {
                Ok((mut sock, _)) => {
                    if read_callback(&mut sock).is_some() {
                        let _ = sock.write_all(page("this sign-in expired", &format!("{reason} Nothing was signed in. Go back to glslop studio and click <b>login</b> again; it opens a fresh page.")).as_bytes());
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(200)),
                Err(_) => return,
            }
        }
    });
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[tauri::command]
pub async fn auth_sign_in(app: tauri::AppHandle, state: tauri::State<'_, AuthState>, base: String) -> Result<AuthStatus, String> {
    let base = origin(&base)?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let verifier = random(48);
    let challenge = b64(&Sha256::digest(verifier.as_bytes()));
    let csrf = random(16);
    let mut url = url::Url::parse(&format!("{base}/oauth/authorize")).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", &redirect)
        .append_pair("scope", SCOPES)
        .append_pair("state", &csrf)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    use tauri::Emitter;
    use tauri_plugin_opener::OpenerExt;
    // Also announced to the UI so "browser didn't open?" can show a copyable link.
    let _ = app.emit("auth:url", url.as_str());
    // GLSLOP_STUDIO_NO_BROWSER=1: don't open the default browser; whoever drives the app (a test, an
    // agent with its own browser) takes the URL from the auth:url event / studio.state.authUrl instead.
    if std::env::var_os("GLSLOP_STUDIO_NO_BROWSER").is_none() {
        app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())?;
    }

    // Wait (off the async runtime) for the browser to come back. A newer sign-in supersedes this one.
    let attempts = state.attempt.clone();
    let mine = attempts.fetch_add(1, Ordering::SeqCst) + 1;
    let code = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // Non-blocking accept + polling, so the deadline fires even if the browser never comes back.
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        // GLSLOP_STUDIO_SIGNIN_WAIT_S shortens the wait, for testing the timeout.
        let wait = std::env::var("GLSLOP_STUDIO_SIGNIN_WAIT_S").ok().and_then(|v| v.parse().ok()).map(Duration::from_secs).unwrap_or(SIGN_IN_WAIT);
        let deadline = Instant::now() + wait;
        loop {
            if attempts.load(Ordering::SeqCst) != mine {
                serve_expired(listener, "A newer sign-in was started from the app, so this one was cancelled.");
                return Err("sign-in cancelled: a newer one was started".into());
            }
            if Instant::now() > deadline {
                serve_expired(listener, "The app stopped waiting for this sign-in.");
                return Err("sign-in timed out. Click login to try again.".into());
            }
            let mut sock = match listener.accept() {
                Ok((s, _)) => s,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            let Some(q) = read_callback(&mut sock) else { continue };
            if q.get("state") != Some(&csrf) {
                let _ = sock.write_all(page("sign-in didn't match", "This page belongs to a different sign-in attempt. Go back to glslop studio and click <b>login</b> again.").as_bytes());
                continue; // a stray old tab must not cancel the live attempt
            }
            if let Some(err) = q.get("error") {
                let _ = sock.write_all(page("sign-in cancelled", &format!("({}) Nothing was signed in. You can close this tab.", html_escape(err))).as_bytes());
                return Err(format!("sign-in cancelled ({err})"));
            }
            let _ = sock.write_all(page("signed in ✓", "You can close this tab and go back to glslop studio.").as_bytes());
            return q.get("code").cloned().ok_or_else(|| "no code".to_string());
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    let tok = post_form(
        &format!("{base}/oauth/token"),
        &[("grant_type", "authorization_code"), ("client_id", CLIENT_ID), ("code", &code), ("redirect_uri", &redirect), ("code_verifier", &verifier)],
    )?;
    store_tokens(&state, &base, &tok)?;
    status_for(&state, &base)
}

/// `base` must already be an origin.
fn status_for(state: &AuthState, base: &str) -> Result<AuthStatus, String> {
    let base = base.to_string();
    if entry(&base)?.get_password().is_err() {
        return Ok(AuthStatus { signed_in: false, handle: None, base });
    }
    if let Some(h) = state.handle.lock().unwrap().get(&base).cloned() {
        return Ok(AuthStatus { signed_in: true, handle: Some(h), base });
    }
    let me = glslop_request(state, &base, "GET", "/api/v1/me", None)?;
    let handle = me["body"]["handle"].as_str().map(String::from);
    if let Some(h) = &handle {
        state.handle.lock().unwrap().insert(base.clone(), h.clone());
    }
    Ok(AuthStatus { signed_in: handle.is_some(), handle, base })
}

#[tauri::command]
pub async fn auth_status(state: tauri::State<'_, AuthState>, base: String) -> Result<AuthStatus, String> {
    status_for(&state, &origin(&base)?)
}

#[tauri::command]
pub async fn auth_sign_out(state: tauri::State<'_, AuthState>, base: String) -> Result<(), String> {
    let base = origin(&base)?;
    if let Ok(r) = entry(&base)?.get_password() {
        let _ = post_form(&format!("{base}/oauth/revoke"), &[("token", &r), ("client_id", CLIENT_ID)]);
    }
    let _ = entry(&base)?.delete_credential();
    forget(&state, &base);
    Ok(())
}

/// `base` must already be an origin; the token attached is the one stored for exactly that origin.
fn glslop_request(state: &AuthState, base: &str, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    if !path.starts_with("/api/") {
        return Err("only /api/* on the configured server".into());
    }
    let token = access_token(state, base)?;
    let url = format!("{base}{path}");
    let auth = format!("Bearer {token}");
    let resp = match method {
        "GET" => ureq::get(&url).header("authorization", &auth).config().http_status_as_error(false).build().call(),
        "POST" => ureq::post(&url).header("authorization", &auth).config().http_status_as_error(false).build().send_json(body.unwrap_or(json!({}))),
        m => return Err(format!("method {m} is not supported")),
    }
    .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body: Value = resp.into_body().read_json().unwrap_or(Value::Null);
    Ok(json!({ "status": status, "body": body }))
}

/// Authenticated READ as the signed-in user: GET /api/* only. Returns { status, body }.
/// Writes do not go through here. The only write is `glslop_publish`, which asks the human first.
#[tauri::command]
pub async fn glslop_api(state: tauri::State<'_, AuthState>, base: String, method: String, path: String) -> Result<Value, String> {
    if !method.eq_ignore_ascii_case("GET") {
        return Err("glslop_api is read-only (GET). To publish, use glslop_publish, which asks the human first.".into());
    }
    glslop_request(&state, &origin(&base)?, "GET", &path, None)
}

/// Shorten untrusted text for the dialog and drop control characters (keeps newlines).
fn clip(s: &str, n: usize) -> String {
    let clean: Vec<char> = s.chars().filter(|c| !c.is_control() || *c == '\n').collect();
    if clean.len() > n {
        clean[..n].iter().collect::<String>() + "…"
    } else {
        clean.into_iter().collect()
    }
}

/// Publish a shader as the signed-in user. Rust opens the confirmation window, which shows every
/// field of this exact payload, and Rust sends it, so a mod or agent calling this can't approve it
/// for the human. The account is pinned when the window opens: if it changes before the click, the
/// publish is refused. `note` is extra detail from the caller, shown under its own label.
#[tauri::command]
pub async fn glslop_publish(
    app: tauri::AppHandle,
    state: tauri::State<'_, AuthState>,
    base: String,
    payload: Value,
    note: Option<String>,
    by_agent: Option<bool>,
) -> Result<Value, String> {
    let base = origin(&base)?;
    let handle = status_for(&state, &base)?.handle.ok_or("not signed in")?;
    let title = payload["title"].as_str().map(str::trim).filter(|t| !t.is_empty()).ok_or("payload.title is required")?;
    if payload["isf"].as_str().is_none_or(|s| s.trim().is_empty()) {
        return Err("payload.isf is required".into());
    }
    let _ = title;
    let note = note.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(|n| clip(n, 600));
    let view = crate::publish::view_model(&payload, &handle, &base, note.as_deref(), by_agent.unwrap_or(false));
    if !crate::publish::ask(&app, view).await? {
        return Ok(json!({ "published": false, "reason": "cancelled by the human" }));
    }
    // Same account as the one shown? A sign-out or sign-in while the window was open must not
    // publish as someone else.
    if status_for(&state, &base)?.handle.as_deref() != Some(handle.as_str()) {
        return Ok(json!({ "published": false, "reason": "the signed-in account changed while confirming; nothing was sent" }));
    }
    let r = glslop_request(&state, &base, "POST", "/api/submit", Some(payload))?;
    let ok = r["status"].as_u64().is_some_and(|s| s < 400);
    Ok(json!({ "published": ok, "status": r["status"], "body": r["body"] }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_accepts_https_and_local_http_only() {
        assert_eq!(origin("https://glslop.com").unwrap(), "https://glslop.com");
        assert_eq!(origin(" https://glslop.com/some/path?x=1 ").unwrap(), "https://glslop.com");
        assert_eq!(origin("https://GLSLOP.com:8443/").unwrap(), "https://glslop.com:8443");
        assert_eq!(origin("http://127.0.0.1:4399").unwrap(), "http://127.0.0.1:4399");
        assert_eq!(origin("http://localhost:4399/x").unwrap(), "http://localhost:4399");
        for bad in ["http://glslop.com", "http://evil.example", "ftp://glslop.com", "https://user:pw@glslop.com", "glslop.com", "", "file:///etc/passwd"] {
            assert!(origin(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn a_custom_home_never_shares_the_real_keychain_entry() {
        assert_eq!(keyring_service(None), "glslop-studio");
        assert_eq!(keyring_service(Some("  ")), "glslop-studio");
        let a = keyring_service(Some("C:/tmp/home_a"));
        let b = keyring_service(Some("C:/tmp/home_b"));
        assert!(a.starts_with("glslop-studio:") && a.len() == "glslop-studio:".len() + 12, "{a}");
        assert_ne!(a, b);
        assert_ne!(a, "glslop-studio");
        assert_eq!(a, keyring_service(Some("C:/tmp/home_a")), "stable for the same folder");
    }

    #[test]
    fn clip_shortens_and_drops_control_characters() {
        assert_eq!(clip("hello", 10), "hello");
        assert_eq!(clip("hello world", 5), "hello…");
        assert_eq!(clip("ab	c
d", 10), "abc
d");
        assert_eq!(clip("ééééé", 3), "ééé…");
    }
}
