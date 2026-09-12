#![cfg(unix)]
//! Managed Claude account lifecycle, credential isolation and login PTY tests.
//! A fake `claude` answers probes, speaks the catalog handshake, dumps the
//! environment seen by a managed turn, and emulates `setup-token`. PROSPERO_CLAUDE_BIN
//! is process-global so the tests serialize via SERIAL.

use std::os::unix::fs::PermissionsExt;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use prosperod_rs::{auth::Token, server::Api, worker::Database};
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const SECRET: &str = "sk-prospero-managed-secret-0123456789";

/// One script covers every invocation shape; capture paths arrive through the
/// (safe, non-secret) CAPTURE/LOGIN_CAPTURE environment variables.
fn write_cli(directory: &std::path::Path) -> std::path::PathBuf {
    let script = r#"#!/usr/bin/env python3
import json, os, sys, threading, time

argv = sys.argv[1:]

if argv == ["auth", "status", "--json"]:
    body = os.environ.get("PROSPERO_FAKE_STATUS", "")
    if body:
        sys.stdout.write(body)
    sys.exit(0)

catalog_args = ["-p", "--output-format", "stream-json",
                "--input-format", "stream-json", "--verbose"]

def dump(path):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"argv": argv, "env": dict(os.environ)}, handle)

def answer_controls():
    while True:
        raw = sys.stdin.readline()
        if not raw:
            break
        try:
            frame = json.loads(raw)
        except Exception:
            continue
        sys.stdout.write(json.dumps({"type": "control_response", "response": {
            "subtype": "success", "request_id": frame.get("request_id"),
            "response": {}}}) + "\n")
        sys.stdout.flush()

if argv == ["setup-token"]:
    login = os.environ.get("LOGIN_CAPTURE")
    if login:
        dump(login)
    marker = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR", "."), "setup-ran")
    with open(marker, "w") as handle:
        handle.write(str(os.getpid()))
    time.sleep(600)
    sys.exit(0)

if argv == catalog_args:
    frame = json.loads(sys.stdin.readline())
    assert frame["type"] == "control_request", frame
    rid = frame["request_id"]
    sys.stdout.write(json.dumps({"type": "control_response", "response": {
        "subtype": "success", "request_id": rid,
        "response": {"models": [
            {"value": "default", "displayName": "Default",
             "supportedEffortLevels": ["low", "high"]}]}}}) + "\n")
    sys.stdout.flush()
    sys.exit(0)

# Headless turn: announce init, expose the exact environment the daemon
# injected, then idle until the daemon closes the session.
capture = os.environ.get("CAPTURE")
if capture:
    dump(capture)
sys.stdout.write(json.dumps({"type": "system", "subtype": "init",
                             "session_id": "managed-fake"}) + "\n")
sys.stdout.flush()
threading.Thread(target=answer_controls, daemon=True).start()
time.sleep(600)
"#;
    let cli = directory.join("fake-claude-managed.py");
    std::fs::write(&cli, script).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    cli
}

struct Harness {
    directory: TempDir,
    /// Held for the harness lifetime so the store thread stays open even if
    /// the router does not retain its own clone.
    #[allow(dead_code)]
    database: Database,
    app: axum::Router,
    secret: &'static str,
}

impl Harness {
    async fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let cli = write_cli(directory.path());
        unsafe {
            std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
            std::env::set_var("PROSPERO_FAKE_STATUS", r#"{"loggedIn":true}"#);
        }
        let data_dir = directory.path().join("daemon");
        let database = Database::open(data_dir).await.unwrap();
        let api = Api::new(
            database.clone(),
            Token::parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into())
                .unwrap(),
        );
        Self {
            directory,
            database,
            app: api.router(),
            secret: "Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        }
    }

    async fn post(&self, payload: Value) -> (StatusCode, Value) {
        self.post_path("/v1/accounts", payload).await
    }

