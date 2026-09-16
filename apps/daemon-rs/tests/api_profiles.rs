#![cfg(unix)]
//! Third-party API profile lifecycle, protocol probe and model catalog tests.
//!
//! A fake `claude` answers `--version`/`auth status` and dumps the environment
//! seen by a profile turn; a local axum server speaks the two-request SSE
//! handshake the probe requires and serves a `/v1/models` catalog. PROSPERO_CLAUDE_BIN
//! is process-global, so the tests serialize on SERIAL with every other file.

use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use prosperod_rs::{auth::Token, server::Api, worker::Database};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::Notify;
use tower::ServiceExt;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const SECRET: &str = "sk-prospero-profile-secret-0123456789";
const BEARER: &str = "Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// `--version` satisfies the probe's runtime gate; the headless turn dumps its
/// environment to CAPTURE exactly like the managed-account harness.
fn write_cli(directory: &std::path::Path) -> std::path::PathBuf {
    let script = r#"#!/usr/bin/env python3
import json, os, sys, threading, time

argv = sys.argv[1:]

if argv == ["--version"]:
    sys.stdout.write("1.2.3-fake\n")
    sys.exit(0)

if argv == ["auth", "status", "--json"]:
    sys.exit(0)

catalog_args = ["-p", "--output-format", "stream-json",
                "--input-format", "stream-json", "--verbose"]

def dump(path):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"argv": argv, "env": dict(os.environ)}, handle)

if argv == catalog_args:
    frame = json.loads(sys.stdin.readline())
    rid = frame["request_id"]
    sys.stdout.write(json.dumps({"type": "control_response", "response": {
        "subtype": "success", "request_id": rid,
        "response": {"models": [
            {"value": "default", "displayName": "Default"}]}}}) + "\n")
    sys.stdout.flush()
    sys.exit(0)

capture = os.environ.get("CAPTURE")
if capture:
    dump(capture)
sys.stdout.write(json.dumps({"type": "system", "subtype": "init",
                             "session_id": "profile-fake"}) + "\n")
sys.stdout.flush()
def answer_controls():
    while True:
        raw = sys.stdin.readline()
        if not raw:
            break
        try:
            frame = json.loads(raw)
        except Exception:
            continue
        sys.stdout.write(json.dumps({"type": "control_response", "response": {
            "subtype": "success", "request_id": frame.get("request_id"),
            "response": {}}}) + "\n")
        sys.stdout.flush()
threading.Thread(target=answer_controls, daemon=True).start()
time.sleep(600)
"#;
    let cli = directory.join("fake-claude-profile.py");
    std::fs::write(&cli, script).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    cli
}

fn write_opencode_cli(directory: &std::path::Path) -> std::path::PathBuf {
    write_version_cli(directory, "fake-opencode-profile.py", "opencode 0.0.0-test")
}

fn write_codex_cli(directory: &std::path::Path) -> std::path::PathBuf {
    write_version_cli(directory, "fake-codex-profile.py", "codex 0.0.0-test")
}

