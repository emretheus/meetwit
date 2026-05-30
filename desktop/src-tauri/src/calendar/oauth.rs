//! Google OAuth 2.0 loopback + PKCE flow, token refresh, and event fetch.
//!
//! Public client (desktop app): no client secret; PKCE replaces it. The
//! client_id is read from `MEETWIT_GOOGLE_OAUTH_CLIENT_ID` (non-secret).

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::pkce::{Pkce, state_nonce};

// calendar.readonly is the feature scope; userinfo.email lets us label the
// connected account in the UI (the userinfo endpoint returns no email without
// it). Space-separated per the OAuth spec.
pub const GOOGLE_SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email";
const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const EVENTS_ENDPOINT: &str = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const USERINFO_ENDPOINT: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
/// How long we wait for the user to complete consent before giving up.
const CONSENT_TIMEOUT: Duration = Duration::from_secs(120);

/// Read a build-or-runtime config value. Prefers the value baked in at COMPILE
/// time (`option_env!`) so a shipped `.app` — launched from Finder, which
/// inherits no shell env — has the credential. Falls back to the RUNTIME
/// environment so `pnpm tauri:dev` (or a manual `MEETWIT_…=… ./meetwit`) still
/// works without a rebuild. Empty/whitespace counts as absent.
macro_rules! build_or_runtime_env {
    ($name:literal) => {{
        option_env!($name)
            .map(str::to_owned)
            .or_else(|| std::env::var($name).ok())
            .filter(|s| !s.trim().is_empty())
    }};
}

/// The OAuth client id. Absent → calendar is "not configured in this build"
/// and the Connect button is disabled (ADR §7).
pub fn oauth_client_id() -> Option<String> {
    build_or_runtime_env!("MEETWIT_GOOGLE_OAUTH_CLIENT_ID")
}

/// Read the OAuth client secret. Google's token endpoint requires this even for
/// "Desktop app" (installed) clients using PKCE — a Google-specific quirk; the
/// OAuth spec treats installed apps as public clients with no secret. The
/// Desktop-client secret is not truly confidential (Google embeds it in
/// distributed tools like gcloud); PKCE is the actual security boundary.
pub fn oauth_client_secret() -> Option<String> {
    build_or_runtime_env!("MEETWIT_GOOGLE_OAUTH_CLIENT_SECRET")
}

/// Result of a completed connect flow.
pub struct Connected {
    pub email: String,
    pub refresh_token: String,
    pub access_token: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    // Optional: Google's *error* responses omit access_token entirely. If this
    // were a required field, serde would fail to parse the error body and we'd
    // surface a useless "parse token response" instead of the real reason.
    access_token: Option<String>,
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: i64,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

/// Run the full loopback + PKCE consent flow against Google. Opens the system
/// browser, captures the redirect on 127.0.0.1, exchanges the code, and reads
/// the account email. Returns tokens for the caller to persist.
pub async fn connect_google(client_id: &str) -> Result<Connected> {
    let pkce = Pkce::generate();
    let state = state_nonce();

    // Bind 127.0.0.1 ONLY (never 0.0.0.0) on a random free port (ADR §2).
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("bind loopback listener")?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let auth_url = build_auth_url(&AuthUrlParams {
        client_id,
        redirect_uri: &redirect_uri,
        scope: GOOGLE_SCOPE,
        challenge: &pkce.challenge,
        state: &state,
    });

    // Open the consent screen in the user's browser (existing `open` pattern).
    std::process::Command::new("open")
        .arg(&auth_url)
        .spawn()
        .context("open consent browser")?;

    // Wait for Google to redirect back with ?code=&state=.
    let code = tokio::time::timeout(CONSENT_TIMEOUT, accept_redirect(listener, &state))
        .await
        .map_err(|_| anyhow!("cancelled"))??;

    let token = exchange_code(client_id, &code, &pkce.verifier, &redirect_uri).await?;
    let access_token = token
        .access_token
        .ok_or_else(|| anyhow!("token exchange returned no access_token"))?;
    let refresh_token = token.refresh_token.ok_or_else(|| {
        anyhow!("no refresh_token in token response (consent may need prompt=consent)")
    })?;
    let email = fetch_email(&access_token).await?;

    Ok(Connected {
        email,
        refresh_token,
        access_token,
    })
}

struct AuthUrlParams<'a> {
    client_id: &'a str,
    redirect_uri: &'a str,
    scope: &'a str,
    challenge: &'a str,
    state: &'a str,
}