    async fn post_path(&self, path: &str, payload: Value) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("authorization", self.secret)
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
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    async fn delete_path(&self, path: &str) -> StatusCode {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(path)
                    .header("authorization", self.secret)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        response.status()
    }

    fn account_root(&self, id: &str) -> std::path::PathBuf {
        self.directory
            .path()
            .join("daemon/agent-accounts/claude")
            .join(id)
    }

    fn raw_connection(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.directory.path().join("daemon/prospero.sqlite")).unwrap()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        unsafe {
            std::env::remove_var("PROSPERO_CLAUDE_BIN");
            std::env::remove_var("PROSPERO_FAKE_STATUS");
            std::env::remove_var("CAPTURE");
            std::env::remove_var("LOGIN_CAPTURE");
        }
    }
}

fn control(kind: &str, extra: serde_json::Map<String, Value>) -> Value {
    let mut payload = serde_json::Map::new();
    payload.insert("type".into(), Value::String(kind.into()));
    payload.insert("requestId".into(), Value::String("req".into()));
    payload.extend(extra);
    Value::Object(payload)
}

fn account<'a>(result: &'a Value, id: &str) -> Option<&'a Value> {
    result["accounts"].as_array().and_then(|accounts| {
        accounts
            .iter()
            .find(|row| row["id"] == Value::String(id.into()))
    })
}

fn created_id(result: &Value) -> String {
    result["accountId"].as_str().unwrap().to_owned()
}

