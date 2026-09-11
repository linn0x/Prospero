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

fn input(directory: &TempDir) -> CreateTerminal {
    CreateTerminal {
        title: "Test terminal".into(),
        workspace: directory.path().to_str().unwrap().into(),
        size: TerminalSize { cols: 80, rows: 24 },
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
    tokio::time::sleep(Duration::from_millis(400)).await;
    let count: i64 = connection
        .query_row("SELECT count(*) FROM checkpoint_writes", [], |row| {
            row.get(0)
        })
        .unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
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
