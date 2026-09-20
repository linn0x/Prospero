use std::future::{Future, poll_fn};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::task::Poll;
use std::time::Duration;

use prosperod_rs::error::Error;
use prosperod_rs::protocol::DATABASE_QUEUE_CAPACITY;
use prosperod_rs::worker::Database;
use tempfile::TempDir;

#[tokio::test]
async fn blocking_database_jobs_do_not_block_the_async_executor() {
    let directory = TempDir::new().unwrap();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    let clone = database.clone();
    let running = tokio::spawn(async move {
        clone
            .call(|_| {
                std::thread::sleep(Duration::from_millis(100));
                Ok(())
            })
            .await
    });
    tokio::time::timeout(
        Duration::from_millis(50),
        tokio::time::sleep(Duration::from_millis(5)),
    )
    .await
    .unwrap();
    running.await.unwrap().unwrap();
    database.shutdown().await.unwrap();
    assert!(matches!(
        database.call(|_| Ok(())).await,
        Err(Error::DatabaseUnavailable(_))
    ));
}

#[tokio::test]
async fn database_health_reports_queue_depth_and_shutdown() {
    let directory = TempDir::new().unwrap();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    assert!(database.health().alive);
    assert_eq!(database.health().queue_depth, 0);
    assert_eq!(database.health().last_error, None);
    let (release, barrier) = std::sync::mpsc::channel();
    let (started, waiting) = tokio::sync::oneshot::channel();
    let clone = database.clone();
    let blocker = tokio::spawn(async move {
        clone
            .call(move |_| {
                let _ = started.send(());
                barrier.recv_timeout(Duration::from_secs(2)).unwrap();
                Ok(())
            })
            .await
    });
    waiting.await.unwrap();
    assert_eq!(database.health().queue_depth, 1);
    release.send(()).unwrap();
    blocker.await.unwrap().unwrap();
    assert_eq!(database.health().queue_depth, 0);
    database.shutdown().await.unwrap();
    assert!(!database.health().alive);
    assert!(matches!(
        database.call(|_| Ok(())).await,
        Err(Error::DatabaseUnavailable(_))
    ));
}