fn build_auth_url(p: &AuthUrlParams<'_>) -> String {
    let q = serde_urlencoded::to_string([
        ("client_id", p.client_id),
        ("redirect_uri", p.redirect_uri),
        ("response_type", "code"),
        ("scope", p.scope),
        ("code_challenge", p.challenge),
        ("code_challenge_method", "S256"),
        ("state", p.state),
        ("access_type", "offline"),
        ("prompt", "consent"),
    ])
    .expect("urlencode auth params");
    format!("{AUTH_ENDPOINT}?{q}")
}

/// Accept exactly one `GET /?code=&state=` on the loopback and return the code.
/// Rejects any request whose `state` doesn't match (CSRF / code-injection
/// guard, ADR §2). Replies with a tiny "you can close this tab" page.
async fn accept_redirect(listener: TcpListener, expected_state: &str) -> Result<String> {
    loop {
        let (mut socket, _) = listener.accept().await.context("accept loopback conn")?;

        let mut buf = vec![0u8; 8192];
        let n = socket.read(&mut buf).await.context("read loopback req")?;
        let req = String::from_utf8_lossy(&buf[..n]);

        // First line: `GET /?code=...&state=... HTTP/1.1`
        let Some(request_line) = req.lines().next() else {
            write_http(&mut socket, 400, "Bad Request").await;
            continue;
        };
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("");
        let target = parts.next().unwrap_or("");
        if method != "GET" {
            write_http(&mut socket, 405, "Method Not Allowed").await;
            continue;
        }

        let (code, state) = parse_redirect_query(target);
        if state.as_deref() != Some(expected_state) {
            // State mismatch → reject (do not accept the code).
            write_http(&mut socket, 400, "Invalid state").await;
            bail!("state mismatch — possible CSRF, aborting");
        }
        let Some(code) = code else {
            write_http(&mut socket, 400, "Missing authorization code").await;
            continue;
        };

        write_http(
            &mut socket,
            200,
            "Meetwit is connected. You can close this tab and return to the app.",
        )
        .await;
        return Ok(code);
    }
}

/// Extract (code, state) from a request target like `/?code=X&state=Y`.
fn parse_redirect_query(target: &str) -> (Option<String>, Option<String>) {
    let query = target.split_once('?').map_or("", |(_, q)| q);
    let mut code = None;
    let mut state = None;
    for (k, v) in url_query_pairs(query) {
        match k.as_str() {
            "code" => code = Some(v),
            "state" => state = Some(v),
            _ => {}
        }
    }
    (code, state)
}

fn url_query_pairs(query: &str) -> Vec<(String, String)> {
    serde_urlencoded::from_str::<Vec<(String, String)>>(query).unwrap_or_default()
}

async fn write_http(socket: &mut tokio::net::TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let html = format!(
        "<html><body style=\"font-family:-apple-system,sans-serif;text-align:center;\
         padding-top:80px;color:#18181b\"><h2>{body}</h2></body></html>"
    );
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len(),
    );
    let _ = socket.write_all(resp.as_bytes()).await;
    let _ = socket.flush().await;
}

