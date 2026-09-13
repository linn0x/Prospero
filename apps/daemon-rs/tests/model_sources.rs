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
        self.post_path("/v1/model-sources", payload).await
    }

    async fn post_path(&self, path: &str, payload: Value) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
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

fn account_envelope(request_id: &str, extra: Value) -> Value {
    let mut value = extra.as_object().unwrap().clone();
    value.insert("requestId".into(), Value::String(request_id.into()));
    Value::Object(value)
}

async fn create_api_profile(
    harness: &Harness,
    request_id: &str,
    name: &str,
    base_url: &str,
    model: &str,
    key: &str,
) -> String {
    let (status, result) = harness
        .post_path(
            "/v1/accounts",
            account_envelope(
                request_id,
                json!({
                    "type":"agent.account.api.create",
                    "agent":"claude",
                    "name":name,
                    "provider":"anthropic_compatible",
                    "protocol":"anthropic",
                    "baseUrl":base_url,
                    "model":model,
                    "apiKey":key,
                    "modelCapabilities":{"tools":true}
                }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    result["accountId"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn migration_preview_apply_and_rollback_profiles() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let server = spawn_server();
    let first =
        create_api_profile(&harness, "a1", "One", &server.base_url, "claude-a", SECRET).await;
    let second_key = "sk-second-source-secret-0123456789";
    let second = create_api_profile(
        &harness,
        "a2",
        "Two",
        &server.base_url,
        "claude-b",
        second_key,
    )
    .await;

    let (status, preview) = harness
        .post(envelope(json!({"kind":"migration.preview"})))
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let migrations = preview["migrations"].as_array().unwrap();
    assert_eq!(migrations.len(), 1, "{preview}");
    assert_eq!(migrations[0]["credentialCount"], 2);
    assert_eq!(migrations[0]["accounts"].as_array().unwrap().len(), 2);
    let migration_id = migrations[0]["id"].as_str().unwrap();

    let (status, applied) = harness
        .post(envelope(
            json!({"kind":"migration.apply","migrationId":migration_id,"name":"Migrated"}),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["sources"].as_array().unwrap().len(), 1);
    let routes = applied["sources"][0]["routes"].as_array().unwrap();
    assert_eq!(routes.len(), 2);
    let accounts = applied["accounts"].as_array().unwrap();
    for id in [&first, &second] {
        let account = accounts.iter().find(|row| row["id"] == *id).unwrap();
        assert_eq!(account["modelSource"]["legacy"], true);
        assert_eq!(account["modelSource"]["sourceName"], "Migrated");
    }

    let (status, second_preview) = harness
        .post(envelope(json!({"kind":"migration.preview"})))
        .await;
    assert_eq!(status, StatusCode::OK, "{second_preview}");
    assert_eq!(second_preview["migrations"].as_array().unwrap().len(), 0);

    let (status, rollback) = harness
        .post(envelope(
            json!({"kind":"migration.rollback","accountIds":[first, second]}),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{rollback}");
    assert!(
        rollback["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row.get("modelSource").is_none())
    );
}

#[tokio::test]
async fn migration_apply_rejects_active_profile_sessions() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let workspace = TempDir::new().unwrap();
    let server = spawn_server();
    let account_id = create_api_profile(
        &harness,
        "active",
        "Active",
        &server.base_url,
        "claude-active",
        SECRET,
    )
    .await;
    let response = harness
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/agent-sessions")
                .header("authorization", BEARER)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "title":"Active",
                        "workspace":workspace.path().to_str().unwrap(),
                        "autoApprove":false,
                        "accountId":account_id
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let (status, preview) = harness
        .post(envelope(json!({"kind":"migration.preview"})))
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let migration_id = preview["migrations"][0]["id"].as_str().unwrap();
    let (status, applied) = harness
        .post(envelope(
            json!({"kind":"migration.apply","migrationId":migration_id,"name":"Blocked"}),
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{applied}");
    assert_eq!(applied["code"], "in_use");
}
