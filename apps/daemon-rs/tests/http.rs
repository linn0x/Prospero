use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use futures_util::StreamExt;
use prosperod_rs::auth::Token;
use prosperod_rs::protocol::{
    AgentKind, CreateSession, MessageRole, SessionKind, TimelineBody, TimelineWrite,
};
use prosperod_rs::server::Api;
use prosperod_rs::worker::Database;
use serde_json::{Value, json};
use std::time::Duration;
use tempfile::TempDir;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async fn fixture() -> (TempDir, Api, String) {
    let directory = TempDir::new().unwrap();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    let head = database
        .call(|store| {
            store.create_session(CreateSession {
                agent: AgentKind::Codex,
                kind: SessionKind::Structured,
                title: "Example".into(),
                workspace: "/synthetic".into(),
            })
        })
        .await
        .unwrap();
    (
        directory,
        Api::new(database, Token::parse(SECRET.into()).unwrap()),
        head.id,
    )
}

fn request(uri: &str) -> axum::http::request::Builder {
    Request::builder()
        .uri(uri)
        .header("authorization", format!("Bearer {SECRET}"))
}

async fn body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}

#[tokio::test]
async fn every_endpoint_requires_auth_and_rejects_browser_origins() {
    let (_directory, api, _) = fixture().await;
    for uri in [
        "/v1/health",
        "/v1/sessions",
        "/v1/sessions/summary",
        "/v1/sessions/lookup",
        "/v1/workspaces",
        "/v1/sessions/example/timeline",
        "/v1/sessions/example/timeline/entry/body",
        "/v1/terminals",
        "/v1/terminals/example/output",
        "/v1/terminals/example/input",
        "/v1/terminals/example/resize",
        "/v1/terminals/example/close",
        "/v1/events?scope=sessions",
        "/unknown",
    ] {
        let response = api
            .router()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body(response).await["code"], "unauthorized");
    }
    let response = api
        .router()
        .oneshot(
            request("/v1/health")
                .header("origin", "https://example.invalid")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = api
        .router()
        .oneshot(
            request("/v1/health")
                .header("authorization", format!("Bearer {SECRET}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn rename_commits_then_replays_without_exposing_a_global_snapshot() {
    let (_directory, api, id) = fixture().await;
    let response = api
        .router()
        .oneshot(request("/v1/sessions?limit=1").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let page = body(response).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["id"], id);
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}"))
                .method("PATCH")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"revision":1,"title":"Renamed"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["revision"], 2);
    let response = api
        .router()
        .oneshot(
            request("/v1/events?scope=sessions&afterSeq=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let page = body(response).await;
    assert_eq!(page["items"][0]["kind"], "session.updated");
    assert_eq!(page["items"][0]["data"]["title"], "Renamed");
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}"))
                .method("PATCH")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"revision":1,"title":"Stale"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn invalid_queries_and_unknown_mutations_are_rejected() {
    let (_directory, api, id) = fixture().await;
    for uri in [
        "/v1/sessions?limit=201",
        "/v1/sessions?unexpected=true",
        "/v1/sessions?workspace=",
        "/v1/sessions?text=%2A",
        "/v1/sessions/summary?unexpected=true",
        "/v1/workspaces?limit=201",
        "/v1/events?scope=sessions&afterSeq=-1",
        "/v1/events?scope=sessions&afterSeq=100",
        "/v1/events?scope=sessions&limit=0",
    ] {
        let response = api
            .router()
            .oneshot(request(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");
    }
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}"))
                .method("PATCH")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"revision":1,"title":"Changed","status":"running"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn content_is_binary_and_bounded() {
    let (_directory, api, id) = fixture().await;
    let saved = id.clone();
    api.database
        .call(move |store| store.append_content(&saved, "history", 0, b"hello"))
        .await
        .unwrap();
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/content/history?offset=0"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.headers()["content-type"],
        "application/octet-stream"
    );
    assert_eq!(response.headers()["x-next-offset"], "5");
    assert_eq!(
        &to_bytes(response.into_body(), 10).await.unwrap()[..],
        b"hello"
    );
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn stream_replays_then_delivers_committed_changes_and_stops() {
    let (_directory, api, id) = fixture().await;
    let response = api
        .router()
        .oneshot(
            request("/v1/events/stream?scope=sessions&afterSeq=0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.into_body().into_data_stream();
    let connected = tokio::time::timeout(Duration::from_secs(1), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        String::from_utf8(connected.to_vec())
            .unwrap()
            .contains("connected")
    );
    let first = tokio::time::timeout(Duration::from_secs(1), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let text = String::from_utf8(first.to_vec()).unwrap();
    assert!(text.contains("id: 1"));
    assert!(text.contains("session.created"));
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}"))
                .method("PATCH")
                .header("content-type", "application/json")
                .body(Body::from(json!({"revision":1,"title":"Live"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let next = tokio::time::timeout(Duration::from_secs(1), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        String::from_utf8(next.to_vec())
            .unwrap()
            .contains("session.updated")
    );
    api.stop();
    assert!(
        tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .is_none()
    );
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn stream_limit_is_released_when_responses_are_dropped() {
    let (_directory, api, _) = fixture().await;
    let mut streams = Vec::new();
    for _ in 0..16 {
        let response = api
            .router()
            .oneshot(
                request("/v1/events/stream?scope=sessions&afterSeq=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        streams.push(response);
    }
    let response = api
        .router()
        .oneshot(
            request("/v1/events/stream?scope=sessions&afterSeq=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    drop(streams.pop());
    let response = api
        .router()
        .oneshot(
            request("/v1/events/stream?scope=sessions&afterSeq=1")
                .header("last-event-id", "1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    drop(response);
    drop(streams);
    api.stop();
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn timeline_routes_expose_previews_and_generation_checked_body_pages() {
    let (_directory, api, id) = fixture().await;
    let saved = id.clone();
    api.database
        .call(move |store| {
            store.write_timeline(
                &saved,
                TimelineWrite {
                    id: "message".into(),
                    turn_id: "turn".into(),
                    expected_revision: 0,
                    body: TimelineBody::Message {
                        role: MessageRole::Assistant,
                        final_answer: true,
                    },
                    text: "中🦀".repeat(5000),
                    replace: false,
                },
            )
        })
        .await
        .unwrap();
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/timeline"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let page = body(response).await;
    assert_eq!(page["items"][0]["truncated"], true);
    assert_eq!(page["items"][0]["body"]["finalAnswer"], true);
    let response = api
        .router()
        .oneshot(
            request(&format!(
                "/v1/sessions/{id}/timeline/message/body?generation=1"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(body(response).await["text"], "中🦀".repeat(5000));
    let response = api
        .router()
        .oneshot(
            request(&format!(
                "/v1/sessions/{id}/timeline/message/body?generation=2"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/timeline?before=2&after=1"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    api.database.shutdown().await.unwrap();
}