async fn exchange_code(
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("code_verifier", verifier),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
    ];
    // Google requires client_secret even for Desktop/PKCE clients (see
    // oauth_client_secret). If unset, we omit it and Google returns the clear
    // "client_secret is missing" error rather than a silent failure.
    let secret = oauth_client_secret();
    if let Some(s) = secret.as_deref() {
        form.push(("client_secret", s));
    }
    let resp = reqwest::Client::new()
        .post(TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .context("token exchange request")?;
    parse_token_response(resp, "token exchange").await
}

/// Parse Google's /token reply, surfacing the real OAuth error (with its
/// description) rather than a generic parse failure. Reads the body as text
/// first so a non-JSON error page doesn't masquerade as a parse bug.
async fn parse_token_response(resp: reqwest::Response, what: &str) -> Result<TokenResponse> {
    let status = resp.status();
    let body = resp.text().await.context("read token response body")?;
    let token: TokenResponse = serde_json::from_str(&body).map_err(|e| {
        anyhow!("{what} returned an unparseable response (HTTP {status}): {e}: {body}")
    })?;
    if let Some(err) = &token.error {
        let desc = token.error_description.as_deref().unwrap_or("");
        bail!(
            "{what} failed: {err}{}",
            if desc.is_empty() {
                String::new()
            } else {
                format!(" — {desc}")
            }
        );
    }
    Ok(token)
}

/// Exchange a refresh token for a fresh access token. On `invalid_grant`
/// (revoked/expired) returns a typed error so the caller can flip the account
/// to "needs reconnect".
pub async fn refresh_access_token(client_id: &str, refresh_token: &str) -> Result<TokenRefresh> {
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
    ];
    let secret = oauth_client_secret();
    if let Some(s) = secret.as_deref() {
        form.push(("client_secret", s));
    }
    let resp = reqwest::Client::new()
        .post(TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .context("token refresh request")?;
    // invalid_grant must stay a distinct, machine-readable error so the caller
    // can flip the account to "needs reconnect" — check it before the generic
    // parser bails with a prettier message.
    let status = resp.status();
    let body = resp.text().await.context("read refresh response body")?;
    let token: TokenResponse = serde_json::from_str(&body).map_err(|e| {
        anyhow!("token refresh returned an unparseable response (HTTP {status}): {e}: {body}")
    })?;
    if let Some(err) = &token.error {
        if err == "invalid_grant" {
            return Err(anyhow!("invalid_grant"));
        }
        let desc = token.error_description.as_deref().unwrap_or("");
        bail!(
            "token refresh failed: {err}{}",
            if desc.is_empty() {
                String::new()
            } else {
                format!(" — {desc}")
            }
        );
    }
    let access_token = token
        .access_token
        .ok_or_else(|| anyhow!("token refresh succeeded but returned no access_token"))?;
    Ok(TokenRefresh {
        access_token,
        expires_in: token.expires_in,
    })
}

pub struct TokenRefresh {
    pub access_token: String,
    pub expires_in: i64,
}

#[derive(Debug, Deserialize)]
struct UserInfo {
    email: Option<String>,
}

async fn fetch_email(access_token: &str) -> Result<String> {
    let resp = reqwest::Client::new()
        .get(USERINFO_ENDPOINT)
        .bearer_auth(access_token)
        .send()
        .await
        .context("userinfo request")?;
    let status = resp.status();
    let body = resp.text().await.context("read userinfo body")?;
    let info: UserInfo = serde_json::from_str(&body)
        .map_err(|e| anyhow!("userinfo unparseable (HTTP {status}): {e}: {body}"))?;
    info.email
        .ok_or_else(|| anyhow!("userinfo returned no email (HTTP {status}): {body}"))
}

// ─── Event fetch + normalize ──────────────────────────────────────────────

