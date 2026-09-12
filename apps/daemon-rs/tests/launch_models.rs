#![cfg(unix)]
//! Launch model catalog tests. The catalog handshake spawns the CLI without a
//! workspace cwd, so a dedicated fake script answers the `initialize`
//! control_request; PROSPERO_CLAUDE_BIN is process-global and tests serialize.

use std::os::unix::fs::PermissionsExt;

use prosperod_rs::{agent::Agents, auth::Token, server::Api, worker::Database};
use tempfile::TempDir;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct EnvGuard;
impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            std::env::remove_var("PROSPERO_CLAUDE_BIN");
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
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
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
async fn http_route_serves_only_native_claude() {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    let _guard = SERIAL.lock().await;
    let _env = EnvGuard;
    let (directory, database) = open_db().await;
    let cli = write_cli(directory.path(), "ok");
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
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

    for uri in [
        "/v1/launch/models?agent=codex&accountId=native-codex",
        "/v1/launch/models?agent=deepseek",
        "/v1/launch/models?agent=claude",
        "/v1/launch/models?agent=claude&accountId=managed-x",
    ] {
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
}