#[tokio::test]
async fn database_operation_panic_is_isolated_and_reported() {
    let directory = TempDir::new().unwrap();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    assert!(matches!(
        database
            .call::<(), _>(|_| panic!("synthetic database operation panic"))
            .await,
        Err(Error::DatabaseOperationFailed(_))
    ));
    let health = database.health();
    assert!(health.alive);
    assert_eq!(health.queue_depth, 0);
    assert_eq!(
        health.last_error.as_deref(),
        Some("synthetic database operation panic")
    );
    database.call(|_| Ok(())).await.unwrap();
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_cancelled_queued_operation_is_not_executed() {
    let directory = TempDir::new().unwrap();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    let (release, barrier) = std::sync::mpsc::channel();
    let (started, waiting) = tokio::sync::oneshot::channel();
    let clone = database.clone();
    let blocker = tokio::spawn(async move {
        clone
            .call(move |_| {
                let _ = started.send(());
                barrier.recv_timeout(Duration::from_secs(2)).unwrap();
                Ok(())
            })
            .await
    });
    waiting.await.unwrap();
    let executed = Arc::new(AtomicBool::new(false));
    let flag = executed.clone();
    let clone = database.clone();
    let queued = tokio::spawn(async move {
        clone
            .call(move |_| {
                flag.store(true, Ordering::Release);
                Ok(())
            })
            .await
    });
    tokio::task::yield_now().await;
    queued.abort();
    let _ = queued.await;
    release.send(()).unwrap();
    blocker.await.unwrap().unwrap();
    database.call(|_| Ok(())).await.unwrap();
    assert!(!executed.load(Ordering::Acquire));
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn overload_waits_for_database_queue_capacity() {
    let directory = TempDir::new().unwrap();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    let (release, barrier) = std::sync::mpsc::channel();
    let (started, waiting) = tokio::sync::oneshot::channel();
    let clone = database.clone();
    let blocker = tokio::spawn(async move {
        clone
            .call(move |_| {
                let _ = started.send(());
                barrier.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(())
            })
            .await
    });
    waiting.await.unwrap();
    let mut queued = Vec::new();
    for _ in 0..DATABASE_QUEUE_CAPACITY {
        let mut call = Box::pin(database.call(|_| Ok(())));
        assert!(poll_fn(|cx| Poll::Ready(call.as_mut().poll(cx).is_pending())).await);
        queued.push(call);
    }
    let mut overflow = Box::pin(database.call(|_| Ok(())));
    assert!(poll_fn(|cx| Poll::Ready(overflow.as_mut().poll(cx).is_pending())).await);
    assert!(
        database.health().queue_depth >= DATABASE_QUEUE_CAPACITY,
        "backlogged calls should be visible in health"
    );
    release.send(()).unwrap();
    blocker.await.unwrap().unwrap();
    for call in queued {
        call.await.unwrap();
    }
    overflow.await.unwrap();
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn database_worker_imports_legacy_orchestration_when_configured() {
    let legacy = TempDir::new().unwrap();
    let legacy_db = rusqlite::Connection::open(legacy.path().join("orchestration.sqlite")).unwrap();
    legacy_db
        .execute_batch(
            "CREATE TABLE runs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE tasks(id TEXT PRIMARY KEY, run_id TEXT, data TEXT NOT NULL);
             CREATE TABLE dispatches(id TEXT PRIMARY KEY, run_id TEXT, data TEXT NOT NULL);
             CREATE TABLE gates(id TEXT PRIMARY KEY, run_id TEXT, data TEXT NOT NULL);",
        )
        .unwrap();
    legacy_db
        .execute(
            "INSERT INTO runs(id,data) VALUES('run_worker_legacy',?1)",
            [serde_json::json!({
                "id": "run_worker_legacy",
                "objective": "legacy worker import",
                "status": "active",
                "coordinatorSessionId": null,
                "graphRevision": 1,
                "createdAt": 1,
                "updatedAt": 1
            })
            .to_string()],
        )
        .unwrap();
    drop(legacy_db);
    let directory = TempDir::new().unwrap();
    {
        let database = Database::open(directory.path().to_path_buf())
            .await
            .unwrap();
        assert_eq!(
            database
                .call(|store| Ok(store.list_runs()?.len()))
                .await
                .unwrap(),
            0
        );
        database.shutdown().await.unwrap();
    }
    let database = Database::open_with_legacy_home(
        directory.path().to_path_buf(),
        Some(legacy.path().to_path_buf()),
    )
    .await
    .unwrap();
    assert_eq!(
        database
            .call(|store| Ok(store.list_runs()?.len()))
            .await
            .unwrap(),
        1
    );
    database.shutdown().await.unwrap();
    std::fs::remove_file(legacy.path().join("orchestration.sqlite")).unwrap();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    let legacy_path = legacy.path().to_path_buf();
    assert_eq!(
        database
            .call(move |store| store.import_legacy_orchestration(&legacy_path))
            .await
            .unwrap(),
        0
    );
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn database_worker_imports_missing_legacy_files_after_marker_exists() {
    let legacy = TempDir::new().unwrap();
    std::fs::write(
        legacy.path().join("config.json"),
        serde_json::json!({
            "port": 7424,
            "relay": {
                "enabled": true,
                "url": "wss://relay.example.com",
                "hostSecret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        legacy.path().join("devices.json"),
        serde_json::json!({
            "devices": [{
                "name": "phone",
                "token": "pairing-token",
                "allowShell": true,
                "allowOrchestration": true,
                "relayDeviceId": "device-id",
                "relayToken": "relay-token",
                "relayCredentialIssued": true,
                "createdAt": 1
            }]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        legacy.path().join("relay-sync-state.json"),
        serde_json::json!({
            "version": 1,
            "routes": {
                "CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk": 42
            }
        })
        .to_string(),
    )
    .unwrap();
    let directory = TempDir::new().unwrap();
    std::fs::write(
        directory.path().join("config.json"),
        serde_json::json!({ "port": 7424 }).to_string(),
    )
    .unwrap();
    std::fs::write(
        directory.path().join("relay-sync-state.json"),
        serde_json::json!({
            "version": 1,
            "routes": {
                "CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk": 7
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        directory.path().join("legacy-orchestration-import.json"),
        "{}",
    )
    .unwrap();
    let database = Database::open_with_legacy_home(
        directory.path().to_path_buf(),
        Some(legacy.path().to_path_buf()),
    )
    .await
    .unwrap();
    database.shutdown().await.unwrap();
    let config = std::fs::read_to_string(directory.path().join("config.json")).unwrap();
    let devices = std::fs::read_to_string(directory.path().join("devices.json")).unwrap();
    let sync: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(directory.path().join("relay-sync-state.json")).unwrap(),
    )
    .unwrap();
    assert!(config.contains("relay.example.com"));
    assert!(config.contains("\"port\": 7424"));
    assert!(devices.contains("relay-token"));
    assert_eq!(
        sync["routes"]["CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk"].as_u64(),
        Some(42)
    );
}