/// A normalized event ready to POST to the sidecar's /calendar/events/sync.
#[derive(Debug, Clone, serde::Serialize)]
pub struct NormalizedEvent {
    pub external_id: String,
    pub title: Option<String>,
    pub starts_at: String, // RFC3339
    pub ends_at: Option<String>,
    pub all_day: bool,
    pub attendees: Vec<Attendee>,
    pub description: Option<String>,
    pub conference_url: Option<String>,
    pub conference_kind: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Attendee {
    pub name: Option<String>,
    pub email: Option<String>,
    pub organizer: bool,
}

/// Fetch the user's primary-calendar events in [time_min, time_max] (RFC3339),
/// expanding recurring instances. `access_token` must be fresh.
pub async fn fetch_events(
    access_token: &str,
    time_min: &str,
    time_max: &str,
) -> Result<Vec<NormalizedEvent>> {
    let client = reqwest::Client::new();
    let resp = client
        .get(EVENTS_ENDPOINT)
        .bearer_auth(access_token)
        .query(&[
            ("timeMin", time_min),
            ("timeMax", time_max),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
            ("maxResults", "50"),
        ])
        .send()
        .await
        .context("events request")?;
    if !resp.status().is_success() {
        bail!("events fetch failed: HTTP {}", resp.status());
    }
    let raw: GoogleEventsList = resp.json().await.context("parse events list")?;
    Ok(raw.items.into_iter().map(normalize_event).collect())
}

#[derive(Debug, Deserialize)]
struct GoogleEventsList {
    #[serde(default)]
    items: Vec<GoogleEvent>,
}

#[derive(Debug, Deserialize)]
struct GoogleEvent {
    id: String,
    summary: Option<String>,
    description: Option<String>,
    location: Option<String>,
    #[serde(default)]
    start: GoogleEventTime,
    #[serde(default)]
    end: GoogleEventTime,
    #[serde(default)]
    attendees: Vec<GoogleAttendee>,
    #[serde(rename = "hangoutLink")]
    hangout_link: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct GoogleEventTime {
    #[serde(rename = "dateTime")]
    date_time: Option<String>,
    date: Option<String>, // present for all-day events
}

#[derive(Debug, Deserialize)]
struct GoogleAttendee {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    email: Option<String>,
    #[serde(default)]
    organizer: bool,
}

fn normalize_event(e: GoogleEvent) -> NormalizedEvent {
    let all_day = e.start.date_time.is_none() && e.start.date.is_some();
    // For all-day events Google gives `date` (YYYY-MM-DD); promote to midnight
    // UTC so it still sorts. Timed events carry an RFC3339 dateTime already.
    let starts_at = e
        .start
        .date_time
        .clone()
        .or_else(|| e.start.date.clone().map(|d| format!("{d}T00:00:00Z")))
        .unwrap_or_default();
    let ends_at = e
        .end
        .date_time
        .clone()
        .or_else(|| e.end.date.clone().map(|d| format!("{d}T00:00:00Z")));

    let (conference_url, conference_kind) = resolve_conference(&e);

    let attendees = e
        .attendees
        .into_iter()
        .map(|a| Attendee {
            name: a.display_name,
            email: a.email,
            organizer: a.organizer,
        })
        .collect();

    NormalizedEvent {
        external_id: e.id,
        title: e.summary,
        starts_at,
        ends_at,
        all_day,
        attendees,
        description: e.description,
        conference_url,
        conference_kind,
    }
}

/// Resolve the conference link from a Google event. Prefer the structured
/// `hangoutLink` (Meet); otherwise scan location + description for known
/// patterns. Mirrors the sidecar's `parse_conference_url` fallback.
fn resolve_conference(e: &GoogleEvent) -> (Option<String>, Option<String>) {
    if let Some(link) = &e.hangout_link {
        if link.contains("meet.google.com") {
            return (Some(link.clone()), Some("meet".to_string()));
        }
    }
    let haystack = format!(
        "{} {}",
        e.location.clone().unwrap_or_default(),
        e.description.clone().unwrap_or_default()
    );
    for (kind, needle, scheme) in [
        ("zoom", "zoom.us/j/", "https://"),
        ("meet", "meet.google.com/", "https://"),
        ("teams", "teams.microsoft.com/l/meetup-join/", "https://"),
    ] {
        if let Some(idx) = haystack.find(needle) {
            // Walk back to the scheme start, forward to whitespace/end.
            let start = haystack[..idx].rfind(scheme).unwrap_or(idx);
            let tail = &haystack[start..];
            let end = tail
                .find(|c: char| c.is_whitespace() || c == '>' || c == '"')
                .unwrap_or(tail.len());
            let url = tail[..end].trim_end_matches(['>', ')', '.', ',', '\'', '"']);
            return (Some(url.to_string()), Some(kind.to_string()));
        }
    }
    (None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_url_contains_required_pkce_params() {
        let url = build_auth_url(&AuthUrlParams {
            client_id: "cid.apps.googleusercontent.com",
            redirect_uri: "http://127.0.0.1:54321",
            scope: GOOGLE_SCOPE,
            challenge: "CHAL",
            state: "STATE",
        });
        assert!(url.starts_with(AUTH_ENDPOINT));
        assert!(url.contains("code_challenge=CHAL"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=STATE"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("response_type=code"));
        // Loopback redirect, url-encoded.
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A54321"));
    }

    #[test]
    fn parse_redirect_query_extracts_code_and_state() {
        let (code, state) = parse_redirect_query("/?code=4%2Fabc&state=xyz&scope=foo");
        assert_eq!(code.as_deref(), Some("4/abc")); // url-decoded
        assert_eq!(state.as_deref(), Some("xyz"));
    }

    #[test]
    fn parse_redirect_query_missing_code() {
        let (code, state) = parse_redirect_query("/?state=xyz");
        assert!(code.is_none());
        assert_eq!(state.as_deref(), Some("xyz"));
    }

    #[test]
    fn normalize_timed_event() {
        let e = GoogleEvent {
            id: "e1".into(),
            summary: Some("Standup".into()),
            description: Some("Daily".into()),
            location: None,
            start: GoogleEventTime {
                date_time: Some("2026-05-22T14:00:00Z".into()),
                date: None,
            },
            end: GoogleEventTime {
                date_time: Some("2026-05-22T14:30:00Z".into()),
                date: None,
            },
            attendees: vec![GoogleAttendee {
                display_name: Some("Sarah".into()),
                email: Some("s@x.com".into()),
                organizer: true,
            }],
            hangout_link: Some("https://meet.google.com/abc-defg-hij".into()),
        };
        let n = normalize_event(e);
        assert!(!n.all_day);
        assert_eq!(n.starts_at, "2026-05-22T14:00:00Z");
        assert_eq!(n.conference_kind.as_deref(), Some("meet"));
        assert_eq!(n.attendees.len(), 1);
        assert!(n.attendees[0].organizer);
    }

    #[test]
    fn normalize_all_day_event() {
        let e = GoogleEvent {
            id: "e2".into(),
            summary: Some("Holiday".into()),
            description: None,
            location: None,
            start: GoogleEventTime {
                date_time: None,
                date: Some("2026-05-22".into()),
            },
            end: GoogleEventTime {
                date_time: None,
                date: Some("2026-05-23".into()),
            },
            attendees: vec![],
            hangout_link: None,
        };
        let n = normalize_event(e);
        assert!(n.all_day);
        assert_eq!(n.starts_at, "2026-05-22T00:00:00Z");
    }

    #[test]
    fn resolve_conference_from_description_zoom() {
        let e = GoogleEvent {
            id: "z".into(),
            summary: None,
            description: Some("Join https://acme.zoom.us/j/9999?pwd=x please".into()),
            location: None,
            start: GoogleEventTime::default(),
            end: GoogleEventTime::default(),
            attendees: vec![],
            hangout_link: None,
        };
        let (url, kind) = resolve_conference(&e);
        assert_eq!(url.as_deref(), Some("https://acme.zoom.us/j/9999?pwd=x"));
        assert_eq!(kind.as_deref(), Some("zoom"));
    }
}
