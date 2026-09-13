#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use prosperod_rs::{auth::Token, server::Api, worker::Database};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const SECRET: &str = "sk-prospero-source-secret-0123456789";
const BEARER: &str = "Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn write_cli(directory: &std::path::Path) -> std::path::PathBuf {
    let script = r#"#!/usr/bin/env python3
import json, sys
if sys.argv[1:] == ["--version"]:
    print("1.2.3-fake")
    sys.exit(0)
if sys.argv[1:] == ["auth", "status", "--json"]:
    sys.exit(0)
timeout = True
"#;
    let cli = directory.join("fake-claude-source.py");
    std::fs::write(&cli, script).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    cli
}

#[derive(Clone)]
struct CatalogState {
    hits: Arc<AtomicUsize>,
    body: Arc<Mutex<Value>>,
}

async fn models(State(state): State<CatalogState>) -> axum::response::Response {
    state.hits.fetch_add(1, Ordering::SeqCst);
    (
        StatusCode::OK,
        [("content-type", "application/json")],
        state.body.lock().unwrap().to_string(),
    )
        .into_response()
}

struct FakeServer {
    base_url: String,
    hits: Arc<AtomicUsize>,
}

fn spawn_server() -> FakeServer {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = CatalogState {
        hits: Arc::new(AtomicUsize::new(0)),
        body: Arc::new(Mutex::new(
            json!({"data":[{"id":"claude-test","display_name":"Claude Test","capabilities":{"tools":true}}]}),
        )),
    };
    let hits = state.hits.clone();
    let app = axum::Router::new()
        .route("/v1/models", get(models))
        .with_state(state);
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        axum::serve(listener, app).await.unwrap();
    });
    FakeServer {
        base_url: format!("http://127.0.0.1:{port}"),
        hits,
    }
}

struct Harness {
    directory: TempDir,
    app: axum::Router,
}

impl Harness {
    async fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let cli = write_cli(directory.path());
        unsafe {
            std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
        }
        let database = Database::open(directory.path().join("daemon"))
            .await
            .unwrap();
        let api = Api::new(
            database,
            Token::parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into())
                .unwrap(),
        );
        Self {
            directory,
            app: api.router(),
        }
    }

    async fn post(&self, payload: Value) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/model-sources")
                    .header("authorization", BEARER)
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
}

impl Drop for Harness {
    fn drop(&mut self) {
        unsafe {
            std::env::remove_var("PROSPERO_CLAUDE_BIN");
        }
    }
}

fn envelope(action: Value) -> Value {
    json!({"type":"model.source.action","requestId":"req","action":action})
}

#[tokio::test]
async fn source_create_list_models_bind_and_delete_flow() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let server = spawn_server();

    let (status, result) = harness.post(envelope(json!({
        "kind":"create",
        "operationId":"op-create",
        "name":" Shared Claude ",
        "endpoints":[{"protocol":"anthropic","baseUrl":server.base_url}],
        "credential":{"name":"Main Key","apiKey":SECRET},
        "routes":[{"name":"Claude Test","model":"claude-test","protocol":"anthropic","enabled":true,"modelCapabilities":{"tools":true,"reasoning":true,"supportedEfforts":["low"]},"defaultEffort":"low"}]
    }))).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert!(result.to_string().contains("Shared Claude"));
    assert!(!result.to_string().contains(SECRET));
    let source = &result["sources"][0];
    let source_id = source["id"].as_str().unwrap();
    let route_id = source["routes"][0]["id"].as_str().unwrap();
    let credential_id = source["credentials"][0]["id"].as_str().unwrap();
    let revision = source["revision"].as_i64().unwrap();

    let registry = harness
        .directory
        .path()
        .join("daemon/model-sources/.registry.json");
    assert_eq!(
        std::fs::metadata(registry).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let (status, listed) = harness.post(envelope(json!({"kind":"list"}))).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["sources"].as_array().unwrap().len(), 1);

    let (status, catalog) = harness.post(envelope(json!({"kind":"models","sourceId":source_id,"revision":revision,"protocol":"anthropic","credentialId":credential_id}))).await;
    assert_eq!(status, StatusCode::OK, "{catalog}");
    assert_eq!(catalog["models"][0]["id"], "claude-test");
    assert_eq!(server.hits.load(Ordering::SeqCst), 1);

    let (status, bound) = harness
        .post(envelope(
            json!({"kind":"bind","sourceId":source_id,"routeId":route_id,"revision":revision}),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{bound}");
    let account_id = bound["accountId"].as_str().unwrap();
    let account = bound["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == account_id)
        .unwrap();
    assert_eq!(account["apiProfile"]["model"], "claude-test");
    assert_eq!(account["modelSource"]["sourceId"], source_id);
    assert_eq!(account["modelSource"]["routeId"], route_id);
    assert_eq!(account["modelSource"]["legacy"], false);

    let (status, blocked) = harness
        .post(envelope(
            json!({"kind":"delete","sourceId":source_id,"revision":revision}),
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{blocked}");
    assert_eq!(blocked["code"], "in_use");
}