fn write_version_cli(
    directory: &std::path::Path,
    filename: &str,
    version: &str,
) -> std::path::PathBuf {
    let script = r#"#!/usr/bin/env python3
import sys
if sys.argv[1:] == ["--version"]:
    sys.stdout.write(__VERSION__ + "\n")
    sys.exit(0)
sys.exit(3)
"#
    .replace("__VERSION__", &format!("{version:?}"));
    let cli = directory.join(filename);
    std::fs::write(&cli, script).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    cli
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProbeMode {
    Success,
    AuthFail,
    NonSse,
    WrongReceipt,
}

#[derive(Clone)]
struct FakeState {
    mode: Arc<StdMutex<ProbeMode>>,
    /// When `gated` is set, the first POST signals `arrived` and parks until
    /// `release` fires, letting a test observe an in-flight probe.
    gated: Arc<AtomicBool>,
    arrived: Arc<Notify>,
    release: Arc<Notify>,
    first_consumed: Arc<AtomicBool>,
    messages_seen: Arc<AtomicUsize>,
    /// Catalog pages served in order; extra reads repeat the final page.
    models_pages: Arc<StdMutex<Vec<Value>>>,
    models_hits: Arc<AtomicUsize>,
}

fn sse(events: &[Value]) -> axum::response::Response {
    let body = events
        .iter()
        .map(|event| format!("data: {}\n\n", event))
        .collect::<String>();
    (
        StatusCode::OK,
        [("content-type", "text/event-stream")],
        body,
    )
        .into_response()
}

/// First probe request: one forced tool call carrying the nonce.
fn tool_stream(nonce: &str) -> Vec<Value> {
    vec![
        json!({"type":"message_start","message":{"type":"message","role":"assistant","id":"msg-1"}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-1","name":"prospero_connection_probe","input":{}}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":format!("{{\"nonce\":\"{nonce}\"")}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"}"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"}}),
        json!({"type":"message_stop"}),
    ]
}

/// Second request: plain text echoing the tool_result receipt.
fn receipt_stream(receipt: &str) -> Vec<Value> {
    vec![
        json!({"type":"message_start","message":{"type":"message","role":"assistant","id":"msg-2"}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":receipt}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
        json!({"type":"message_stop"}),
    ]
}

async fn messages(
    State(state): State<FakeState>,
    axum::Json(body): axum::Json<Value>,
) -> axum::response::Response {
    state.messages_seen.fetch_add(1, Ordering::SeqCst);
    let is_first = state
        .first_consumed
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    if is_first && state.gated.load(Ordering::SeqCst) {
        state.arrived.notify_one();
        state.release.notified().await;
    }
    // Clone the mode out: std::sync::Mutex is not reentrant, and the success
    // branch below used to re-lock while the outer guard was still alive.
    let mode = *state.mode.lock().unwrap();
    match mode {
        ProbeMode::AuthFail => (
            StatusCode::UNAUTHORIZED,
            [("content-type", "application/json")],
            json!({"error":{"type":"authentication_error","message":"bad key"}}).to_string(),
        )
            .into_response(),
        ProbeMode::NonSse => (
            StatusCode::OK,
            [("content-type", "application/json")],
            json!({"ok":true}).to_string(),
        )
            .into_response(),
        ProbeMode::Success | ProbeMode::WrongReceipt => {
            if is_first {
                let nonce = body["tools"][0]["input_schema"]["properties"]["nonce"]["enum"][0]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                sse(&tool_stream(&nonce))
            } else {
                let receipt = body["messages"]
                    .as_array()
                    .and_then(|messages| {
                        messages.iter().find_map(|message| {
                            message["content"].as_array().and_then(|blocks| {
                                blocks.iter().find_map(|block| {
                                    (block["type"] == "tool_result")
                                        .then(|| block["content"].as_str().map(str::to_owned))
                                        .flatten()
                                })
                            })
                        })
                    })
                    .unwrap_or_else(|| "missing".into());
                let echoed = match mode {
                    ProbeMode::WrongReceipt => "not-the-receipt".to_owned(),
                    _ => receipt,
                };
                sse(&receipt_stream(&echoed))
            }
        }
    }
}

async fn models(
    State(state): State<FakeState>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    if headers.get("authorization").is_some() && headers.get("x-api-key").is_some() {
        return (
            StatusCode::BAD_REQUEST,
            [("content-type", "application/json")],
            json!({"error":{"type":"invalid_request","message":"mixed auth"}}).to_string(),
        )
            .into_response();
    }
    if *state.mode.lock().unwrap() == ProbeMode::AuthFail {
        return (
            StatusCode::UNAUTHORIZED,
            [("content-type", "application/json")],
            json!({"error":{"type":"authentication_error"}}).to_string(),
        )
            .into_response();
    }
    let index = state.models_hits.fetch_add(1, Ordering::SeqCst);
    let pages = state.models_pages.lock().unwrap();
    let page = pages.get(index).unwrap_or_else(|| pages.last().unwrap());
    (
        StatusCode::OK,
        [("content-type", "application/json")],
        page.to_string(),
    )
        .into_response()
}

struct FakeServer {
    base_url: String,
    state: FakeState,
}

fn spawn_server(state: FakeState) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = axum::Router::new()
        .route("/v1/messages", post(messages))
        .route("/v1/models", get(models))
        .with_state(state);
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://127.0.0.1:{port}")
}

impl FakeServer {
    fn new(mode: ProbeMode, models_pages: Vec<Value>) -> Self {
        let state = FakeState {
            mode: Arc::new(StdMutex::new(mode)),
            gated: Arc::new(AtomicBool::new(false)),
            arrived: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
            first_consumed: Arc::new(AtomicBool::new(false)),
            messages_seen: Arc::new(AtomicUsize::new(0)),
            models_pages: Arc::new(StdMutex::new(models_pages)),
            models_hits: Arc::new(AtomicUsize::new(0)),
        };
        let base_url = spawn_server(state.clone());
        Self { base_url, state }
    }

    /// First /v1/messages POST parks until `allow` runs.
    fn gate(&self) {
        self.state.gated.store(true, Ordering::SeqCst);
    }

    fn allow(&self) {
        self.state.release.notify_waiters();
    }
}

struct Harness {
    directory: TempDir,
    #[allow(dead_code)]
    database: Database,
    app: axum::Router,
    secret: &'static str,
}

impl Harness {
    async fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let cli = write_cli(directory.path());
        let codex = write_codex_cli(directory.path());
        let opencode = write_opencode_cli(directory.path());
        unsafe {
            std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
            std::env::set_var("PROSPERO_CODEX_BIN", &codex);
            std::env::set_var("PROSPERO_OPENCODE_BIN", &opencode);
        }
        let data_dir = directory.path().join("daemon");
        let database = Database::open(data_dir).await.unwrap();
        let api = Api::new(
            database.clone(),
            Token::parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into())
                .unwrap(),
        );
        Self {
            directory,
            database,
            app: api.router(),
            secret: BEARER,
        }
    }

    async fn post(&self, payload: Value) -> (StatusCode, Value) {
        post_on(&self.app, self.secret, "/v1/accounts", payload).await
    }

    async fn post_path(&self, path: &str, payload: Value) -> (StatusCode, Value) {
        post_on(&self.app, self.secret, path, payload).await
    }

    fn account_root(&self, id: &str) -> std::path::PathBuf {
        self.directory
            .path()
            .join("daemon/agent-accounts/claude")
            .join(id)
    }

    fn codex_account_root(&self, id: &str) -> std::path::PathBuf {
        self.directory
            .path()
            .join("daemon/agent-accounts/codex")
            .join(id)
    }

    fn opencode_account_root(&self, id: &str) -> std::path::PathBuf {
        self.directory
            .path()
            .join("daemon/agent-accounts/opencode")
            .join(id)
    }
}

async fn post_on(
    app: &axum::Router,
    secret: &str,
    path: &str,
    payload: Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("authorization", secret)
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

impl Drop for Harness {
    fn drop(&mut self) {
        unsafe {
            std::env::remove_var("PROSPERO_CLAUDE_BIN");
            std::env::remove_var("PROSPERO_CODEX_BIN");
            std::env::remove_var("PROSPERO_OPENCODE_BIN");
            std::env::remove_var("CAPTURE");
        }
    }
}

fn control(kind: &str, extra: serde_json::Map<String, Value>) -> Value {
    let mut payload = serde_json::Map::new();
    payload.insert("type".into(), Value::String(kind.into()));
    payload.insert("requestId".into(), Value::String("req".into()));
    payload.extend(extra);
    Value::Object(payload)
}

fn obj(value: Value) -> serde_json::Map<String, Value> {
    value.as_object().unwrap().clone()
}

fn create_payload(base_url: &str, model: &str) -> Value {
    control(
        "agent.account.api.create",
        obj(json!({
            "agent": "claude",
            "name": " 第三方 Profile ",
            "baseUrl": base_url,
            "model": model,
            "apiKey": SECRET,
        })),
    )
}

async fn create_profile(harness: &Harness, server: &FakeServer) -> String {
    let (status, result) = harness
        .post(create_payload(&server.base_url, "fakemodel-1"))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    result["accountId"].as_str().unwrap().to_owned()
}

fn account<'a>(result: &'a Value, id: &str) -> Option<&'a Value> {
    result["accounts"].as_array().and_then(|accounts| {
        accounts
            .iter()
            .find(|row| row["id"] == Value::String(id.into()))
    })
}

