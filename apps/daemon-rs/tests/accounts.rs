#![cfg(unix)]
//! Read-only account discovery tests. A tiny fake `claude` answers
//! `auth status --json`; PROSPERO_CLAUDE_BIN is process-global so the tests
//! serialize, mirroring tests/agent_runtime.rs.

use std::os::unix::fs::PermissionsExt;

use prosperod_rs::{
    accounts::{AccountStatus, NATIVE_CLAUDE_ID, list_accounts},
    auth::Token,
    protocol::{AgentKind, CreateSession, SessionKind},
    server::Api,
    worker::Database,
};
use tempfile::TempDir;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Emits a fixed JSON body for `auth status --json`; fails loudly if invoked
/// for anything else (the probe must be read-only and argument-exact).
fn write_cli(directory: &std::path::Path, body: &str) -> std::path::PathBuf {
    let script = format!(
        r#"#!/usr/bin/env python3
import json, sys
if sys.argv[1:] != ["auth", "status", "--json"]:
    sys.exit(3)
body = {body:?}
if body:
    sys.stdout.write(body)
"#
    );
    let cli = directory.join("fake-claude.py");
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

struct EnvGuard;
impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            std::env::remove_var("PROSPERO_CLAUDE_BIN");
        }
    }
}

#[tokio::test]
async fn logged_in_native_claude_account_carries_method_and_provider() {
    let _guard = SERIAL.lock().await;
    let _env = EnvGuard;
    let (directory, database) = open_db().await;
    let cli = write_cli(
        directory.path(),
        r#"{"loggedIn":true,"authMethod":"claude.ai-credentials","apiProvider":"anthropic"}"#,
    );
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
    }

    let result = list_accounts(&database, "req-1").await.unwrap();
    assert_eq!(result.kind, "agent.accounts.result");
    assert_eq!(result.action, "list");
    assert_eq!(result.request_id, "req-1");
    assert!(result.ok);
    assert_eq!(result.accounts.len(), 2);
    let codex = result
        .accounts
        .iter()
        .find(|account| account.id == "native-codex")
        .expect("native codex account");
    assert_eq!(codex.agent, AgentKind::Codex);
    assert!(!codex.managed);
    assert!(codex.is_default);
    assert_eq!(
        codex.capabilities.session_kinds,
        vec![SessionKind::Pty, SessionKind::Structured]
    );
    assert!(codex.capabilities.plan && codex.capabilities.resume);
    let account = result
        .accounts
        .iter()
        .find(|account| account.id == NATIVE_CLAUDE_ID)
        .unwrap();
    assert_eq!(account.id, NATIVE_CLAUDE_ID);
    assert_eq!(account.agent, AgentKind::Claude);
    assert_eq!(account.name, "本机默认");
    assert!(!account.managed);
    assert!(account.is_default);
    assert_eq!(account.status, AccountStatus::SignedIn);
    assert_eq!(
        account.auth_method.as_deref(),
        Some("claude.ai-credentials")
    );
    assert_eq!(account.detail.as_deref(), Some("anthropic"));
    assert_eq!(account.created_at, 0);
    assert!(account.updated_at > 0);
    let caps = &account.capabilities;
    assert_eq!(
        caps.session_kinds,
        vec![SessionKind::Pty, SessionKind::Structured]
    );
    assert!(caps.plan && caps.resume);
    // The launch catalog slice serves model/effort selection.
    assert!(caps.model_selection);
    assert!(caps.reasoning_effort);
}

#[tokio::test]
async fn logged_out_and_empty_output_map_to_signed_out() {
    let _guard = SERIAL.lock().await;
    let _env = EnvGuard;
    let (directory, database) = open_db().await;
    let cli = write_cli(directory.path(), r#"{"loggedIn":false}"#);
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
    }
    let result = list_accounts(&database, "req-2").await.unwrap();
    assert_eq!(result.accounts[0].status, AccountStatus::SignedOut);
    assert_eq!(result.accounts[0].auth_method, None);

    let cli = write_cli(directory.path(), "");
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
    }
    let result = list_accounts(&database, "req-3").await.unwrap();
    assert_eq!(result.accounts[0].status, AccountStatus::SignedOut);

    let cli = write_cli(directory.path(), "this is not json");
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
    }
    let result = list_accounts(&database, "req-3b").await.unwrap();
    assert_eq!(result.accounts[0].status, AccountStatus::SignedOut);
}

#[tokio::test]
async fn missing_cli_binary_reports_unavailable() {
    let _guard = SERIAL.lock().await;
    let _env = EnvGuard;
    let (directory, database) = open_db().await;
    let missing = directory.path().join("definitely-not-claude");
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &missing);
    }
    let result = list_accounts(&database, "req-4").await.unwrap();
    assert_eq!(result.accounts[0].status, AccountStatus::Unavailable);
    assert_eq!(result.accounts[0].detail.as_deref(), Some("未安装 claude"));
}

#[tokio::test]
async fn active_sessions_counts_live_claude_sessions() {
    let _guard = SERIAL.lock().await;
    let _env = EnvGuard;
    let (directory, database) = open_db().await;
    database
        .call(|store| {
            store.create_session(CreateSession {
                agent: AgentKind::Claude,
                kind: SessionKind::Structured,
                title: "live".into(),
                workspace: "/ws".into(),
            })?;
            store.create_session(CreateSession {
                agent: AgentKind::Codex,
                kind: SessionKind::Structured,
                title: "other-agent".into(),
                workspace: "/ws".into(),
            })?;
            Ok(())
        })
        .await
        .unwrap();
    let cli = write_cli(directory.path(), r#"{"loggedIn":true}"#);
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
    }
    let result = list_accounts(&database, "req-5").await.unwrap();
    assert_eq!(result.accounts[0].active_sessions, 1);
}

#[tokio::test]
async fn http_route_rejects_non_list_actions_and_bad_request_ids() {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    let (_directory, database) = open_db().await;
    let api = Api::new(
        database,
        Token::parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into())
            .unwrap(),
    );
    let app = api.router();
    let secret = "Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    for payload in [
        r#"{"type":"agent.account.create","requestId":"x"}"#,
        r#"{"type":"agent.accounts.list","requestId":""}"#,
        r#"{"type":"agent.accounts.list"}"#,
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/accounts")
                    .header("authorization", secret)
                    .header("content-type", "application/json")
                    .body(Body::from(payload))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "payload {payload}"
        );
    }
}
