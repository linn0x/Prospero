#![cfg(unix)]
//! Launch model catalog tests. The catalog handshake spawns the CLI without a
//! workspace cwd, so a dedicated fake script answers the `initialize`
//! control_request; PROSPERO_CLAUDE_BIN is process-global and tests serialize.

use std::os::unix::fs::PermissionsExt;

use prosperod_rs::{agent::Agents, auth::Token, server::Api, worker::Database};
use serde_json::json;
use tempfile::TempDir;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct EnvGuard;
impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            std::env::remove_var("PROSPERO_CLAUDE_BIN");
            std::env::remove_var("PROSPERO_CODEX_BIN");
        }
    }
}

/// Writes a fake CLI that requires the exact catalog argv, reads one stdin
/// frame, and replies per `mode`:
/// - "ok": a success control_response carrying two models
/// - "empty": a success envelope with no models
/// - "error": an error envelope
/// - "garbage": never emits parseable JSON (exits after stdin closes)
fn write_cli(directory: &std::path::Path, mode: &str) -> std::path::PathBuf {
    let script = format!(
        r#"#!/usr/bin/env python3
import json, sys

expected = ["-p", "--output-format", "stream-json",
            "--input-format", "stream-json", "--verbose"]
if sys.argv[1:] != expected:
    sys.exit(3)

line = sys.stdin.readline()
frame = json.loads(line)
assert frame["type"] == "control_request", frame
assert frame["request"]["subtype"] == "initialize", frame
request_id = frame["request_id"]

mode = {mode:?}
if mode == "ok":
    sys.stdout.write(json.dumps({{
        "type": "control_response",
        "response": {{
            "subtype": "success",
            "request_id": request_id,
            "response": {{
                "session_state": "idle",
                "models": [
                    {{"value": "default", "resolvedModel": "claude-default",
                     "displayName": "Default",
                     "supportedEffortLevels": ["low", "medium", "high"]}},
                    {{"value": "opus[1m]",
                     "displayName": "Opus (1M context)",
                     "description": "long context",
                     "supportsEffort": True,
                     "supportedEffortLevels": ["low", "high", "max"]}},
                ],
            }},
        }},
    }}) + "\n")
    sys.stdout.flush()
elif mode == "empty":
    sys.stdout.write(json.dumps({{
        "type": "control_response",
        "response": {{"subtype": "success", "request_id": request_id,
                      "response": {{"models": []}}}},
    }}) + "\n")
    sys.stdout.flush()
elif mode == "error":
    sys.stdout.write(json.dumps({{
        "type": "control_response",
        "response": {{"subtype": "error", "request_id": request_id,
                      "message": "boom"}},
    }}) + "\n")
    sys.stdout.flush()
elif mode == "garbage":
    pass
sys.exit(0)
"#
    );
    let cli = directory.join("fake-catalog.py");
    std::fs::write(&cli, script).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    cli
}

fn write_codex(directory: &std::path::Path) -> std::path::PathBuf {
    let cli = directory.join("fake-codex-models.py");
    std::fs::write(
        &cli,
        r#"#!/usr/bin/env python3
import json, sys
if sys.argv[1:] != ["app-server"]:
    sys.exit(3)
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    rid = msg["id"]
    method = msg.get("method")
    if method == "model/list":
        result = {"data": [{"model": "gpt-test", "displayName": "GPT Test", "supportedReasoningEfforts": ["low", "high"], "isDefault": True}]}
    else:
        result = {}
    sys.stdout.write(json.dumps({"id": rid, "result": result}) + "\n")
    sys.stdout.flush()
"#,
    )
    .unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    cli
}

async fn open_db() -> (TempDir, Database) {
    let directory = TempDir::new().unwrap();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    (directory, database)
}

