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
        Err(Error::Closed)
    ));
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
async fn overload_is_rejected_at_the_queue_limit() {
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
    assert!(matches!(database.call(|_| Ok(())).await, Err(Error::Busy)));
    release.send(()).unwrap();
    blocker.await.unwrap().unwrap();
    for call in queued {
        call.await.unwrap();
    }
    database.shutdown().await.unwrap();
}
