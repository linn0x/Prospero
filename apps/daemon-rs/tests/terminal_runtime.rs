#![cfg(unix)]

use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use base64::{Engine, engine::general_purpose::STANDARD};
use prosperod_rs::{
    auth::Token,
    database::Store,
    error::Error,
    protocol::{SessionLifecycle, SessionStatus},
    server::Api,
    terminal::{
        CreateTerminal, TerminalEvent, TerminalInput, TerminalQuery, TerminalSize,
        runtime::Terminals,
    },
    worker::Database,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct EnvGuard {
    keys: Vec<&'static str>,
}

impl EnvGuard {
    fn new(keys: Vec<&'static str>) -> Self {
        Self { keys }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            for key in &self.keys {
                std::env::remove_var(key);
            }
        }
    }
}

fn executable_script(path: &std::path::Path, body: &str) {
    std::fs::write(path, body).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

async fn wait_for_json(path: &std::path::Path) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(body) = std::fs::read_to_string(path) {
            return serde_json::from_str(&body).unwrap();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "capture never appeared"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn input(directory: &TempDir) -> CreateTerminal {
    CreateTerminal {
        title: "Test terminal".into(),
        workspace: directory.path().to_str().unwrap().into(),
        size: TerminalSize { cols: 80, rows: 24 },
        agent: None,
        command: None,
        account_id: None,
        model: None,
        effort: None,
    }
}

async fn settled(runtime: &Terminals) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while runtime.count() > 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

async fn stable_checkpoint_count(connection: &rusqlite::Connection) -> i64 {
    let mut count = -1;
    let mut stable_since = tokio::time::Instant::now();
    loop {
        let latest = connection
            .query_row("SELECT count(*) FROM checkpoint_writes", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        if latest != count {
            count = latest;
            stable_since = tokio::time::Instant::now();
        // The live loop coalesces output behind a 250ms quiet window, then
        // goes through a semaphore permit, spawn_blocking and the single DB
        // worker thread. Under full-suite parallel load that tail write can
        // land well over a second after the previous one, so require a window
        // comfortably larger than the debounce plus scheduling slack.
        } else if stable_since.elapsed() >= Duration::from_millis(1800) {
            return count;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn completed_terminal_is_archived_and_output_survives_restart() {
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(directory.path().into()).await.unwrap();
    let runtime = Terminals::new(database.clone());
    let head = runtime.create(input(&workspace)).await.unwrap();
    assert_eq!(head.status, SessionStatus::Running);
    assert_eq!(runtime.count(), 1);
    runtime
        .input(
            &head.id,
            TerminalInput {
                data_b64: STANDARD.encode("printf 'runtime-marker\\n'; exit 0\n"),
            },
        )
        .await
        .unwrap();
    settled(&runtime).await;
    runtime.shutdown().await.unwrap();
    database.shutdown().await.unwrap();
    drop(runtime);
    drop(database);
    let database = Database::open(directory.path().into()).await.unwrap();
    let runtime = Terminals::new(database.clone());
    let id = head.id.clone();
    let result = database
        .call(move |store| store.session(&id))
        .await
        .unwrap();
    assert_eq!(result.lifecycle, SessionLifecycle::Archived);
    assert_eq!(result.status, SessionStatus::Completed);
    let page = runtime
        .read(head.id, TerminalQuery::default())
        .await
        .unwrap();
    assert!(page.exited);
    assert_eq!(page.exit_code, Some(0));
    let bytes: Vec<u8> = page
        .events
        .into_iter()
        .filter_map(|event| match event {
            TerminalEvent::Output { data_b64 } => Some(STANDARD.decode(data_b64).unwrap()),
            _ => None,
        })
        .flatten()
        .collect();
    assert!(String::from_utf8_lossy(&bytes).contains("runtime-marker"));
    runtime.shutdown().await.unwrap();
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn terminal_busy_since_tracks_live_activity() {
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(directory.path().into()).await.unwrap();
    let runtime = Terminals::new(database.clone());
    let mut launch = input(&workspace);
    launch.agent = Some(prosperod_rs::protocol::AgentKind::Custom);
    launch.command = Some("printf 'working\\n'; sleep 60".into());
    let head = runtime.create(launch).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    let busy = loop {
        let id = head.id.clone();
        let busy = database
            .call(move |store| Ok(store.session(&id)?.busy_since))
            .await
            .unwrap();
        if busy.is_some() {
            break busy;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "terminal busySince was not persisted",
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    assert!(busy.unwrap() >= head.created_at);
    runtime.close(&head.id).unwrap();
    settled(&runtime).await;
    let id = head.id.clone();
    let finished = database
        .call(move |store| store.session(&id))
        .await
        .unwrap();
    assert_eq!(finished.busy_since, None);
    runtime.shutdown().await.unwrap();
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn custom_terminal_command_runs_and_archives() {
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(directory.path().into()).await.unwrap();
    let runtime = Terminals::new(database.clone());
    let mut input = input(&workspace);
    input.agent = Some(prosperod_rs::protocol::AgentKind::Custom);
    input.command = Some("printf 'custom-marker\\n'".into());
    let head = runtime.create(input).await.unwrap();
    assert_eq!(head.agent, prosperod_rs::protocol::AgentKind::Custom);
    settled(&runtime).await;
    let page = runtime
        .read(head.id, TerminalQuery::default())
        .await
        .unwrap();
    assert!(page.exited);
    assert_eq!(page.exit_code, Some(0));
    let bytes: Vec<u8> = page
        .events
        .into_iter()
        .filter_map(|event| match event {
            TerminalEvent::Output { data_b64 } => Some(STANDARD.decode(data_b64).unwrap()),
            _ => None,
        })
        .flatten()
        .collect();
    assert!(String::from_utf8_lossy(&bytes).contains("custom-marker"));
    runtime.shutdown().await.unwrap();
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn claude_pty_uses_managed_account_environment_and_defaults() {
    let _lock = ENV_LOCK.lock().await;
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(directory.path().into()).await.unwrap();
    let api = Api::new(database.clone(), Token::parse("1".repeat(64)).unwrap());
    let cli = directory.path().join("fake-claude-pty.py");
    let capture = directory.path().join("claude-pty.json");
    executable_script(
        &cli,
        r#"#!/usr/bin/env python3
import json, os, sys
with open(os.environ["CAPTURE"], "w", encoding="utf-8") as handle:
    json.dump({"argv": sys.argv[1:], "env": dict(os.environ)}, handle)
sys.stdout.write("claude-pty-done\n")
sys.stdout.flush()
"#,
    );
    let _env = EnvGuard::new(vec!["PROSPERO_CLAUDE_BIN", "CAPTURE"]);
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
        std::env::set_var("CAPTURE", &capture);
    }
    let (status, created) = request(
        &api,
        &"1".repeat(64),
        "POST",
        "/v1/accounts",
        json!({"type":"agent.account.create","requestId":"create","agent":"claude","name":"pty"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let account_id = created["accountId"].as_str().unwrap().to_owned();
    let (status, body) = request(
        &api,
        &"1".repeat(64),
        "POST",
        "/v1/accounts",
        json!({"type":"agent.account.credential.set","requestId":"cred","accountId":account_id,"credentialKind":"api_key","credential":"sk-prospero-terminal-secret-012345"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let account_root = directory
        .path()
        .join("agent-accounts")
        .join("claude")
        .join(&account_id);
    std::fs::write(
        account_root.join("prospero-overrides.yaml"),
        "default_model: claude-default\ndefault_effort: high\n",
    )
    .unwrap();

    let mut launch = input(&workspace);
    launch.agent = Some(prosperod_rs::protocol::AgentKind::Claude);
    launch.account_id = Some(account_id.clone());
    let head = api.terminals.create(launch).await.unwrap();
    settled(&api.terminals).await;
    let dumped = wait_for_json(&capture).await;
    assert_eq!(dumped["argv"], json!(["--dangerously-skip-permissions"]));
    let env = &dumped["env"];
    assert_eq!(
        env["ANTHROPIC_API_KEY"],
        "sk-prospero-terminal-secret-012345"
    );
    assert_eq!(env["CLAUDE_CODE_OAUTH_TOKEN"], "");
    assert_eq!(env["CLAUDE_CONFIG_DIR"], account_root.to_str().unwrap());
    assert_eq!(env["ANTHROPIC_MODEL"], "claude-default");
    assert_eq!(env["CLAUDE_CODE_EFFORT_LEVEL"], "high");
    let stored: Option<String> =
        rusqlite::Connection::open(directory.path().join("prospero.sqlite"))
            .unwrap()
            .query_row(
                "SELECT account_id FROM terminal_runs WHERE session_id=?1",
                [head.id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(stored.as_deref(), Some(account_id.as_str()));
    api.terminals.shutdown().await.unwrap();
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn codex_pty_uses_native_isolation_and_model_arguments() {
    let _lock = ENV_LOCK.lock().await;
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(directory.path().into()).await.unwrap();
    let runtime = Terminals::new(database.clone());
    let cli = directory.path().join("fake-codex-pty.py");
    let capture = directory.path().join("codex-pty.json");
    executable_script(
        &cli,
        r#"#!/usr/bin/env python3
import json, os, sys
with open(os.environ["CAPTURE"], "w", encoding="utf-8") as handle:
    json.dump({"argv": sys.argv[1:], "env": dict(os.environ)}, handle)
sys.stdout.write("codex-pty-done\n")
sys.stdout.flush()
"#,
    );
    let _env = EnvGuard::new(vec![
        "PROSPERO_CODEX_BIN",
        "CAPTURE",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "CODEX_ACCESS_TOKEN",
        "CODEX_REFRESH_TOKEN",
    ]);
    unsafe {
        std::env::set_var("PROSPERO_CODEX_BIN", &cli);
        std::env::set_var("CAPTURE", &capture);
        std::env::set_var("OPENAI_API_KEY", "parent-openai");
        std::env::set_var("CODEX_API_KEY", "parent-codex");
        std::env::set_var("CODEX_ACCESS_TOKEN", "parent-access");
        std::env::set_var("CODEX_REFRESH_TOKEN", "parent-refresh");
    }
    let mut launch = input(&workspace);
    launch.agent = Some(prosperod_rs::protocol::AgentKind::Codex);
    launch.account_id = Some("native-codex".into());
    launch.model = Some("gpt-6-test".into());
    launch.effort = Some("high".into());
    let head = runtime.create(launch).await.unwrap();
    settled(&runtime).await;
    let dumped = wait_for_json(&capture).await;
    assert_eq!(
        dumped["argv"],
        json!([
            "--dangerously-bypass-approvals-and-sandbox",
            "-c",
            "model=\"gpt-6-test\"",
            "-c",
            "model_reasoning_effort=\"high\""
        ])
    );
    let env = &dumped["env"];
    let native_root = directory
        .path()
        .join("agent-accounts")
        .join("codex")
        .join("native-codex");
    assert_eq!(env["CODEX_HOME"], native_root.to_str().unwrap());
    assert_eq!(env["CODEX_SQLITE_HOME"], native_root.to_str().unwrap());
    assert_eq!(env["OPENAI_API_KEY"], "");
    assert_eq!(env["CODEX_API_KEY"], "");
    assert_eq!(env["CODEX_ACCESS_TOKEN"], "");
    assert_eq!(env["CODEX_REFRESH_TOKEN"], "");
    let stored: Option<String> =
        rusqlite::Connection::open(directory.path().join("prospero.sqlite"))
            .unwrap()
            .query_row(
                "SELECT account_id FROM terminal_runs WHERE session_id=?1",
                [head.id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(stored.as_deref(), Some("native-codex"));

    let mut rejected = input(&workspace);
    rejected.agent = Some(prosperod_rs::protocol::AgentKind::Codex);
    rejected.account_id = Some("00000000-0000-0000-0000-000000000000".into());
    assert!(runtime.create(rejected).await.is_err());
    runtime.shutdown().await.unwrap();
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn codex_pty_uses_api_profile_environment_and_provider_arguments() {
    let _lock = ENV_LOCK.lock().await;
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(directory.path().into()).await.unwrap();
    let api = Api::new(
        database.clone(),
        Token::parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into())
            .unwrap(),
    );
    let response = api
        .router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/accounts")
                .header(
                    "authorization",
                    "Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                )
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "type":"agent.account.api.create",
                        "requestId":"codex-profile",
                        "agent":"codex",
                        "name":"Codex API",
                        "baseUrl":"http://localhost:12345/responses",
                        "model":"gpt-profile",
                        "apiKey":"sk-profile-secret",
                        "modelCapabilities":{"contextWindow":12345,"reasoning":false}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let account_id = value["accountId"].as_str().unwrap().to_owned();
    let runtime = Terminals::new(database.clone());
    let cli = directory.path().join("fake-codex-profile-pty.py");
    let capture = directory.path().join("codex-profile-pty.json");
    executable_script(
        &cli,
        r#"#!/usr/bin/env python3
import json, os, sys
with open(os.environ["CAPTURE"], "w", encoding="utf-8") as handle:
    json.dump({"argv": sys.argv[1:], "env": dict(os.environ)}, handle)
sys.stdout.write("codex-profile-pty-done\n")
sys.stdout.flush()
"#,
    );
    let _env = EnvGuard::new(vec![
        "PROSPERO_CODEX_BIN",
        "CAPTURE",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "CODEX_ACCESS_TOKEN",
        "CODEX_REFRESH_TOKEN",
    ]);
    unsafe {
        std::env::set_var("PROSPERO_CODEX_BIN", &cli);
        std::env::set_var("CAPTURE", &capture);
        std::env::set_var("OPENAI_API_KEY", "parent-openai");
        std::env::set_var("CODEX_API_KEY", "parent-codex");
    }
    let mut launch = input(&workspace);
    launch.agent = Some(prosperod_rs::protocol::AgentKind::Codex);
    launch.account_id = Some(account_id.clone());
    let head = runtime.create(launch).await.unwrap();
    settled(&runtime).await;
    let dumped = wait_for_json(&capture).await;
    let argv = dumped["argv"].as_array().unwrap();
    assert!(argv.iter().any(|arg| arg == "model_provider=\"prospero\""));
    assert!(argv.iter().any(|arg| arg == "model=\"gpt-profile\""));
    assert!(
        argv.iter()
            .any(|arg| arg == "model_providers.prospero.base_url=\"http://localhost:12345\"")
    );
    assert!(
        argv.iter()
            .any(|arg| arg == "model_providers.prospero.env_key=\"OPENAI_API_KEY\"")
    );
    assert!(argv.iter().any(|arg| arg == "model_context_window=12345"));
    assert_eq!(dumped["env"]["OPENAI_API_KEY"], "sk-profile-secret");
    assert_eq!(dumped["env"]["CODEX_API_KEY"], "");

    let stored: Option<String> =
        rusqlite::Connection::open(directory.path().join("prospero.sqlite"))
            .unwrap()
            .query_row(
                "SELECT account_id FROM terminal_runs WHERE session_id=?1",
                [head.id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(stored.as_deref(), Some(account_id.as_str()));
    runtime.shutdown().await.unwrap();
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn pty_agent_commands_validate_like_legacy() {
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(directory.path().into()).await.unwrap();
    let runtime = Terminals::new(database.clone());
    let mut deepseek = input(&workspace);
    deepseek.agent = Some(prosperod_rs::protocol::AgentKind::Deepseek);
    assert!(runtime.create(deepseek).await.is_err());
    let mut custom = input(&workspace);
    custom.agent = Some(prosperod_rs::protocol::AgentKind::Custom);
    assert!(runtime.create(custom).await.is_err());
    runtime.shutdown().await.unwrap();
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn caps_active_processes_and_shutdown_releases_every_slot() {
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(directory.path().into()).await.unwrap();
    let runtime = Terminals::new(database.clone());
    for _ in 0..16 {
        runtime.create(input(&workspace)).await.unwrap();
    }
    assert_eq!(runtime.count(), 16);
    assert!(matches!(
        runtime.create(input(&workspace)).await,
        Err(Error::Busy)
    ));
    runtime.shutdown().await.unwrap();
    assert_eq!(runtime.count(), 0);
    assert!(matches!(
        runtime.create(input(&workspace)).await,
        Err(Error::Closed)
    ));
    assert_eq!(
        database
            .call(|store| store.session_summary(None))
            .await
            .unwrap()
            .active,
        0
    );
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_creation_and_missing_workspace_do_not_leave_running_sessions() {
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(directory.path().into()).await.unwrap();
    let runtime = Terminals::new(database.clone());
    let mut missing = input(&workspace);
    missing.workspace.push_str("/missing");
    assert!(runtime.create(missing).await.is_err());
    let copy = runtime.clone();
    let creation = tokio::spawn(async move { copy.create(input(&workspace)).await });
    tokio::task::yield_now().await;
    creation.abort();
    let _ = creation.await;
    runtime.shutdown().await.unwrap();
    assert_eq!(runtime.count(), 0);
    assert_eq!(
        database
            .call(|store| store.session_summary(None))
            .await
            .unwrap()
            .active,
        0
    );
    database.shutdown().await.unwrap();
}

#[test]
fn recovery_only_finishes_persisted_terminal_leases() {
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    store.seed_archives(10_000).unwrap();
    let head = store.create_terminal(input(&workspace)).unwrap();
    drop(store);
    let mut store = Store::open(directory.path()).unwrap();
    assert_eq!(store.recover_terminals().unwrap(), 1);
    assert_eq!(store.recover_terminals().unwrap(), 0);
    let result = store.session(&head.id).unwrap();
    assert_eq!(result.lifecycle, SessionLifecycle::Archived);
    assert_eq!(result.status, SessionStatus::Failed);
    assert_eq!(store.session_summary(None).unwrap().total, 10_001);
}

async fn request(
    api: &Api,
    token: &str,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = api
        .router()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
        .unwrap();
    (status, body)
}

#[tokio::test]
async fn terminal_http_contract_validates_commands_and_reports_live_count() {
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(directory.path().into()).await.unwrap();
    let token = "1".repeat(64);
    let api = Api::new(database.clone(), Token::parse(token.clone()).unwrap());
    let (status, created) = request(
        &api,
        &token,
        "POST",
        "/v1/terminals",
        serde_json::to_value(input(&workspace)).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let id = created["id"].as_str().unwrap();
    assert_eq!(
        request(&api, &token, "GET", "/v1/health", Value::Null)
            .await
            .1["activeRuntimeSessions"],
        1
    );
    assert_eq!(
        request(
            &api,
            &token,
            "POST",
            &format!("/v1/terminals/{id}/input"),
            json!({"dataB64":"!"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &api,
            &token,
            "POST",
            &format!("/v1/terminals/{id}/resize"),
            json!({"cols":100,"rows":30})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &api,
            &token,
            "GET",
            &format!("/v1/terminals/{id}/output?waitMs=5001"),
            Value::Null
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &api,
            &token,
            "POST",
            &format!("/v1/terminals/{id}/close"),
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    settled(&api.terminals).await;
    let (status, page) = request(
        &api,
        &token,
        "GET",
        &format!("/v1/terminals/{id}/output"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["exited"], true);
    api.terminals.shutdown().await.unwrap();
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn storage_failure_rolls_back_exit_and_keeps_output_available_until_shutdown() {
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(directory.path().into()).await.unwrap();
    let runtime = Terminals::new(database.clone());
    let head = runtime.create(input(&workspace)).await.unwrap();
    let connection = rusqlite::Connection::open(directory.path().join("prospero.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_terminal_exit BEFORE INSERT ON change_events BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    runtime.close(&head.id).unwrap();
    settled(&runtime).await;
    assert!(runtime.check().is_err());
    assert!(
        runtime
            .read(head.id.clone(), TerminalQuery::default())
            .await
            .unwrap()
            .exited
    );
    let id = head.id.clone();
    assert_eq!(
        database
            .call(move |store| store.session(&id))
            .await
            .unwrap()
            .lifecycle,
        SessionLifecycle::Active
    );
    let active: i64 = connection
        .query_row(
            "SELECT active FROM terminal_runs WHERE session_id=?",
            [&head.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(active, 1);
    assert!(runtime.create(input(&workspace)).await.is_err());
    assert!(runtime.shutdown().await.is_err());
    connection
        .execute_batch("DROP TRIGGER fail_terminal_exit")
        .unwrap();
    assert_eq!(
        database
            .call(|store| store.recover_terminals())
            .await
            .unwrap(),
        1
    );
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn live_checkpoints_stop_writing_when_idle_and_fail_closed_on_storage_errors() {
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(directory.path().into()).await.unwrap();
    let runtime = Terminals::new(database.clone());
    let head = runtime.create(input(&workspace)).await.unwrap();
    let connection = rusqlite::Connection::open(directory.path().join("prospero.sqlite")).unwrap();
    connection.execute_batch("CREATE TABLE checkpoint_writes(seq INTEGER); CREATE TRIGGER count_checkpoint AFTER UPDATE OF latest_seq ON terminal_runs BEGIN INSERT INTO checkpoint_writes VALUES(NEW.latest_seq); END;").unwrap();
    runtime
        .input(
            &head.id,
            TerminalInput {
                data_b64: STANDARD.encode("printf 'checkpoint-live'; read answer\n"),
            },
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let id = head.id.clone();
            let snapshot = database
                .call(move |store| store.terminal_snapshot(&id))
                .await
                .unwrap();
            if snapshot.is_some_and(|snapshot| {
                String::from_utf8_lossy(&STANDARD.decode(snapshot.data_b64).unwrap())
                    .contains("checkpoint-live")
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    let count = stable_checkpoint_count(&connection).await;
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM checkpoint_writes", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        count
    );
    connection.execute_batch("CREATE TRIGGER reject_live_output BEFORE INSERT ON terminal_output BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    runtime
        .input(
            &head.id,
            TerminalInput {
                data_b64: STANDARD.encode("new-uncommitted-input"),
            },
        )
        .await
        .unwrap();
    settled(&runtime).await;
    assert!(runtime.check().is_err());
    assert!(
        runtime
            .read(head.id.clone(), TerminalQuery::default())
            .await
            .unwrap()
            .exited
    );
    assert!(runtime.create(input(&workspace)).await.is_err());
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM checkpoint_writes", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        count
    );
    let snapshot = database
        .call(move |store| store.terminal_snapshot(&head.id))
        .await
        .unwrap()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&STANDARD.decode(snapshot.data_b64).unwrap())
            .contains("checkpoint-live")
    );
    assert!(runtime.shutdown().await.is_err());
    connection
        .execute_batch("DROP TRIGGER reject_live_output")
        .unwrap();
    database.shutdown().await.unwrap();
}
