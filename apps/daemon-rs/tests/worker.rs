use std::future::{Future, poll_fn};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::task::Poll;
use std::time::Duration;

use prosperod_rs::error::Error;
use prosperod_rs::protocol::DATABASE_QUEUE_CAPACITY;
use prosperod_rs::worker::{Database, DatabaseOptions};
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
async fn overload_is_bounded_and_reports_structured_pressure() {
    let directory = TempDir::new().unwrap();
    let database = Database::open_with_options(
        directory.path().to_path_buf(),
        None,
        DatabaseOptions {
            background_queue_capacity: 1,
            background_waiter_capacity: 1,
            background_enqueue_timeout: Duration::from_millis(40),
            degraded_queue_depth: 2,
            recovered_queue_depth: 0,
            overload_duration: Duration::ZERO,
            ..DatabaseOptions::default()
        },
    )
    .await
    .unwrap();
    let (release, barrier) = std::sync::mpsc::channel();
    let (started, waiting) = tokio::sync::oneshot::channel();
    let clone = database.clone();
    let blocker = tokio::spawn(async move {
        clone
            .call_background("test.blocker", move |_| {
                let _ = started.send(());
                barrier.recv_timeout(Duration::from_secs(2)).unwrap();
                Ok(())
            })
            .await
    });
    waiting.await.unwrap();
    let clone = database.clone();
    let queued =
        tokio::spawn(async move { clone.call_background("test.queued", |_| Ok(())).await });
    while database.health().queued != 1 {
        tokio::task::yield_now().await;
    }
    let clone = database.clone();
    let timed_out =
        tokio::spawn(async move { clone.call_background("test.timeout", |_| Ok(())).await });
    while database.health().waiting != 1 {
        tokio::task::yield_now().await;
    }
    let error = database
        .call_background("test.rejected", |_| Ok(()))
        .await
        .unwrap_err();
    let body = error.public();
    assert_eq!(body.code, "busy");
    assert_eq!(body.operation.as_deref(), Some("test.rejected"));
    assert_eq!(body.side_effect_committed, Some(false));
    let Error::Backpressure(pressure) = error else {
        panic!("expected resource backpressure");
    };
    assert_eq!(pressure.operation, "test.rejected");
    assert_eq!(pressure.resource, "database.background_queue");
    assert_eq!(pressure.queue_capacity, 1);
    assert_eq!(pressure.side_effect_committed, Some(false));
    assert!(database.health().degraded);
    assert!(matches!(
        timed_out.await.unwrap(),
        Err(Error::Backpressure(_))
    ));
    release.send(()).unwrap();
    blocker.await.unwrap().unwrap();
    queued.await.unwrap().unwrap();
    let health = database.health();
    assert_eq!(health.waiting, 0);
    assert_eq!(health.queued, 0);
    assert_eq!(health.inflight, 0);
    assert!(!health.degraded);
    let metrics = database.metrics();
    assert_eq!(metrics.database_rejected_total, 2);
    assert_eq!(metrics.database_rejected_by_operation["test.rejected"], 1);
    assert_eq!(metrics.rejected_total, 2);
    assert_eq!(metrics.rejected_by_operation["test.rejected"], 1);
    assert_eq!(metrics.rejected_by_operation["test.timeout"], 1);
    assert_eq!(metrics.recent_rejected_total, 2);
    assert_eq!(database.recent_rejections("test."), 2);
    assert_eq!(metrics.recent_errors.len(), 2);
    assert!(metrics.high_watermark >= 3);
    assert_eq!(Error::Busy.public().retry_after_ms, Some(100));
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn control_capacity_is_reserved_and_weighted_fairly() {
    let directory = TempDir::new().unwrap();
    let database = Database::open_with_options(
        directory.path().to_path_buf(),
        None,
        DatabaseOptions {
            background_queue_capacity: 4,
            control_queue_capacity: 4,
            control_weight: 2,
            degraded_queue_depth: 100,
            ..DatabaseOptions::default()
        },
    )
    .await
    .unwrap();
    let (release, barrier) = std::sync::mpsc::channel();
    let (started, waiting) = tokio::sync::oneshot::channel();
    let clone = database.clone();
    let blocker = tokio::spawn(async move {
        clone
            .call_background("test.blocker", move |_| {
                let _ = started.send(());
                barrier.recv_timeout(Duration::from_secs(2)).unwrap();
                Ok(())
            })
            .await
    });
    waiting.await.unwrap();
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut calls = Vec::new();
    for label in ["c1", "c2", "c3", "c4"] {
        let clone = database.clone();
        let order = order.clone();
        calls.push(tokio::spawn(async move {
            clone
                .call_control(format!("test.{label}"), move |_| {
                    order.lock().unwrap().push(label);
                    Ok(())
                })
                .await
        }));
    }
    for label in ["b1", "b2"] {
        let clone = database.clone();
        let order = order.clone();
        calls.push(tokio::spawn(async move {
            clone
                .call_background(format!("test.{label}"), move |_| {
                    order.lock().unwrap().push(label);
                    Ok(())
                })
                .await
        }));
    }
    while database.health().queued != 6 {
        tokio::task::yield_now().await;
    }
    assert_eq!(database.health().control_queue_depth, 4);
    assert_eq!(database.health().background_queue_depth, 3);
    release.send(()).unwrap();
    blocker.await.unwrap().unwrap();
    for call in calls {
        call.await.unwrap().unwrap();
    }
    {
        let order = order.lock().unwrap();
        assert_eq!(order.len(), 6);
        assert!(order[0].starts_with('c'));
        assert!(order[1].starts_with('c'));
        assert!(order[2].starts_with('b'));
        assert!(order[3].starts_with('c'));
        assert!(order[4].starts_with('c'));
        assert!(order[5].starts_with('b'));
    }
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
