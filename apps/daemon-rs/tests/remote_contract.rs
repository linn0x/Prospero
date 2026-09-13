use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use prosperod_rs::auth::Token;
use prosperod_rs::protocol::{API_VERSION, DATABASE_QUEUE_CAPACITY};
use prosperod_rs::server::Api;
use prosperod_rs::worker::Database;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async fn fixture() -> (TempDir, Api) {
    let directory = TempDir::new().unwrap();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    (
        directory,
        Api::new(database, Token::parse(SECRET.into()).unwrap()),
    )
}

async fn health(api: &Api) -> (StatusCode, Value) {
    let response = api
        .router()
        .oneshot(
            Request::builder()
                .uri("/v1/health")
                .header("authorization", format!("Bearer {SECRET}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    (status, body)
}

#[tokio::test]
async fn health_dto_reports_rust_http_contract() {
    let (_directory, api) = fixture().await;
    let (status, body) = health(&api).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["apiVersion"], json!(API_VERSION));
    assert_eq!(body["backend"], "rust");
    assert_eq!(body["activeRuntimeSessions"], 0);
    assert_eq!(
        body["databaseQueueCapacity"],
        json!(DATABASE_QUEUE_CAPACITY)
    );
    assert!(body["capabilities"].as_array().unwrap().len() > 5);
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn health_capabilities_are_explicitly_local_http_not_mobile_ws() {
    let (_directory, api) = fixture().await;
    let (_status, body) = health(&api).await;
    let capabilities = body["capabilities"].as_array().unwrap();
    for expected in [
        "session.metadata",
        "session.search",
        "session.timeline",
        "events.stream",
        "agent.api-protocols.v1",
        "agent.api-validation.v1",
        "agent.account.api.models",
        "model.sources.v1",
    ] {
        assert!(
            capabilities.iter().any(|capability| capability == expected),
            "missing health capability {expected}"
        );
    }
    for remote_only in [
        "session.create-result.v1",
        "fs.put-ack.v1",
        "workspace.summary.v1",
        "agent.accounts.v1",
        "orchestration.snapshot.v1",
        "orchestration.manual.v1",
    ] {
        assert!(
            !capabilities
                .iter()
                .any(|capability| capability == remote_only),
            "Rust local health must not imply unimplemented mobile/remote WS capability {remote_only}"
        );
    }
    api.database.shutdown().await.unwrap();
}