#[tokio::test]
async fn initialize_handshake_returns_the_model_catalog() {
    let _guard = SERIAL.lock().await;
    let _env = EnvGuard;
    let (directory, _database) = open_db().await;
    let cli = write_cli(directory.path(), "ok");
    let codex = write_codex(directory.path());
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
        std::env::set_var("PROSPERO_CODEX_BIN", &codex);
    }

    let catalog = Agents::launch_catalog().await.unwrap();
    assert_eq!(catalog.models.len(), 2);
    assert_eq!(catalog.current_model.as_deref(), Some("default"));
    let first = &catalog.models[0];
    assert_eq!(first.id, "default");
    assert_eq!(first.label, "Default");
    assert_eq!(first.description, None);
    assert_eq!(first.supported_efforts, vec!["low", "medium", "high"]);
    assert!(first.is_default);
    let second = &catalog.models[1];
    assert_eq!(second.id, "opus[1m]");
    assert_eq!(second.label, "Opus (1M context)");
    assert_eq!(second.description.as_deref(), Some("long context"));
    assert_eq!(second.supported_efforts, vec!["low", "high", "max"]);
    assert!(!second.is_default);
}

#[tokio::test]
async fn catalog_failures_are_rejected_not_fabricated() {
    let _guard = SERIAL.lock().await;
    let _env = EnvGuard;
    let (directory, _database) = open_db().await;

    for mode in ["empty", "error", "garbage"] {
        let cli = write_cli(directory.path(), mode);
        unsafe {
            std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
        }
        let result = Agents::launch_catalog().await;
        assert!(result.is_err(), "mode {mode} must fail the catalog fetch");
    }

    let missing = directory.path().join("definitely-not-claude");
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &missing);
    }
    assert!(Agents::launch_catalog().await.is_err());
}

#[tokio::test]
async fn http_route_serves_native_and_managed_claude_accounts() {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    let _guard = SERIAL.lock().await;
    let _env = EnvGuard;
    let (directory, database) = open_db().await;
    let cli = write_cli(directory.path(), "ok");
    let codex = write_codex(directory.path());
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
        std::env::set_var("PROSPERO_CODEX_BIN", &codex);
    }
    let api = Api::new(
        database,
        Token::parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into())
            .unwrap(),
    );
    let app = api.router();
    let secret = "Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/launch/models?agent=claude&accountId=native-claude")
                .header("authorization", secret)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["models"].as_array().unwrap().len(), 2);
    assert_eq!(value["currentModel"], "default");

    // Missing accountId defaults to the native account, so the catalog
    // resolves. Unknown agents remain 400; an unknown managed id is a 404.
    let native_default = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/launch/models?agent=claude")
                .header("authorization", secret)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(native_default.status(), StatusCode::OK);

    let codex_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/launch/models?agent=codex&accountId=native-codex")
                .header("authorization", secret)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(codex_response.status(), StatusCode::OK);
    let codex_body = axum::body::to_bytes(codex_response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let codex_value: serde_json::Value = serde_json::from_slice(&codex_body).unwrap();
    assert_eq!(codex_value["models"][0]["id"], "gpt-test");
    assert_eq!(codex_value["currentModel"], "gpt-test");

    for uri in ["/v1/launch/models?agent=deepseek"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(uri)
                    .header("authorization", secret)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "uri {uri} must be rejected"
        );
    }

    let missing_managed = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/launch/models?agent=claude&accountId=managed-x")
                .header("authorization", secret)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing_managed.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn http_route_serves_codex_api_profile_pinned_model() {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    let _guard = SERIAL.lock().await;
    let _env = EnvGuard;
    let (_directory, database) = open_db().await;
    let api = Api::new(
        database,
        Token::parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into())
            .unwrap(),
    );
    let app = api.router();
    let secret = "Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    let created = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/accounts")
                .header("authorization", secret)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "type":"agent.account.api.create",
                        "requestId":"create-codex-profile",
                        "agent":"codex",
                        "name":"Codex API",
                        "baseUrl":"http://localhost:12345/responses",
                        "model":"gpt-profile",
                        "apiKey":"sk-profile-secret",
                        "modelCapabilities":{"supportedEfforts":["low","high"]}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let created_body = axum::body::to_bytes(created.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let created_value: serde_json::Value = serde_json::from_slice(&created_body).unwrap();
    let account_id = created_value["accountId"].as_str().unwrap();

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/v1/launch/models?agent=codex&accountId={account_id}"
                ))
                .header("authorization", secret)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["currentModel"], "gpt-profile");
    assert_eq!(value["models"][0]["id"], "gpt-profile");
    assert_eq!(
        value["models"][0]["supportedEfforts"],
        json!(["low", "high"])
    );

    let created = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/accounts")
                .header("authorization", secret)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "type":"agent.account.api.create",
                        "requestId":"create-opencode-profile",
                        "agent":"opencode",
                        "provider":"openai_compatible",
                        "protocol":"openai_chat_completions",
                        "name":"OpenCode API",
                        "baseUrl":"http://localhost:12345/chat/completions",
                        "model":"chat-profile",
                        "apiKey":"sk-profile-secret",
                        "modelCapabilities":{"contextWindow":32000,"maxOutputTokens":2048}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let created_body = axum::body::to_bytes(created.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let created_value: serde_json::Value = serde_json::from_slice(&created_body).unwrap();
    let account_id = created_value["accountId"].as_str().unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/v1/launch/models?agent=opencode&accountId={account_id}"
                ))
                .header("authorization", secret)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["currentModel"], "chat-profile");
    assert_eq!(value["models"][0]["id"], "chat-profile");
}

