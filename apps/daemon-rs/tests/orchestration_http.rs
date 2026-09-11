//! Stage 7 HTTP surface: the DAG routes are wired to the store and return the
//! same JSON contract as the generated `rust-daemon.ts`.

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use prosperod_rs::auth::Token;
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

async fn send(api: &Api, method: &str, uri: &str, payload: Option<Value>) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {SECRET}"));
    let body = match payload {
        Some(value) => {
            builder = builder.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = api
        .router()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
}

fn graph_body() -> Value {
    json!({
        "objective": "ship over http",
        "operationId": "http-op-1",
        "nodes": [
            {"clientId": "a", "title": "A", "spec": "do a"},
            {"clientId": "b", "title": "B", "spec": "do b", "deps": ["a"]}
        ]
    })
}

#[tokio::test]
async fn dag_lifecycle_runs_through_the_http_routes() {
    let (_directory, api) = fixture().await;

    // Create.
    let (status, created) = send(&api, "POST", "/v1/runs/graph", Some(graph_body())).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let run_id = created["run"]["id"].as_str().unwrap().to_owned();
    let task_a = created["idMap"]["a"].as_str().unwrap().to_owned();
    let task_b = created["idMap"]["b"].as_str().unwrap().to_owned();

    // Idempotent replay over HTTP returns the same run, never a second one.
    let (_status, replay) = send(&api, "POST", "/v1/runs/graph", Some(graph_body())).await;
    assert_eq!(replay["run"]["id"], run_id);
    let (status, runs) = send(&api, "GET", "/v1/runs", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(runs.as_array().unwrap().len(), 1);

    // Snapshot: only a is ready.
    let (status, snapshot) = send(&api, "GET", &format!("/v1/runs/{run_id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["ready"], json!([task_a]));
    assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 2);

    let (status, ready) = send(&api, "GET", &format!("/v1/runs/{run_id}/ready"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ready.as_array().unwrap().len(), 1);

    // Dispatch b before a is done → 400.
    let (status, _) = send(
        &api,
        "POST",
        &format!("/v1/tasks/{task_b}/dispatch"),
        Some(json!({"sessionId": "sess-http-b0001"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Dispatch a, mark running, settle.
    let (status, outcome) = send(
        &api,
        "POST",
        &format!("/v1/tasks/{task_a}/dispatch"),
        Some(json!({"sessionId": "sess-http-a0001", "operationId": "http-start-a"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{outcome}");
    let dispatch_a = outcome["dispatch"]["id"].as_str().unwrap().to_owned();
    assert_eq!(outcome["task"]["status"], "dispatched");

    let (status, running) = send(
        &api,
        "POST",
        &format!("/v1/dispatches/{dispatch_a}/running"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{running}");
    assert_eq!(running["state"], "running");

    let (status, settled) = send(
        &api,
        "POST",
        &format!("/v1/dispatches/{dispatch_a}/settle"),
        Some(json!({"success": true, "outcome": "shipped"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{settled}");
    assert_eq!(settled["task"]["status"], "done");

    // Duplicate start replay returns the same dispatch id.
    let (_, replay_start) = send(
        &api,
        "POST",
        &format!("/v1/tasks/{task_a}/dispatch"),
        Some(json!({"sessionId": "sess-http-a0001", "operationId": "http-start-a"})),
    )
    .await;
    assert_eq!(replay_start["dispatch"]["id"], dispatch_a);

    // b is now ready; complete its chain and finish the run.
    let (_, outcome_b) = send(
        &api,
        "POST",
        &format!("/v1/tasks/{task_b}/dispatch"),
        Some(json!({"sessionId": "sess-http-b0002"})),
    )
    .await;
    let dispatch_b = outcome_b["dispatch"]["id"].as_str().unwrap().to_owned();
    let (status, _) = send(
        &api,
        "POST",
        &format!("/v1/dispatches/{dispatch_b}/settle"),
        Some(json!({"success": true, "outcome": "shipped"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, completed) = send(
        &api,
        "POST",
        &format!("/v1/runs/{run_id}/complete"),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{completed}");
    assert_eq!(completed["status"], "completed");
}

#[tokio::test]
async fn gates_and_messages_flow_through_the_http_routes() {
    let (_directory, api) = fixture().await;
    let (_, created) = send(&api, "POST", "/v1/runs/graph", Some(graph_body())).await;
    let run_id = created["run"]["id"].as_str().unwrap().to_owned();
    let task_a = created["idMap"]["a"].as_str().unwrap().to_owned();

    // Gate parks the task.
    let (status, gate) = send(
        &api,
        "POST",
        &format!("/v1/runs/{run_id}/gates"),
        Some(json!({"taskId": task_a, "question": "ok?", "options": ["yes", "no"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{gate}");
    let gate_id = gate["id"].as_str().unwrap().to_owned();
    assert_eq!(gate["status"], "pending");
    let (_, task) = send(&api, "GET", &format!("/v1/tasks/{task_a}"), None).await;
    assert_eq!(task["status"], "blocked");

    let (status, gates) = send(
        &api,
        "GET",
        &format!("/v1/gates?runId={run_id}&status=pending"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(gates.as_array().unwrap().len(), 1);

    // Resolve unblocks; bad gate status query is a 400.
    let (status, resolved) = send(
        &api,
        "POST",
        &format!("/v1/gates/{gate_id}/resolve"),
        Some(json!({"decision": "yes"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved["decision"], "yes");
    let (status, _) = send(&api, "GET", "/v1/gates?status=bogus", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Messages: post, query unread for the recipient, mark read.
    let (status, message) = send(
        &api,
        "POST",
        "/v1/messages",
        Some(json!({
            "runId": run_id,
            "from": "coordinator",
            "to": "worker-a",
            "type": "ask",
            "subject": "which",
            "body": "file?"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{message}");
    let message_id = message["id"].as_str().unwrap().to_owned();

    let (status, unread) = send(
        &api,
        "GET",
        &format!("/v1/messages/unread?recipient=worker-a&runId={run_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(unread.as_array().unwrap().len(), 1);

    let (status, _) = send(
        &api,
        "POST",
        "/v1/messages/read",
        Some(json!({"ids": [message_id]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, unread_after) = send(
        &api,
        "GET",
        &format!("/v1/messages/unread?recipient=worker-a&runId={run_id}"),
        None,
    )
    .await;
    assert_eq!(unread_after.as_array().unwrap().len(), 0);

    let (status, answered) = send(
        &api,
        "POST",
        &format!("/v1/messages/{message_id}/answered"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(answered["answeredAt"].is_number());

    // Missing recipient on the unread route is a 400, not a server error.
    let (status, _) = send(&api, "GET", "/v1/messages/unread", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn invalid_and_unknown_dag_resources_map_to_400_and_404() {
    let (_directory, api) = fixture().await;

    // Malformed body.
    let (status, error) = send(
        &api,
        "POST",
        "/v1/runs/graph",
        Some(json!({"objective": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["code"].is_string());

    // Unknown run.
    let (status, _) = send(&api, "GET", "/v1/runs/run-does-not-exist", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(
        &api,
        "POST",
        "/v1/runs/run-does-not-exist/complete",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(&api, "GET", "/v1/tasks/task-does-not-exist", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(
        &api,
        "POST",
        "/v1/dispatches/disp-does-not-exist/running",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Abandon with a bogus final status.
    let (_, created) = send(&api, "POST", "/v1/runs/graph", Some(graph_body())).await;
    let task_a = created["idMap"]["a"].as_str().unwrap().to_owned();
    let (_, outcome) = send(
        &api,
        "POST",
        &format!("/v1/tasks/{task_a}/dispatch"),
        Some(json!({"sessionId": "sess-http-x0001"})),
    )
    .await;
    let dispatch_id = outcome["dispatch"]["id"].as_str().unwrap().to_owned();
    let (status, _) = send(
        &api,
        "POST",
        &format!("/v1/dispatches/{dispatch_id}/abandon"),
        Some(json!({"finalStatus": "done"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn recovery_route_reports_settled_and_resumed_dispatches() {
    let (_directory, api) = fixture().await;
    // With no sessions/dispatches the batch recovery is a no-op 200.
    let (status, report) = send(&api, "POST", "/v1/dispatches/recover", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["settled"], json!([]));
    assert_eq!(report["resumed"], json!([]));
}