#[tokio::test]
async fn profile_create_validates_connection_fields_and_persists_an_isolated_key() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let server = FakeServer::new(
        ProbeMode::Success,
        vec![json!({"data":[{"id":"fakemodel-1"}]})],
    );

    // Plain-HTTP is only allowed for loopback; non-local http(s) shape errors
    // are rejected before any network access.
    for bad in [
        "not-a-url",
        "http://gateway.example.com/v1",
        "https://user:pass@gateway.example.com",
        "https://gateway.example.com?x=1",
        "ftp://gateway.example.com",
    ] {
        let (status, _) = harness.post(create_payload(bad, "m")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "baseUrl {bad}");
    }
    for payload in [
        json!({"type":"agent.account.api.create","requestId":"r","agent":"claude",
            "name":"x","provider":"openai","baseUrl":server.base_url,"model":"m","apiKey":SECRET}),
        json!({"type":"agent.account.api.create","requestId":"r","agent":"claude",
            "name":"x","protocol":"openai_responses","baseUrl":server.base_url,"model":"m","apiKey":SECRET}),
        json!({"type":"agent.account.api.create","requestId":"r","agent":"claude",
            "name":"x","baseUrl":server.base_url,"model":"  ","apiKey":SECRET}),
        json!({"type":"agent.account.api.create","requestId":"r","agent":"claude",
            "name":"x","baseUrl":server.base_url,"model":"m","apiKey":""}),
        json!({"type":"agent.account.api.create","requestId":"r","agent":"claude",
            "name":"x","baseUrl":server.base_url,"model":"m","apiKey":SECRET,
            "modelCapabilities":{"maxOutputTokens":4096,"contextWindow":2048}}),
        json!({"type":"agent.account.api.create","requestId":"r","agent":"claude",
            "name":"x","baseUrl":server.base_url,"model":"m","apiKey":SECRET,
            "modelCapabilities":{"supportedEfforts":["bogus"]}}),
    ] {
        let (status, _) = harness.post(payload).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    let (status, codex_created) = harness
        .post(control(
            "agent.account.api.create",
            obj(json!({"agent":"codex",
                "name":"Codex Profile","baseUrl":format!("{}/responses", server.base_url),
                "model":"gpt-test","apiKey":SECRET})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{codex_created}");
    let codex_id = codex_created["accountId"].as_str().unwrap();
    let codex_row = account(&codex_created, codex_id).unwrap();
    assert_eq!(codex_row["agent"], "codex");
    assert_eq!(codex_row["apiProfile"]["provider"], "openai_compatible");
    assert_eq!(codex_row["apiProfile"]["protocol"], "openai_responses");
    assert_eq!(codex_row["apiProfile"]["baseUrl"], server.base_url);
    assert!(
        harness
            .codex_account_root(codex_id)
            .join(".prospero-credential.json")
            .is_file()
    );
    assert!(
        !harness
            .account_root(codex_id)
            .join(".prospero-credential.json")
            .exists()
    );

    let (status, opencode_created) = harness
        .post(control(
            "agent.account.api.create",
            obj(json!({"agent":"opencode",
                "name":"OpenCode Profile","provider":"openai_compatible",
                "protocol":"openai_chat_completions",
                "baseUrl":format!("{}/chat/completions", server.base_url),
                "model":"chat-test","apiKey":SECRET,
                "modelCapabilities":{"tools":true,"contextWindow":32000,"maxOutputTokens":2048}})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{opencode_created}");
    let opencode_id = opencode_created["accountId"].as_str().unwrap();
    let opencode_row = account(&opencode_created, opencode_id).unwrap();
    assert_eq!(opencode_row["agent"], "opencode");
    assert_eq!(opencode_row["engine"], "opencode");
    assert_eq!(
        opencode_row["apiProfile"]["protocol"],
        "openai_chat_completions"
    );
    assert_eq!(opencode_row["apiProfile"]["baseUrl"], server.base_url);
    assert_eq!(
        opencode_row["capabilities"],
        json!({"sessionKinds":["structured"],"plan":false,"resume":false,
               "modelSelection":false,"reasoningEffort":false})
    );
    assert!(
        harness
            .opencode_account_root(opencode_id)
            .join(".prospero-credential.json")
            .is_file()
    );

    // Successful create: trimmed name, profile metadata on the row, pinned
    // capabilities, key only inside the 0600 credential file.
    let (status, result) = harness
        .post(create_payload(&server.base_url, "fakemodel-1"))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let id = result["accountId"].as_str().unwrap().to_owned();
    let row = account(&result, &id).unwrap();
    assert_eq!(row["name"], "第三方 Profile");
    assert_eq!(row["status"], "signed_in", "runtime + key present");
    assert_eq!(row["authMethod"], "API Key");
    assert_eq!(row["engine"], "claude");
    assert_eq!(row["apiProfile"]["baseUrl"], server.base_url);
    assert_eq!(row["apiProfile"]["model"], "fakemodel-1");
    assert_eq!(
        row["capabilities"],
        json!({"sessionKinds":["pty","structured"],"plan":true,"resume":true,
               "modelSelection":false,"reasoningEffort":false})
    );
    assert!(row["apiValidation"].is_null());
    assert!(!result.to_string().contains(SECRET));

    let credential_path = harness.account_root(&id).join(".prospero-credential.json");
    let metadata = std::fs::metadata(&credential_path).unwrap();
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    let stored: Value =
        serde_json::from_str(&std::fs::read_to_string(&credential_path).unwrap()).unwrap();
    assert_eq!(stored["kind"], "api_key");
    assert_eq!(stored["secret"], SECRET);

    // The native row never carries a profile and yields the default flag.
    let native = account(&result, "native-claude").unwrap();
    assert_eq!(native["isDefault"], false);
    assert!(native["apiProfile"].is_null());

    // Endpoint suffixes normalize back to the loopback origin.
    let suffixed = format!("{}/v1/messages", server.base_url);
    let (status, result2) = harness.post(create_payload(&suffixed, "m2")).await;
    assert_eq!(status, StatusCode::OK, "{result2}");
    let id2 = result2["accountId"].as_str().unwrap();
    assert_eq!(
        account(&result2, id2).unwrap()["apiProfile"]["baseUrl"],
        server.base_url
    );
}

#[tokio::test]
async fn protocol_probe_records_pass_and_renders_in_the_snapshot() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let server = FakeServer::new(ProbeMode::Success, vec![]);
    let id = create_profile(&harness, &server).await;

    let (status, result) = harness
        .post(control(
            "agent.account.api.test",
            obj(json!({"accountId": id})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["accountId"], id);
    assert_eq!(result["validation"]["status"], "passed");
    assert_eq!(result["validation"]["engine"], "claude");
    assert_eq!(result["validation"]["checks"]["runtime"], "passed");
    assert_eq!(result["validation"]["checks"]["streaming"], "passed");
    assert_eq!(result["validation"]["checks"]["tools"], "passed");
    assert!(result["validation"]["code"].is_null());
    assert!(result["validation"]["latencyMs"].is_number());
    assert_eq!(server.state.messages_seen.load(Ordering::SeqCst), 2);

    // The snapshot now exposes the revision-checked validation.
    let (_, listed) = harness
        .post(control("agent.accounts.list", serde_json::Map::new()))
        .await;
    let row = account(&listed, &id).unwrap();
    assert_eq!(row["apiValidation"]["status"], "passed");
    assert!(row["detail"].as_str().unwrap().contains("协议测试通过"));
    assert!(!listed.to_string().contains(SECRET));
}

#[tokio::test]
async fn engine_probe_records_pass_and_renders_separately() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let server = FakeServer::new(ProbeMode::Success, vec![]);
    let id = create_profile(&harness, &server).await;

    let (status, result) = harness
        .post(control(
            "agent.account.api.test",
            obj(json!({"accountId": id, "scope": "engine"})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["accountId"], id);
    assert!(result["validation"].is_null());
    assert_eq!(result["engineValidation"]["status"], "passed");
    assert_eq!(result["engineValidation"]["engine"], "claude");
    assert_eq!(result["engineValidation"]["cliVersion"], "1.2.3-fake");
    assert_eq!(result["engineValidation"]["checks"]["runtime"], "passed");
    assert_eq!(
        result["engineValidation"]["checks"]["configuration"],
        "passed"
    );
    assert_eq!(result["engineValidation"]["checks"]["streaming"], "passed");
    assert_eq!(result["engineValidation"]["checks"]["tools"], "passed");
    assert_eq!(server.state.messages_seen.load(Ordering::SeqCst), 2);

    let (_, listed) = harness
        .post(control("agent.accounts.list", serde_json::Map::new()))
        .await;
    let row = account(&listed, &id).unwrap();
    assert_eq!(row["apiValidation"], Value::Null);
    assert_eq!(row["apiEngineValidation"]["status"], "passed");
    assert!(!listed.to_string().contains(SECRET));
}

#[tokio::test]
async fn protocol_probe_failures_keep_stable_codes() {
    let _guard = SERIAL.lock().await;

    // Auth failure: 401 SSE error maps to authentication_failed.
    let harness = Harness::new().await;
    let server = FakeServer::new(ProbeMode::AuthFail, vec![]);
    let id = create_profile(&harness, &server).await;
    let (status, result) = harness
        .post(control(
            "agent.account.api.test",
            obj(json!({"accountId": id})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["validation"]["status"], "failed");
    assert_eq!(result["validation"]["code"], "authentication_failed");
    assert_eq!(result["validation"]["checks"]["runtime"], "passed");
    assert_eq!(result["validation"]["checks"]["streaming"], "failed");
    drop(server);

    // Non-SSE body: streaming_unavailable.
    let harness = Harness::new().await;
    let server = FakeServer::new(ProbeMode::NonSse, vec![]);
    let id = create_profile(&harness, &server).await;
    let (_, result) = harness
        .post(control(
            "agent.account.api.test",
            obj(json!({"accountId": id})),
        ))
        .await;
    assert_eq!(result["validation"]["code"], "streaming_unavailable");
    drop(server);

    // Receipt mismatch: the tool roundtrip fails.
    let harness = Harness::new().await;
    let server = FakeServer::new(ProbeMode::WrongReceipt, vec![]);
    let id = create_profile(&harness, &server).await;
    let (_, result) = harness
        .post(control(
            "agent.account.api.test",
            obj(json!({"accountId": id})),
        ))
        .await;
    assert_eq!(result["validation"]["code"], "tool_roundtrip_failed");
    assert_eq!(result["validation"]["checks"]["tools"], "failed");
    drop(server);

    // Unreachable endpoint: connection failure, still a 200 envelope.
    let harness = Harness::new().await;
    let (status, result) = harness
        .post(create_payload("http://127.0.0.1:1", "m"))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let id = result["accountId"].as_str().unwrap().to_owned();
    let (_, result) = harness
        .post(control(
            "agent.account.api.test",
            obj(json!({"accountId": id})),
        ))
        .await;
    assert_eq!(result["validation"]["status"], "failed");
    assert_eq!(result["validation"]["code"], "connection_failed");
}

#[tokio::test]
async fn duplicate_in_flight_test_is_409_busy_and_invalid_scopes_are_rejected() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let server = FakeServer::new(ProbeMode::Success, vec![]);
    let id = create_profile(&harness, &server).await;
    server.gate();

    // Hold the first probe on the server gate; a second test for the same
    // profile is a 409 busy (legacy account_in_use → status 409, code busy).
    let first = tokio::spawn({
        let app = harness.app.clone();
        let id = id.clone();
        async move {
            post_on(
                &app,
                BEARER,
                "/v1/accounts",
                control("agent.account.api.test", obj(json!({"accountId": id}))),
            )
            .await
        }
    });
    server.state.arrived.notified().await;
    let (status, body) = harness
        .post(control(
            "agent.account.api.test",
            obj(json!({"accountId": id})),
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "busy");
    assert!(body["message"].as_str().unwrap().contains("正在测试连接"));

    // Engine scope shares the same per-profile in-flight guard.
    let (status, _) = harness
        .post(control(
            "agent.account.api.test",
            obj(json!({"accountId": id, "scope": "engine"})),
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = harness
        .post(control(
            "agent.account.api.test",
            obj(json!({"accountId": id, "scope": "bogus"})),
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The native row can never be tested.
    let (status, _) = harness
        .post(control(
            "agent.account.api.test",
            obj(json!({"accountId": "native-claude"})),
        ))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    server.allow();
    let (status, result) = first.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["validation"]["status"], "passed");
}

#[tokio::test]
async fn configure_invalidates_validation_and_is_blocked_by_active_sessions() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let server = FakeServer::new(ProbeMode::Success, vec![]);
    let id = create_profile(&harness, &server).await;
    let (_, tested) = harness
        .post(control(
            "agent.account.api.test",
            obj(json!({"accountId": id})),
        ))
        .await;
    assert_eq!(tested["validation"]["status"], "passed");

    // A name-only change preserves the recorded validation.
    let (status, renamed) = harness
        .post(control(
            "agent.account.api.configure",
            obj(json!({"accountId": id, "name": "renamed"})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(
        account(&renamed, &id).unwrap()["apiValidation"]["status"],
        "passed"
    );

    // Opening a structured profile session pins the account.
    let workspace = harness.directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let (status, session) = harness
        .post_path(
            "/v1/agent-sessions",
            json!({
                "title": "Claude",
                "workspace": workspace.to_str().unwrap(),
                "autoApprove": false,
                "accountId": id,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let session_id = session["id"].as_str().unwrap().to_owned();

    // Connection/key changes are 409 while the session is active.
    let (status, body) = harness
        .post(control(
            "agent.account.api.configure",
            obj(json!({"accountId": id, "model": "other-model"})),
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "in_use");

    let close = harness
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/v1/agent-sessions/{session_id}"))
                .header("authorization", harness.secret)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(close.status(), StatusCode::OK);

    // After close, a connection change wipes the stale validation.
    let (status, configured) = harness
        .post(control(
            "agent.account.api.configure",
            obj(json!({"accountId": id, "model": "other-model"})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{configured}");
    let row = account(&configured, &id).unwrap();
    assert_eq!(row["apiProfile"]["model"], "other-model");
    assert!(row["apiValidation"].is_null());
    assert!(row["detail"].as_str().unwrap().contains("尚未测试连接"));

    // Explicit null clears capabilities; omission keeps them. A key change
    // alone also invalidates the revision.
    let (status, cleared) = harness
        .post(control(
            "agent.account.api.configure",
            obj(json!({"accountId": id, "modelCapabilities": null})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    let row = account(&cleared, &id).unwrap();
    assert!(row["apiProfile"]["modelCapabilities"].is_null());
    let (status, keyed) = harness
        .post(control(
            "agent.account.api.configure",
            obj(json!({"accountId": id, "apiKey": format!(" {SECRET} ")})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{keyed}");
    assert!(account(&keyed, &id).unwrap()["apiValidation"].is_null());

    // Testing a plain managed (non-profile) account is a 400.
    let (_, managed) = harness
        .post(control(
            "agent.account.create",
            obj(json!({"agent": "claude", "name": "plain"})),
        ))
        .await;
    let plain_id = managed["accountId"].as_str().unwrap();
    let (status, _) = harness
        .post(control(
            "agent.account.api.test",
            obj(json!({"accountId": plain_id})),
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn profile_turns_receive_only_the_profile_environment() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let server = FakeServer::new(ProbeMode::Success, vec![]);
    let id = create_profile(&harness, &server).await;

    let workspace = harness.directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let (_, session) = harness
        .post_path(
            "/v1/agent-sessions",
            json!({
                "title": "Claude",
                "workspace": workspace.to_str().unwrap(),
                "autoApprove": false,
                "accountId": id,
            }),
        )
        .await;
    let session_id = session["id"].as_str().unwrap().to_owned();
    let capture = harness.directory.path().join("turn.json");
    unsafe {
        std::env::set_var("CAPTURE", &capture);
    }
    let (status, _) = harness
        .post_path(
            &format!("/v1/agent-sessions/{session_id}/send"),
            json!({"text": "hi"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let dumped = async {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            if let Ok(body) = std::fs::read_to_string(&capture) {
                break serde_json::from_str::<Value>(&body).unwrap();
            }
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
    .await;
    let env = &dumped["env"];
    assert_eq!(env["ANTHROPIC_API_KEY"], SECRET);
    assert_eq!(env["ANTHROPIC_BASE_URL"], server.base_url);
    assert_eq!(env["ANTHROPIC_MODEL"], "fakemodel-1");
    assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "");
    assert_eq!(env["CLAUDE_CODE_OAUTH_TOKEN"], "");
    assert_eq!(
        env["CLAUDE_CONFIG_DIR"],
        harness.account_root(&id).to_str().unwrap()
    );
    assert_eq!(env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1");
}

fn two_pages() -> Vec<Value> {
    vec![
        json!({
            "data": [
                {"id":"m-002","display_name":"Model Two","owned_by":"acme",
                 "max_input_tokens":200000,"max_tokens":8192,
                 "capabilities":{"tools":true,"image_input":{"supported":false},"thinking":true}},
                {"id":"m-001","name":"Model One","description":"first"},
            ],
            "has_more": true,
            "last_id": "m-002",
        }),
        json!({"data":[{"id":"m-003"}]}),
    ]
}

#[tokio::test]
async fn models_catalog_follows_pagination_and_maps_rows() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let server = FakeServer::new(ProbeMode::Success, two_pages());
    let id = create_profile(&harness, &server).await;

    // Stored-account path.
    let (status, result) = harness
        .post(control(
            "agent.account.api.models.get",
            obj(json!({"accountId": id})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["type"], "agent.account.api.models.result");
    assert_eq!(result["ok"], true);
    let ids: Vec<&str> = result["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect();
    // Sorted, deduplicated across pages.
    assert_eq!(ids, ["m-001", "m-002", "m-003"]);
    let m2 = result["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "m-002")
        .unwrap();
    assert_eq!(m2["label"], "Model Two");
    assert_eq!(m2["owner"], "acme");
    assert_eq!(m2["modelCapabilities"]["contextWindow"], 200000);
    assert_eq!(m2["modelCapabilities"]["maxOutputTokens"], 8192);
    assert_eq!(m2["modelCapabilities"]["tools"], true);
    assert_eq!(m2["modelCapabilities"]["vision"], false);
    assert_eq!(m2["modelCapabilities"]["reasoning"], true);
    assert_eq!(server.state.models_hits.load(Ordering::SeqCst), 2);

    // Draft path with a pasted /v1/models suffix; no account attached.
    let draft_base = format!("{}/v1/models", server.base_url);
    let (status, draft) = harness
        .post(control(
            "agent.account.api.models.get",
            obj(json!({"baseUrl": draft_base, "apiKey": SECRET})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{draft}");
    assert_eq!(draft["ok"], true);
    assert!(!draft["models"].as_array().unwrap().is_empty());

    // Extra draft fields alongside an accountId are ignored (stored row wins),
    // and OpenAI-compatible draft protocols use Bearer authentication.
    let (status, result) = harness
        .post(control(
            "agent.account.api.models.get",
            obj(json!({"accountId": id, "baseUrl": server.base_url, "apiKey": SECRET})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["ok"], true);
    let (_, result) = harness
        .post(control(
            "agent.account.api.models.get",
            obj(json!({
                "protocol": "openai_responses",
                "baseUrl": server.base_url,
                "apiKey": SECRET,
            })),
        ))
        .await;
    assert_eq!(result["ok"], true);
    assert!(!result["models"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn models_catalog_uses_bearer_auth_for_openai_profiles() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let server = FakeServer::new(ProbeMode::Success, vec![json!({"data":[{"id":"m1"}]})]);

    let (status, result) = harness
        .post(control(
            "agent.account.api.create",
            obj(json!({"agent":"codex",
                "name":"Codex Profile","baseUrl":format!("{}/responses", server.base_url),
                "model":"gpt-test","apiKey":SECRET})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let account_id = result["accountId"].as_str().unwrap();

    let (status, models) = harness
        .post(control(
            "agent.account.api.models.get",
            obj(json!({"accountId":account_id})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{models}");
    assert_eq!(models["ok"], true);
    assert_eq!(models["models"][0]["id"], "m1");
}

#[tokio::test]
async fn models_catalog_feature_errors_stay_in_body_with_stable_codes() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let server = FakeServer::new(ProbeMode::Success, vec![]);
    create_profile(&harness, &server).await;

    // Native row is an in-body unsupported error (HTTP still 200).
    let (status, result) = harness
        .post(control(
            "agent.account.api.models.get",
            obj(json!({"accountId": "native-claude"})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["ok"], false);
    assert_eq!(result["error"]["code"], "unsupported");

    // Local validation failures (blank key) are also in-body.
    let (status, result) = harness
        .post(control(
            "agent.account.api.models.get",
            obj(json!({"baseUrl": server.base_url, "apiKey": ""})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["error"]["code"], "invalid_request");

    // Unreachable endpoint → network.
    let (_, result) = harness
        .post(control(
            "agent.account.api.models.get",
            obj(json!({"baseUrl": "http://127.0.0.1:1", "apiKey": SECRET})),
        ))
        .await;
    assert_eq!(result["ok"], false);
    assert_eq!(result["error"]["code"], "network");

    // Auth failure page → authentication.
    let auth_server = FakeServer::new(ProbeMode::AuthFail, vec![]);
    let (_, result) = harness
        .post(control(
            "agent.account.api.models.get",
            obj(json!({"baseUrl": auth_server.base_url, "apiKey": SECRET})),
        ))
        .await;
    assert_eq!(result["error"]["code"], "authentication");

    // Malformed JSON page → invalid_format.
    let bad_server = FakeServer::new(ProbeMode::Success, vec![json!({"not-data": true})]);
    let (_, result) = harness
        .post(control(
            "agent.account.api.models.get",
            obj(json!({"baseUrl": bad_server.base_url, "apiKey": SECRET})),
        ))
        .await;
    assert_eq!(result["error"]["code"], "invalid_format");

    // Empty catalog → empty_catalog.
    let empty_server = FakeServer::new(ProbeMode::Success, vec![json!({"data": []})]);
    let (_, result) = harness
        .post(control(
            "agent.account.api.models.get",
            obj(json!({"baseUrl": empty_server.base_url, "apiKey": SECRET})),
        ))
        .await;
    assert_eq!(result["error"]["code"], "empty_catalog");

    // Stored id that is not a profile → unsupported.
    let (_, managed) = harness
        .post(control(
            "agent.account.create",
            obj(json!({"agent": "claude", "name": "plain"})),
        ))
        .await;
    let plain_id = managed["accountId"].as_str().unwrap();
    let (_, result) = harness
        .post(control(
            "agent.account.api.models.get",
            obj(json!({"accountId": plain_id})),
        ))
        .await;
    assert_eq!(result["error"]["code"], "unsupported");
}

#[tokio::test]
async fn account_config_get_set_and_rejects_unsafe_writes() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let server = FakeServer::new(
        ProbeMode::Success,
        vec![json!({"data":[{"id":"fakemodel-1"}]})],
    );
    let (status, created) = harness
        .post(control(
            "agent.account.api.create",
            obj(json!({
                "agent": "claude",
                "name": "Config Profile",
                "baseUrl": server.base_url,
                "model": "fakemodel-1",
                "apiKey": SECRET,
                "modelCapabilities": {"reasoning": true, "supportedEfforts": ["low", "high"]}
            })),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["accountId"].as_str().unwrap().to_owned();

    let (status, current) = harness
        .post(control(
            "agent.account.config.get",
            obj(json!({"accountId": id})),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{current}");
    assert_eq!(current["type"], "agent.account.config.result");
    assert_eq!(current["ok"], true);
    assert_eq!(current["config"]["accountId"], id);
    assert_eq!(current["config"]["appliesTo"], "new_sessions");
    assert_eq!(current["config"]["activeSessions"], 0);
    assert_eq!(
        current["config"]["supportedEfforts"],
        json!(["low", "high"])
    );
    let document = current["config"]["documents"][0].clone();
    assert_eq!(document["id"], "claude-overrides");
    assert_eq!(document["format"], "yaml");
    assert_eq!(document["editableKeys"], json!(["default_effort"]));

    let (status, saved) = harness
        .post(control(
            "agent.account.config.set",
            obj(json!({
                "accountId": id,
                "documentId": document["id"],
                "revision": document["revision"],
                "defaultEffort": "high"
            })),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["ok"], true);
    assert_eq!(saved["config"]["defaultEffort"], "high");
    assert!(
        saved["config"]["documents"][0]["content"]
            .as_str()
            .unwrap()
            .contains("high")
    );

    let (status, stale) = harness
        .post(control(
            "agent.account.config.set",
            obj(json!({
                "accountId": id,
                "documentId": document["id"],
                "revision": document["revision"],
                "defaultEffort": "low"
            })),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{stale}");
    assert_eq!(stale["ok"], false);
    assert_eq!(stale["error"]["code"], "conflict");

    let revision = saved["config"]["documents"][0]["revision"]
        .as_str()
        .unwrap();
    let (status, denied) = harness
        .post(control(
            "agent.account.config.set",
            obj(json!({
                "accountId": id,
                "documentId": "auth",
                "revision": revision,
                "content": ""
            })),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{denied}");
    assert_eq!(denied["ok"], false);
    assert_eq!(denied["error"]["code"], "forbidden");

    let (status, invalid) = harness
        .post(control(
            "agent.account.config.set",
            obj(json!({
                "accountId": id,
                "documentId": "claude-overrides",
                "revision": revision,
                "content": "ANTHROPIC_API_KEY: private-secret\n"
            })),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{invalid}");
    assert_eq!(invalid["ok"], false);
    assert_eq!(invalid["error"]["code"], "invalid_config");
    assert!(!invalid.to_string().contains("private-secret"));
}