async fn wait_for(path: &std::path::Path) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if let Ok(body) = std::fs::read_to_string(path) {
            return serde_json::from_str(&body).unwrap();
        }
        assert!(
            std::time::Instant::now() < deadline,
            "capture never appeared"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn managed_lifecycle_rename_default_credential_logout_and_delete() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;

    // Create: the first managed account becomes the default; its private root
    // is eagerly created with mode 0700.
    let (status, result) = harness
        .post(control(
            "agent.account.create",
            serde_json::json!({"agent":"claude","name":"  工作账号  "})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let id = created_id(&result);
    let row = account(&result, &id).unwrap();
    assert_eq!(row["name"], "工作账号");
    assert_eq!(row["managed"], true);
    assert_eq!(row["isDefault"], true);
    assert_eq!(row["agent"], "claude");
    // The native row yields default while a managed default exists.
    assert_eq!(
        account(&result, "native-claude").unwrap()["isDefault"],
        false
    );
    let root = harness.account_root(&id);
    let metadata = std::fs::metadata(&root).unwrap();
    assert!(metadata.is_dir());
    assert_eq!(metadata.permissions().mode() & 0o777, 0o700);

    // A second account is not default; setDefault moves the flag.
    let (_, result2) = harness
        .post(control(
            "agent.account.create",
            serde_json::json!({"agent":"claude","name":"second"})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    let id2 = created_id(&result2);
    assert_eq!(account(&result2, &id2).unwrap()["isDefault"], false);
    let (status, _) = harness
        .post(control(
            "agent.account.default",
            serde_json::json!({"accountId": id2})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, listed) = harness
        .post(control("agent.accounts.list", serde_json::Map::new()))
        .await;
    assert_eq!(account(&listed, &id).unwrap()["isDefault"], false);
    assert_eq!(account(&listed, &id2).unwrap()["isDefault"], true);

    // Rename.
    let (status, renamed) = harness
        .post(control(
            "agent.account.rename",
            serde_json::json!({"accountId": id, "name":"renamed"})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(account(&renamed, &id).unwrap()["name"], "renamed");

    // Credential: 0600 file inside the isolated root, shape {kind,secret}.
    let (status, _) = harness
        .post(control(
            "agent.account.credential.set",
            serde_json::json!({
                "accountId": id,
                "credentialKind": "api_key",
                "credential": format!("  {SECRET}  "),
            })
            .as_object()
            .unwrap()
            .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    let credential_path = root.join(".prospero-credential.json");
    let metadata = std::fs::metadata(&credential_path).unwrap();
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    let stored: Value =
        serde_json::from_str(&std::fs::read_to_string(&credential_path).unwrap()).unwrap();
    assert_eq!(stored["kind"], "api_key");
    assert_eq!(stored["secret"], SECRET);

    // Logout deletes only the credential file, never the account row/root.
    let (status, _) = harness
        .post(control(
            "agent.account.logout",
            serde_json::json!({"accountId": id})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!credential_path.exists());
    assert!(root.exists());

    // Re-login with an oauth token.
    let (status, _) = harness
        .post(control(
            "agent.account.credential.set",
            serde_json::json!({
                "accountId": id,
                "credentialKind": "oauth_token",
                "credential": SECRET,
            })
            .as_object()
            .unwrap()
            .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);

    // Delete removes the row and the whole isolated root.
    let (status, deleted) = harness
        .post(control(
            "agent.account.delete",
            serde_json::json!({"accountId": id})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(account(&deleted, &id).is_none());
    assert!(!root.exists());
    drop(harness);
}

#[tokio::test]
async fn native_and_unknown_account_mutations_are_rejected() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;

    // Every native-id mutation is a 403.
    for kind in [
        "agent.account.rename",
        "agent.account.default",
        "agent.account.login",
        "agent.account.credential.set",
        "agent.account.logout",
        "agent.account.delete",
    ] {
        let mut extra = serde_json::Map::new();
        extra.insert("accountId".into(), serde_json::json!("native-claude"));
        if kind == "agent.account.login" {
            extra.insert("cols".into(), serde_json::json!(120));
            extra.insert("rows".into(), serde_json::json!(40));
        }
        if kind == "agent.account.rename" {
            extra.insert("name".into(), serde_json::json!("x"));
        }
        if kind == "agent.account.credential.set" {
            extra.insert("credentialKind".into(), serde_json::json!("api_key"));
            extra.insert("credential".into(), serde_json::json!(SECRET));
        }
        let (status, _) = harness.post(control(kind, extra)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{kind}");
    }

    // Managed actions against an unknown id are 404.
    let (status, _) = harness
        .post(control(
            "agent.account.rename",
            serde_json::json!({"accountId":"00000000-0000-0000-0000-000000000000","name":"x"})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Only Claude managed accounts are supported.
    let (status, _) = harness
        .post(control(
            "agent.account.create",
            serde_json::json!({"agent":"codex","name":"x"})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Validation errors are 400. Shape checks that are not account-specific
    // use a synthetic id; per-credential checks need an existing account
    // because the store resolves the row first.
    let (_, created) = harness
        .post(control(
            "agent.account.create",
            serde_json::json!({"agent":"claude","name":"shape"})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    let real_id = created_id(&created);
    for payload in [
        serde_json::json!({"type":"agent.account.create","requestId":"r","agent":"claude","name":"  "}),
        serde_json::json!({"type":"agent.account.create","requestId":"r","agent":"claude","name":("a".repeat(81))}),
        serde_json::json!({"type":"agent.accounts.list","requestId":""}),
        serde_json::json!({"type":"agent.account.login","requestId":"r","accountId":"a","cols":1,"rows":40}),
        serde_json::json!({"type":"agent.account.credential.set","requestId":"r",
            "accountId":"a","credentialKind":"bad","credential":SECRET}),
        serde_json::json!({"type":"agent.account.credential.set","requestId":"r",
            "accountId": real_id,"credentialKind":"api_key","credential":"short"}),
    ] {
        let (status, _) = harness.post(payload).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    drop(harness);
}

#[tokio::test]
async fn active_agent_session_and_live_login_pty_block_deletion() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let (_, created) = harness
        .post(control(
            "agent.account.create",
            serde_json::json!({"agent":"claude","name":"busy"})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    let id = created_id(&created);

    // Structured session bound to the managed account.
    let workspace = harness.directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let (status, session) = harness
        .post_path(
            "/v1/agent-sessions",
            serde_json::json!({
                "title": "Claude",
                "workspace": workspace.to_str().unwrap(),
                "autoApprove": false,
                "accountId": id,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let session_id = session["id"].as_str().unwrap();

    // The binding is persisted and visible in the snapshot's active count.
    let bound: Option<String> = harness
        .raw_connection()
        .query_row(
            "SELECT account_id FROM agent_runs WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(bound.as_deref(), Some(id.as_str()));
    let (_, listed) = harness
        .post(control("agent.accounts.list", serde_json::Map::new()))
        .await;
    assert_eq!(account(&listed, &id).unwrap()["activeSessions"], 1);

    // Delete conflicts while the structured run is active.
    let (status, _) = harness
        .post(control(
            "agent.account.delete",
            serde_json::json!({"accountId": id})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Login PTY: the fake setup-token idles, bound as a terminal run.
    let login_capture = harness.directory.path().join("login.json");
    unsafe {
        std::env::set_var("LOGIN_CAPTURE", &login_capture);
    }
    let (status, login) = harness
        .post(control(
            "agent.account.login",
            serde_json::json!({"accountId": id, "cols": 120, "rows": 40})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{login}");
    assert_eq!(login["accountId"], id);
    let terminal_id = login["sessionId"].as_str().unwrap().to_owned();
    let dumped = wait_for(&login_capture).await;
    assert_eq!(dumped["argv"], serde_json::json!(["setup-token"]));

    // Login env clears every imported secret so setup-token mints a fresh one,
    // and points CLAUDE_CONFIG_DIR at the isolated root.
    let env = &dumped["env"];
    assert_eq!(env["ANTHROPIC_API_KEY"], "");
    assert_eq!(env["CLAUDE_CODE_OAUTH_TOKEN"], "");
    assert_eq!(
        env["CLAUDE_CONFIG_DIR"],
        harness.account_root(&id).to_str().unwrap()
    );
    assert_eq!(
        env["CLAUDE_CODE_OAUTH_REFRESH_TOKEN"], "",
        "login must not inherit an imported refresh token"
    );
    let bound: Option<String> = harness
        .raw_connection()
        .query_row(
            "SELECT account_id FROM terminal_runs WHERE session_id=?1",
            [terminal_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(bound.as_deref(), Some(id.as_str()));

    // Still blocked, now by both runs.
    let (status, _) = harness
        .post(control(
            "agent.account.delete",
            serde_json::json!({"accountId": id})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Close the login PTY and archive the structured session; delete succeeds.
    let status = harness
        .post_path(
            &format!("/v1/terminals/{terminal_id}/close"),
            serde_json::json!({}),
        )
        .await
        .0;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        harness
            .delete_path(&format!("/v1/agent-sessions/{session_id}"))
            .await,
        StatusCode::OK
    );
    // Wait for the terminal run to finalize after process exit.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let active: i64 = harness
            .raw_connection()
            .query_row(
                "SELECT COUNT(*) FROM terminal_runs WHERE session_id=?1 AND active=1",
                [terminal_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        if active == 0 {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let (status, deleted) = harness
        .post(control(
            "agent.account.delete",
            serde_json::json!({"accountId": id})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    assert!(!harness.account_root(&id).exists());
    drop(harness);
}

#[tokio::test]
async fn managed_turns_run_with_isolated_credential_environment() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;

    // Account without a credential: the turn receives the non-secret sentinel
    // so the CLI cannot fall back to a shared Keychain identity.
    let (_, created) = harness
        .post(control(
            "agent.account.create",
            serde_json::json!({"agent":"claude","name":"fresh"})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    let id = created_id(&created);
    let workspace = harness.directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let (_, session) = harness
        .post_path(
            "/v1/agent-sessions",
            serde_json::json!({
                "title": "Claude",
                "workspace": workspace.to_str().unwrap(),
                "accountId": id,
            }),
        )
        .await;
    let session_id = session["id"].as_str().unwrap().to_owned();
    let capture = harness.directory.path().join("turn-empty.json");
    unsafe {
        std::env::set_var("CAPTURE", &capture);
    }
    let (status, _) = harness
        .post_path(
            &format!("/v1/agent-sessions/{session_id}/send"),
            serde_json::json!({"text":"hi"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let dumped = wait_for(&capture).await;
    let env = &dumped["env"];
    assert_eq!(
        env["CLAUDE_CODE_OAUTH_TOKEN"],
        "prospero-managed-account-not-authenticated"
    );
    assert_eq!(env["ANTHROPIC_API_KEY"], "");
    assert_eq!(
        env["CLAUDE_CONFIG_DIR"],
        harness.account_root(&id).to_str().unwrap()
    );
    unsafe {
        std::env::remove_var("CAPTURE");
    }
    assert_eq!(
        harness
            .delete_path(&format!("/v1/agent-sessions/{session_id}"))
            .await,
        StatusCode::OK
    );

    // With an api_key credential the secret reaches only the CLI environment.
    let (status, _) = harness
        .post(control(
            "agent.account.credential.set",
            serde_json::json!({
                "accountId": id,
                "credentialKind": "api_key",
                "credential": SECRET,
            })
            .as_object()
            .unwrap()
            .clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, session2) = harness
        .post_path(
            "/v1/agent-sessions",
            serde_json::json!({
                "title": "Claude",
                "workspace": workspace.to_str().unwrap(),
                "accountId": id,
            }),
        )
        .await;
    let session2_id = session2["id"].as_str().unwrap().to_owned();
    let capture2 = harness.directory.path().join("turn-secret.json");
    unsafe {
        std::env::set_var("CAPTURE", &capture2);
    }
    let (status, _) = harness
        .post_path(
            &format!("/v1/agent-sessions/{session2_id}/send"),
            serde_json::json!({"text":"hi"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let dumped = wait_for(&capture2).await;
    let env = &dumped["env"];
    assert_eq!(env["ANTHROPIC_API_KEY"], SECRET);
    assert_eq!(env["CLAUDE_CODE_OAUTH_TOKEN"], "");
    assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "");

    // The secret never rides back in a snapshot response.
    let (_, listed) = harness
        .post(control("agent.accounts.list", serde_json::Map::new()))
        .await;
    assert!(!listed.to_string().contains(SECRET));

    assert_eq!(
        harness
            .delete_path(&format!("/v1/agent-sessions/{session2_id}"))
            .await,
        StatusCode::OK
    );
    drop(harness);
}

#[tokio::test]
async fn unknown_managed_account_cannot_bind_a_session() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let workspace = harness.directory.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let (status, body) = harness
        .post_path(
            "/v1/agent-sessions",
            serde_json::json!({
                "title": "Claude",
                "workspace": workspace.to_str().unwrap(),
                "accountId": "00000000-0000-0000-0000-000000000000",
            }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    drop(harness);
}

#[tokio::test]
async fn catalog_route_serves_managed_accounts_and_rejects_others() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new().await;
    let (_, created) = harness
        .post(control(
            "agent.account.create",
            serde_json::json!({"agent":"claude","name":"cat"})
                .as_object()
                .unwrap()
                .clone(),
        ))
        .await;
    let id = created_id(&created);

    async fn get(app: &axum::Router, secret: &str, uri: &str) -> (StatusCode, Value) {
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
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    let (status, catalog) = get(
        &harness.app,
        harness.secret,
        &format!("/v1/launch/models?agent=claude&accountId={id}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{catalog}");
    assert_eq!(catalog["models"][0]["id"], "default");

    let (status, _) = get(
        &harness.app,
        harness.secret,
        "/v1/launch/models?agent=codex&accountId=x",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = get(
        &harness.app,
        harness.secret,
        "/v1/launch/models?agent=claude&accountId=missing-id",
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    drop(harness);
}
