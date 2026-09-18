//! Stage 7 HTTP surface: the DAG routes are wired to the store and return the
//! same JSON contract as the generated `rust-daemon.ts`.

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use prosperod_rs::auth::Token;
use prosperod_rs::protocol::{AgentKind, CreateSession, SessionKind};
use prosperod_rs::server::Api;
use prosperod_rs::worker::Database;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
static CODEX_HOME_SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static AUTOMATION_CLI_SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const FAKE_AUTOMATION_CLI: &str = r#"#!/usr/bin/env python3
import json, sys, time
sys.stdout.write(json.dumps({"type": "system", "subtype": "init", "session_id": "fake-automation-worker"}) + "\n")
sys.stdout.flush()
sys.stdin.readline()
while True:
    time.sleep(1)
"#;

struct ClaudeBinGuard(Option<std::ffi::OsString>);

impl Drop for ClaudeBinGuard {
    fn drop(&mut self) {
        unsafe {
            match &self.0 {
                Some(value) => std::env::set_var("PROSPERO_CLAUDE_BIN", value),
                None => std::env::remove_var("PROSPERO_CLAUDE_BIN"),
            }
        }
    }
}

fn install_fake_automation_cli(directory: &TempDir) -> ClaudeBinGuard {
    let cli = directory.path().join("fake-automation-claude.py");
    std::fs::write(&cli, FAKE_AUTOMATION_CLI).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let previous = std::env::var_os("PROSPERO_CLAUDE_BIN");
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", cli);
    }
    ClaudeBinGuard(previous)
}

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
async fn scheduled_agents_are_exposed_over_http() {
    let _guard = CODEX_HOME_SERIAL.lock().await;
    let directory = TempDir::new().unwrap();
    let codex_home = directory.path().join("codex-home");
    let previous_codex_home = std::env::var_os("CODEX_HOME");
    unsafe {
        std::env::set_var("CODEX_HOME", &codex_home);
    }
    struct EnvGuard(Option<std::ffi::OsString>);
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.0 {
                    Some(value) => std::env::set_var("CODEX_HOME", value),
                    None => std::env::remove_var("CODEX_HOME"),
                }
            }
        }
    }
    let _env = EnvGuard(previous_codex_home);
    let database = Database::open(directory.path().join("isolated"))
        .await
        .unwrap();
    let api = Api::new(database, Token::parse(SECRET.into()).unwrap());
    let workspace = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();

    let (status, created) = send(
        &api,
        "POST",
        "/v1/schedules",
        Some(json!({
            "id": "daily-check",
            "name": "Daily check",
            "prompt": "Check the repo",
            "rrule": "FREQ=DAILY;INTERVAL=1",
            "agent": "codex",
            "approvalPolicy": "standard",
            "cwd": workspace,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["id"], "daily-check");
    assert_eq!(created["status"], "ENABLED");
    assert!(created.get("path").is_none());

    let schedule_file = codex_home
        .join("automations")
        .join("daily-check")
        .join("automation.toml");
    assert!(schedule_file.is_file());

    let (status, list) = send(&api, "GET", "/v1/schedules", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list.as_array().unwrap().len(), 1);

    let (status, paused) = send(&api, "POST", "/v1/schedules/daily-check/pause", None).await;
    assert_eq!(status, StatusCode::OK, "{paused}");
    assert_eq!(paused["status"], "PAUSED");

    let (status, resumed) = send(&api, "POST", "/v1/schedules/daily-check/resume", None).await;
    assert_eq!(status, StatusCode::OK, "{resumed}");
    assert_eq!(resumed["status"], "ENABLED");

    let (status, deleted) = send(&api, "DELETE", "/v1/schedules/daily-check", None).await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    assert_eq!(deleted["deleted"], true);
}

#[tokio::test]
async fn plugin_services_are_exposed_over_http() {
    let (directory, api) = fixture().await;
    let plugin_root = directory.path().join("plugins/prospero-demo/runtime");
    std::fs::create_dir_all(&plugin_root).unwrap();
    std::fs::write(
        plugin_root.join("service.mjs"),
        "setInterval(() => {}, 1000);\n",
    )
    .unwrap();
    std::fs::write(
        directory
            .path()
            .join("plugins/prospero-demo/prospero-plugin.json"),
        serde_json::json!({
            "schema_version": "prospero-plugin/v1",
            "name": "prospero-demo",
            "version": "0.1.0",
            "runtime_root": "runtime",
            "services": [{
                "id": "bridge",
                "mode": "manual",
                "command": ["node", "service.mjs"],
                "cwd": "runtime",
                "env": {"FEATURE_FLAG": "1"},
                "port_env": "PORT",
                "health_path": "/health"
            }]
        })
        .to_string(),
    )
    .unwrap();

    let (status, plugins) = send(&api, "GET", "/v1/plugins", None).await;
    assert_eq!(status, StatusCode::OK, "{plugins}");
    assert_eq!(plugins["items"][0]["name"], "prospero-demo");
    assert_eq!(
        plugins["items"][0]["services"][0]["envKeys"][0],
        "FEATURE_FLAG"
    );

    let (status, services) = send(&api, "GET", "/v1/plugin-services", None).await;
    assert_eq!(status, StatusCode::OK, "{services}");
    assert_eq!(services["items"][0]["pluginId"], "prospero-demo");
    assert_eq!(services["items"][0]["serviceId"], "bridge");
    assert_eq!(services["items"][0]["configured"], true);
    assert_eq!(services["items"][0]["status"], "stopped");
}

#[tokio::test]
async fn task_delivery_routes_settle_live_dispatches() {
    let (_directory, api) = fixture().await;
    let (status, created) = send(&api, "POST", "/v1/runs/graph", Some(graph_body())).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let task_id = created["idMap"]["a"].as_str().unwrap().to_owned();
    let worker = api
        .database
        .call(|store| {
            store.create_session(CreateSession {
                agent: AgentKind::Claude,
                kind: SessionKind::Structured,
                title: "worker".into(),
                workspace: "/synthetic".into(),
            })
        })
        .await
        .unwrap();
    let dispatch = {
        let task_id = task_id.clone();
        let session_id = worker.id.clone();
        api.database
            .call(move |store| {
                let outcome = store.dispatch_task(&task_id, &session_id, None, None)?;
                store.set_dispatch_running(&outcome.dispatch.id)
            })
            .await
            .unwrap()
    };

    let (status, rejected) = send(
        &api,
        "POST",
        &format!("/v1/tasks/{task_id}/complete"),
        Some(json!({"body":"done","actorSessionId":"other-worker"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{rejected}");

    let (status, delivered) = send(
        &api,
        "POST",
        &format!("/v1/tasks/{task_id}/complete"),
        Some(json!({"body":"done","actorSessionId":worker.id})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{delivered}");
    assert_eq!(delivered["status"], "done");
    let dispatch_id = dispatch.id;
    let settled = api
        .database
        .call(move |store| store.dispatch(&dispatch_id))
        .await
        .unwrap();
    assert_eq!(
        settled.state,
        prosperod_rs::orchestration::DispatchState::Succeeded
    );
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

#[tokio::test]
async fn automation_current_dispatches_and_advances_chain() {
    let _serial = AUTOMATION_CLI_SERIAL.lock().await;
    let (directory, api) = fixture().await;
    let _cli = install_fake_automation_cli(&directory);
    let workspace = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let (_, created) = send(&api, "POST", "/v1/runs/graph", Some(graph_body())).await;
    let run_id = created["run"]["id"].as_str().unwrap().to_owned();
    let task_a = created["idMap"]["a"].as_str().unwrap().to_owned();
    let task_b = created["idMap"]["b"].as_str().unwrap().to_owned();

    let (status, run) = send(
        &api,
        "POST",
        &format!("/v1/runs/{run_id}/automation/start"),
        Some(json!({
            "runId": run_id,
            "agent": "claude",
            "approvalPolicy": "standard",
            "workspace": "current",
            "cwd": workspace,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{run}");
    assert_eq!(run["automation"]["state"], "running");
    assert_eq!(run["automation"]["workspace"], "current");

    let (_, dispatches) = send(&api, "GET", &format!("/v1/dispatches?runId={run_id}"), None).await;
    assert_eq!(dispatches.as_array().unwrap().len(), 1, "{dispatches}");
    let dispatch_a = dispatches[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(dispatches[0]["taskId"], task_a);

    let (status, settled) = send(
        &api,
        "POST",
        &format!("/v1/dispatches/{dispatch_a}/settle"),
        Some(json!({"success": true, "outcome": "a done"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{settled}");

    let (_, dispatches) = send(&api, "GET", &format!("/v1/dispatches?runId={run_id}"), None).await;
    assert_eq!(dispatches.as_array().unwrap().len(), 2, "{dispatches}");
    let dispatch_b = dispatches[1]["id"].as_str().unwrap().to_owned();
    assert_eq!(dispatches[1]["taskId"], task_b);

    let (status, _) = send(
        &api,
        "POST",
        &format!("/v1/dispatches/{dispatch_b}/settle"),
        Some(json!({"success": true, "outcome": "b done"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (_, snapshot) = send(&api, "GET", &format!("/v1/runs/{run_id}"), None).await;
    assert_eq!(snapshot["run"]["status"], "completed");
    assert_eq!(snapshot["run"]["automation"]["state"], "completed");
}

#[tokio::test]
async fn automation_pause_prevents_next_dispatch() {
    let _serial = AUTOMATION_CLI_SERIAL.lock().await;
    let (directory, api) = fixture().await;
    let _cli = install_fake_automation_cli(&directory);
    let workspace = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let (_, created) = send(&api, "POST", "/v1/runs/graph", Some(graph_body())).await;
    let run_id = created["run"]["id"].as_str().unwrap().to_owned();

    let (status, _) = send(
        &api,
        "POST",
        &format!("/v1/runs/{run_id}/automation/start"),
        Some(json!({
            "runId": run_id,
            "agent": "claude",
            "approvalPolicy": "standard",
            "workspace": "current",
            "cwd": workspace,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, dispatches) = send(&api, "GET", &format!("/v1/dispatches?runId={run_id}"), None).await;
    let dispatch_a = dispatches[0]["id"].as_str().unwrap().to_owned();

    let (status, paused) = send(
        &api,
        "POST",
        &format!("/v1/runs/{run_id}/automation/pause"),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{paused}");
    assert_eq!(paused["automation"]["state"], "paused");

    let (status, _) = send(
        &api,
        "POST",
        &format!("/v1/dispatches/{dispatch_a}/settle"),
        Some(json!({"success": true, "outcome": "a done"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, dispatches) = send(&api, "GET", &format!("/v1/dispatches?runId={run_id}"), None).await;
    assert_eq!(dispatches.as_array().unwrap().len(), 1, "{dispatches}");
}

fn git(cwd: &std::path::Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repo(root: &std::path::Path) -> std::path::PathBuf {
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["symbolic-ref", "HEAD", "refs/heads/master"]);
    git(&repo, &["config", "user.email", "test@prospero.local"]);
    git(&repo, &["config", "user.name", "Prospero Test"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.join("README.md"), "# base\n").unwrap();
    git(&repo, &["add", "README.md"]);
    git(&repo, &["commit", "-q", "-m", "base"]);
    repo
}

#[tokio::test]
async fn automation_run_workspace_registers_shared_worktree_asset() {
    let (directory, api) = fixture().await;
    let repo = init_repo(directory.path());
    let subdir = repo.join("crates/app");
    std::fs::create_dir_all(&subdir).unwrap();
    let (_, created) = send(&api, "POST", "/v1/runs/graph", Some(graph_body())).await;
    let run_id = created["run"]["id"].as_str().unwrap().to_owned();

    let (status, run) = send(
        &api,
        "POST",
        &format!("/v1/runs/{run_id}/automation/start"),
        Some(json!({
            "runId": run_id,
            "agent": "claude",
            "approvalPolicy": "standard",
            "workspace": "run",
            "cwd": subdir,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{run}");
    assert_eq!(run["automation"]["workspace"], "run");
    let canonical_subdir = std::fs::canonicalize(&subdir).unwrap();
    assert_eq!(
        run["automation"]["cwd"].as_str().unwrap(),
        canonical_subdir.to_string_lossy()
    );
    let workspace_path = run["automation"]["workspacePath"].as_str().unwrap();
    assert!(workspace_path.ends_with("crates/app"), "{workspace_path}");
    assert_ne!(workspace_path, canonical_subdir.to_string_lossy());
    assert!(
        run["automation"]["branch"]
            .as_str()
            .unwrap()
            .starts_with("prospero/")
    );

    let (status, assets) = send(&api, "GET", &format!("/v1/worktrees?runId={run_id}"), None).await;
    assert_eq!(status, StatusCode::OK, "{assets}");
    let assets = assets.as_array().unwrap();
    assert_eq!(assets.len(), 1, "{assets:?}");
    assert_eq!(assets[0]["kind"], "run");
    assert!(std::path::Path::new(assets[0]["path"].as_str().unwrap()).is_dir());
}

#[tokio::test]
async fn running_automation_rejects_graph_edits_and_manual_dispatch() {
    let _serial = AUTOMATION_CLI_SERIAL.lock().await;
    let (directory, api) = fixture().await;
    let _cli = install_fake_automation_cli(&directory);
    let workspace = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let (_, created) = send(&api, "POST", "/v1/runs/graph", Some(graph_body())).await;
    let run_id = created["run"]["id"].as_str().unwrap().to_owned();
    let task_a = created["idMap"]["a"].as_str().unwrap().to_owned();

    let (status, run) = send(
        &api,
        "POST",
        &format!("/v1/runs/{run_id}/automation/start"),
        Some(json!({
            "runId": run_id,
            "agent": "claude",
            "approvalPolicy": "standard",
            "workspace": "current",
            "cwd": workspace,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{run}");

    let (status, _) = send(
        &api,
        "POST",
        "/v1/tasks",
        Some(json!({"runId": run_id, "title": "late", "spec": "edit"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        &api,
        "POST",
        "/v1/runs/graph/apply",
        Some(json!({
            "runId": run_id,
            "baseRevision": 1,
            "operationId": "edit-during-automation",
            "nodes": [{"clientId": task_a, "title": "A2", "spec": "edit"}]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        &api,
        "POST",
        "/v1/workers/start",
        Some(json!({
            "taskId": task_a,
            "agent": "claude",
            "cwd": workspace,
            "worktree": "none",
            "approvalPolicy": "standard",
            "operationId": "manual-during-automation"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        &api,
        "POST",
        &format!("/v1/runs/{run_id}/complete"),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}