#[tokio::test]
async fn session_models_and_controls_routes_serve_persisted_selection() {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use prosperod_rs::agent::CreateAgentSession;
    use tower::ServiceExt;

    let _guard = SERIAL.lock().await;
    let _env = EnvGuard;
    let (directory, database) = open_db().await;
    let cli = write_cli(directory.path(), "ok");
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
    }
    let api = Api::new(
        database.clone(),
        Token::parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into())
            .unwrap(),
    );
    let app = api.router();
    let secret = "Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    let workspace = directory.path().to_str().unwrap();
    let head = api
        .agents
        .create(CreateAgentSession {
            agent: prosperod_rs::protocol::AgentKind::Claude,
            title: "Pick".into(),
            workspace: workspace.into(),
            auto_approve: false,
            mode: None,
            model: Some("opus[1m]".into()),
            effort: Some("high".into()),
            agent_preset: None,
            account_id: None,
            resume: None,
        })
        .await
        .unwrap();

    let request = |method: &str, uri: String, body: Body| {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", secret)
            .header("content-type", "application/json")
            .body(body)
            .unwrap()
    };

    let response = app
        .clone()
        .oneshot(request(
            "GET",
            format!("/v1/agent-sessions/{}/models", head.id),
            Body::empty(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["models"].as_array().unwrap().len(), 2);
    assert_eq!(value["currentModel"], "opus[1m]");
    assert_eq!(value["currentEffort"], "high");

    // Switch to the default model without an effort: validation happens
    // against the fresh catalog and the result drops currentEffort.
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            format!("/v1/agent-sessions/{}/models", head.id),
            Body::from(r#"{"model":"default"}"#),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["currentModel"], "default");
    assert!(value.get("currentEffort").is_none());

    // Unknown model / unsupported effort are rejected with 400.
    for payload in [
        r#"{"model":"ghost"}"#,
        r#"{"model":"opus[1m]","effort":"medium"}"#,
    ] {
        let response = app
            .clone()
            .oneshot(request(
                "POST",
                format!("/v1/agent-sessions/{}/models", head.id),
                Body::from(payload),
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "payload {payload}"
        );
    }

    let response = app
        .clone()
        .oneshot(request(
            "GET",
            "/v1/agent-sessions/controls".into(),
            Body::empty(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let row = value["controls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["sessionId"] == head.id)
        .unwrap();
    assert_eq!(row["model"], true);
    assert_eq!(row["mode"], true);
    assert_eq!(row["compact"], true);
    assert_eq!(row["currentModel"], "default");
    assert_eq!(row["currentMode"], "default");
}
