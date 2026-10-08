use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore, oneshot};
use ts_rs::TS;

use crate::database::Store;
use crate::error::{Error, ResourceBackpressure, Result};

type Operation = Box<dyn FnOnce(&mut Store) + Send>;

#[derive(Debug, Clone)]
pub(crate) struct ReaderOptions {
    pub threads: usize,
    pub queue_capacity: usize,
    pub waiter_capacity: usize,
    pub enqueue_timeout: Duration,
    pub retry_after_ms: u64,
    pub latency_sample_capacity: usize,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReaderLatencyPercentiles {
    pub samples: usize,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReadPoolHealth {
    pub alive: bool,
    pub degraded: bool,
    pub reader_count: usize,
    pub alive_readers: usize,
    pub waiting: usize,
    pub queued: usize,
    pub inflight: usize,
    pub queue_capacity: usize,
    pub waiter_capacity: usize,
    pub high_watermark: usize,
    pub oldest_queued_age_ms: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReadPoolMetrics {
    pub queue_latency: ReaderLatencyPercentiles,
    pub execution_latency: ReaderLatencyPercentiles,
    pub rejected_total: u64,
    pub rejected_by_operation: BTreeMap<String, u64>,
}

struct State {
    waiting: AtomicUsize,
    queued: AtomicUsize,
    inflight: AtomicUsize,
    high_watermark: AtomicUsize,
    alive_readers: AtomicUsize,
    failed: AtomicBool,
    next_id: AtomicU64,
    oldest: Mutex<BTreeMap<u64, Instant>>,
    queue_latencies: Mutex<VecDeque<u64>>,
    execution_latencies: Mutex<VecDeque<u64>>,
    rejected_total: AtomicU64,
    rejected_by_operation: Mutex<BTreeMap<String, u64>>,
    last_error: Mutex<Option<String>>,
    options: ReaderOptions,
}

struct SharedQueue {
    jobs: Mutex<VecDeque<Job>>,
    available: Condvar,
    stopping: AtomicBool,
}

struct Inner {
    state: Arc<State>,
    queue: Arc<SharedQueue>,
    slots: Arc<Semaphore>,
    closed: AtomicBool,
    threads: AsyncMutex<Vec<thread::JoinHandle<()>>>,
}

#[derive(Clone)]
pub(crate) struct ReaderPool(Arc<Inner>);

struct Waiting {
    state: Arc<State>,
    active: bool,
}

struct Queued {
    state: Arc<State>,
    id: u64,
    enqueued: Instant,
    active: bool,
}

struct Inflight {
    state: Arc<State>,
    started: Instant,
}

struct Job {
    operation: Operation,
    queued: Queued,
    permit: Option<OwnedSemaphorePermit>,
}

struct Alive {
    state: Arc<State>,
    queue: Arc<SharedQueue>,
}

struct Startup {
    queue: Arc<SharedQueue>,
    threads: Vec<thread::JoinHandle<()>>,
    active: bool,
}

impl SharedQueue {
    fn stop(&self) {
        let jobs = self.jobs.lock().unwrap();
        self.stopping.store(true, Ordering::Release);
        drop(jobs);
        self.available.notify_all();
    }
}

impl Startup {
    fn finish(mut self) -> Vec<thread::JoinHandle<()>> {
        self.active = false;
        std::mem::take(&mut self.threads)
    }
}

impl Drop for Startup {
    fn drop(&mut self) {
        if self.active {
            self.queue.stop();
            for handle in self.threads.drain(..) {
                let _ = handle.join();
            }
        }
    }
}

impl State {
    fn depth(&self) -> usize {
        self.waiting.load(Ordering::Acquire)
            + self.queued.load(Ordering::Acquire)
            + self.inflight.load(Ordering::Acquire)
    }

    fn observe_depth(&self) {
        let depth = self.depth();
        let mut current = self.high_watermark.load(Ordering::Acquire);
        while depth > current {
            match self.high_watermark.compare_exchange_weak(
                current,
                depth,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(value) => current = value,
            }
        }
    }

    fn begin_wait(self: &Arc<Self>, operation: &str) -> Result<Waiting> {
        let mut current = self.waiting.load(Ordering::Acquire);
        loop {
            if current >= self.options.waiter_capacity {
                return Err(self.reject(operation));
            }
            match self.waiting.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(value) => current = value,
            }
        }
        self.observe_depth();
        Ok(Waiting {
            state: self.clone(),
            active: true,
        })
    }

    fn reject(&self, operation: &str) -> Error {
        self.rejected_total.fetch_add(1, Ordering::AcqRel);
        *self
            .rejected_by_operation
            .lock()
            .unwrap()
            .entry(operation.into())
            .or_default() += 1;
        Error::Backpressure(ResourceBackpressure {
            retry_after_ms: self.options.retry_after_ms,
            operation: operation.into(),
            resource: "database.read_queue".into(),
            queue_depth: self.queued.load(Ordering::Acquire),
            queue_capacity: self.options.queue_capacity,
            side_effect_committed: Some(false),
        })
    }

    fn push_latency(&self, samples: &Mutex<VecDeque<u64>>, duration: Duration) {
        let mut samples = samples.lock().unwrap();
        if samples.len() == self.options.latency_sample_capacity {
            samples.pop_front();
        }
        samples.push_back(duration.as_millis().min(u128::from(u64::MAX)) as u64);
    }

    fn oldest_age_ms(&self) -> u64 {
        self.oldest
            .lock()
            .unwrap()
            .values()
            .min()
            .map(|value| value.elapsed().as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0)
    }

    fn set_error(&self, message: String) {
        *self.last_error.lock().unwrap() = Some(message);
    }
}

impl Waiting {
    fn enqueue(mut self) -> Queued {
        self.active = false;
        self.state.queued.fetch_add(1, Ordering::AcqRel);
        self.state.waiting.fetch_sub(1, Ordering::AcqRel);
        let id = self.state.next_id.fetch_add(1, Ordering::AcqRel);
        let enqueued = Instant::now();
        self.state.oldest.lock().unwrap().insert(id, enqueued);
        self.state.observe_depth();
        Queued {
            state: self.state.clone(),
            id,
            enqueued,
            active: true,
        }
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        if self.active {
            self.state.waiting.fetch_sub(1, Ordering::AcqRel);
            self.state.observe_depth();
        }
    }
}

impl Queued {
    fn start(mut self) -> Inflight {
        self.active = false;
        self.state.inflight.fetch_add(1, Ordering::AcqRel);
        self.state.queued.fetch_sub(1, Ordering::AcqRel);
        self.state.oldest.lock().unwrap().remove(&self.id);
        self.state
            .push_latency(&self.state.queue_latencies, self.enqueued.elapsed());
        self.state.observe_depth();
        Inflight {
            state: self.state.clone(),
            started: Instant::now(),
        }
    }
}

impl Drop for Queued {
    fn drop(&mut self) {
        if self.active {
            self.state.queued.fetch_sub(1, Ordering::AcqRel);
            self.state.oldest.lock().unwrap().remove(&self.id);
            self.state.observe_depth();
        }
    }
}

impl Drop for Inflight {
    fn drop(&mut self) {
        self.state
            .push_latency(&self.state.execution_latencies, self.started.elapsed());
        self.state.inflight.fetch_sub(1, Ordering::AcqRel);
        self.state.observe_depth();
    }
}

impl Job {
    fn execute(mut self, store: &mut Store) {
        self.permit.take();
        let _inflight = self.queued.start();
        (self.operation)(store);
    }
}

impl Drop for Alive {
    fn drop(&mut self) {
        self.state.alive_readers.fetch_sub(1, Ordering::AcqRel);
        if !self.queue.stopping.load(Ordering::Acquire) {
            self.state.set_error("database reader stopped".into());
            self.state.failed.store(true, Ordering::Release);
            self.queue.stop();
        }
    }
}

impl ReaderPool {
    pub(crate) async fn open(
        directory: PathBuf,
        lock: Arc<std::fs::File>,
        options: ReaderOptions,
    ) -> Result<Self> {
        let state = Arc::new(State {
            waiting: AtomicUsize::new(0),
            queued: AtomicUsize::new(0),
            inflight: AtomicUsize::new(0),
            high_watermark: AtomicUsize::new(0),
            alive_readers: AtomicUsize::new(0),
            failed: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            oldest: Mutex::new(BTreeMap::new()),
            queue_latencies: Mutex::new(VecDeque::new()),
            execution_latencies: Mutex::new(VecDeque::new()),
            rejected_total: AtomicU64::new(0),
            rejected_by_operation: Mutex::new(BTreeMap::new()),
            last_error: Mutex::new(None),
            options,
        });
        let queue = Arc::new(SharedQueue {
            jobs: Mutex::new(VecDeque::new()),
            available: Condvar::new(),
            stopping: AtomicBool::new(false),
        });
        let mut startup = Startup {
            queue: queue.clone(),
            threads: Vec::new(),
            active: true,
        };
        for index in 0..state.options.threads {
            let (ready, initialized) = oneshot::channel();
            let thread_state = state.clone();
            let thread_queue = queue.clone();
            let thread_directory = directory.clone();
            let thread_lock = lock.clone();
            let handle = thread::Builder::new()
                .name(format!("prospero-database-reader-{index}"))
                .spawn(move || {
                    let mut store = match Store::open_reader(&thread_directory, thread_lock) {
                        Ok(store) => store,
                        Err(error) => {
                            thread_state.set_error(error.to_string());
                            let _ = ready.send(Err(error));
                            return;
                        }
                    };
                    thread_state.alive_readers.fetch_add(1, Ordering::AcqRel);
                    let _alive = Alive {
                        state: thread_state.clone(),
                        queue: thread_queue.clone(),
                    };
                    if ready.send(Ok(())).is_err() {
                        return;
                    }
                    loop {
                        let job = {
                            let mut jobs = thread_queue.jobs.lock().unwrap();
                            loop {
                                if let Some(job) = jobs.pop_front() {
                                    break Some(job);
                                }
                                if thread_queue.stopping.load(Ordering::Acquire) {
                                    break None;
                                }
                                jobs = thread_queue.available.wait(jobs).unwrap();
                            }
                        };
                        let Some(job) = job else {
                            break;
                        };
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            job.execute(&mut store)
                        }));
                        if let Err(payload) = result {
                            thread_state.set_error(panic_message(payload));
                        }
                    }
                })
                .map_err(Error::from)?;
            startup.threads.push(handle);
            initialized.await.map_err(|_| Error::Closed)??;
        }
        let threads = startup.finish();
        Ok(Self(Arc::new(Inner {
            slots: Arc::new(Semaphore::new(state.options.queue_capacity)),
            state,
            queue,
            closed: AtomicBool::new(false),
            threads: AsyncMutex::new(threads),
        })))
    }

    pub(crate) async fn read<T, F>(&self, name: String, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store) -> Result<T> + Send + 'static,
    {
        if self.0.closed.load(Ordering::Acquire) || self.0.state.failed.load(Ordering::Acquire) {
            return Err(self.unavailable());
        }
        let waiting = self.0.state.begin_wait(&name)?;
        let permit = match tokio::time::timeout(
            self.0.state.options.enqueue_timeout,
            self.0.slots.clone().acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => return Err(self.unavailable()),
            Err(_) => return Err(self.0.state.reject(&name)),
        };
        if self.0.closed.load(Ordering::Acquire) || self.0.state.failed.load(Ordering::Acquire) {
            return Err(self.unavailable());
        }
        let queued = waiting.enqueue();
        let (sender, receiver) = oneshot::channel();
        let state = self.0.state.clone();
        let job = Job {
            operation: Box::new(move |store| {
                if sender.is_closed() {
                    return;
                }
                let result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| operation(store)))
                        .unwrap_or_else(|payload| {
                            let message = panic_message(payload);
                            state.set_error(message.clone());
                            Err(Error::DatabaseOperationFailed(message))
                        });
                let _ = sender.send(result);
            }),
            queued,
            permit: Some(permit),
        };
        {
            let mut jobs = self.0.queue.jobs.lock().unwrap();
            if self.0.queue.stopping.load(Ordering::Acquire) {
                return Err(self.unavailable());
            }
            jobs.push_back(job);
        }
        self.0.queue.available.notify_one();
        receiver.await.map_err(|_| {
            Error::DatabaseOperationFailed("database read did not return a result".into())
        })?
    }

    pub(crate) fn health(&self) -> ReadPoolHealth {
        let alive_readers = self.0.state.alive_readers.load(Ordering::Acquire);
        let alive = !self.0.closed.load(Ordering::Acquire)
            && !self.0.state.failed.load(Ordering::Acquire)
            && alive_readers == self.0.state.options.threads;
        let waiting = self.0.state.waiting.load(Ordering::Acquire);
        let queued = self.0.state.queued.load(Ordering::Acquire);
        ReadPoolHealth {
            alive,
            degraded: !alive || waiting + queued >= self.0.state.options.queue_capacity,
            reader_count: self.0.state.options.threads,
            alive_readers,
            waiting,
            queued,
            inflight: self.0.state.inflight.load(Ordering::Acquire),
            queue_capacity: self.0.state.options.queue_capacity,
            waiter_capacity: self.0.state.options.waiter_capacity,
            high_watermark: self.0.state.high_watermark.load(Ordering::Acquire),
            oldest_queued_age_ms: self.0.state.oldest_age_ms(),
            last_error: self.0.state.last_error.lock().unwrap().clone(),
        }
    }

    pub(crate) fn metrics(&self) -> ReadPoolMetrics {
        ReadPoolMetrics {
            queue_latency: percentiles(&self.0.state.queue_latencies),
            execution_latency: percentiles(&self.0.state.execution_latencies),
            rejected_total: self.0.state.rejected_total.load(Ordering::Acquire),
            rejected_by_operation: self.0.state.rejected_by_operation.lock().unwrap().clone(),
        }
    }

    pub(crate) async fn shutdown(&self) -> Result<()> {
        if self.0.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.0.slots.close();
        self.0.queue.stop();
        let handles = std::mem::take(&mut *self.0.threads.lock().await);
        tokio::task::spawn_blocking(move || {
            for handle in handles {
                handle.join().map_err(|_| Error::Closed)?;
            }
            Ok(())
        })
        .await
        .map_err(|_| Error::Closed)?
    }

    fn unavailable(&self) -> Error {
        Error::DatabaseUnavailable(
            self.0
                .state
                .last_error
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| "database read pool is closed".into()),
        )
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        self.slots.close();
        self.queue.stop();
    }
}

fn percentiles(samples: &Mutex<VecDeque<u64>>) -> ReaderLatencyPercentiles {
    let mut values = samples.lock().unwrap().iter().copied().collect::<Vec<_>>();
    values.sort_unstable();
    ReaderLatencyPercentiles {
        samples: values.len(),
        p50_ms: percentile(&values, 50),
        p95_ms: percentile(&values, 95),
        p99_ms: percentile(&values, 99),
    }
}

fn percentile(values: &[u64], percentile: usize) -> u64 {
    if values.is_empty() {
        return 0;
    }
    values[((values.len() - 1) * percentile).div_ceil(100)]
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|value| (*value).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "database read panicked".into())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Barrier};

    use tempfile::TempDir;

    use super::*;
    use crate::worker::{Database, DatabaseOptions};

    fn options() -> DatabaseOptions {
        DatabaseOptions {
            reader_threads: 2,
            read_queue_capacity: 4,
            read_waiter_capacity: 4,
            read_enqueue_timeout: Duration::from_millis(100),
            ..Default::default()
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_reads_execute_concurrently() {
        let directory = TempDir::new().unwrap();
        let database = Database::open_with_options(directory.path().into(), None, options())
            .await
            .unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let mut reads = Vec::new();
        for index in 0..2 {
            let database = database.clone();
            let barrier = barrier.clone();
            reads.push(tokio::spawn(async move {
                database
                    .read(format!("test.parallel.{index}"), move |_| {
                        barrier.wait();
                        std::thread::sleep(Duration::from_millis(100));
                        Ok(index)
                    })
                    .await
            }));
        }
        barrier.wait();
        assert_eq!(database.health().readers.inflight, 2);
        assert_eq!(reads.remove(0).await.unwrap().unwrap(), 0);
        assert_eq!(reads.remove(0).await.unwrap().unwrap(), 1);
        while database.health().readers.inflight != 0 {
            tokio::task::yield_now().await;
        }
        let metrics = database.metrics().readers;
        assert_eq!(metrics.queue_latency.samples, 2);
        assert_eq!(metrics.execution_latency.samples, 2);
        assert!(database.health().readers.high_watermark >= 2);
        database.shutdown().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wal_allows_writer_commit_during_snapshot_read() {
        let directory = TempDir::new().unwrap();
        let database = Database::open_with_options(directory.path().into(), None, options())
            .await
            .unwrap();
        database
            .call_control("test.setup", |store| {
                store.connection.execute_batch(
                    "CREATE TABLE reader_snapshot(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);
                     INSERT INTO reader_snapshot VALUES(1,10),(2,10);",
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let (started, ready) = std::sync::mpsc::channel();
        let (release, proceed) = std::sync::mpsc::channel();
        let clone = database.clone();
        let read = tokio::spawn(async move {
            clone
                .read("test.snapshot", move |store| {
                    store.read_snapshot(|| {
                        let first = store.connection.query_row(
                            "SELECT value FROM reader_snapshot WHERE id=1",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?;
                        started.send(()).unwrap();
                        proceed.recv_timeout(Duration::from_secs(2)).unwrap();
                        let second = store.connection.query_row(
                            "SELECT value FROM reader_snapshot WHERE id=2",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?;
                        Ok((first, second))
                    })
                })
                .await
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        tokio::time::timeout(
            Duration::from_millis(500),
            database.call_control("test.update", |store| {
                store
                    .connection
                    .execute("UPDATE reader_snapshot SET value=20", [])?;
                Ok(())
            }),
        )
        .await
        .unwrap()
        .unwrap();
        release.send(()).unwrap();
        assert_eq!(read.await.unwrap().unwrap(), (10, 10));
        assert_eq!(
            database
                .read("test.visible", |store| {
                    Ok(store.connection.query_row(
                        "SELECT sum(value) FROM reader_snapshot",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?)
                })
                .await
                .unwrap(),
            40
        );
        database.shutdown().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_completes_while_write_transaction_is_open() {
        let directory = TempDir::new().unwrap();
        let database = Database::open_with_options(directory.path().into(), None, options())
            .await
            .unwrap();
        database
            .call_control("test.setup", |store| {
                store.connection.execute_batch(
                    "CREATE TABLE reader_write(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);
                     INSERT INTO reader_write VALUES(1,10);",
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let (started, ready) = std::sync::mpsc::channel();
        let (release, proceed) = std::sync::mpsc::channel();
        let clone = database.clone();
        let writer = tokio::spawn(async move {
            clone
                .call_control("test.transaction", move |store| {
                    let transaction = store.connection.transaction()?;
                    transaction.execute("UPDATE reader_write SET value=20", [])?;
                    started.send(()).unwrap();
                    proceed.recv_timeout(Duration::from_secs(2)).unwrap();
                    transaction.commit()?;
                    Ok(())
                })
                .await
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        let old = tokio::time::timeout(
            Duration::from_millis(500),
            database.read("test.during_write", |store| {
                Ok(store
                    .connection
                    .query_row("SELECT value FROM reader_write", [], |row| {
                        row.get::<_, i64>(0)
                    })?)
            }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(old, 10);
        release.send(()).unwrap();
        writer.await.unwrap().unwrap();
        assert_eq!(
            database
                .read("test.after_write", |store| {
                    Ok(store
                        .connection
                        .query_row("SELECT value FROM reader_write", [], |row| {
                            row.get::<_, i64>(0)
                        })?)
                })
                .await
                .unwrap(),
            20
        );
        database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn reader_rejects_writes_without_poisoning_writer() {
        let directory = TempDir::new().unwrap();
        let database = Database::open_with_options(directory.path().into(), None, options())
            .await
            .unwrap();
        let error = database
            .read("test.reject_write", |store| {
                store
                    .connection
                    .execute("CREATE TABLE forbidden_write(id INTEGER)", [])?;
                Ok(())
            })
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Storage(_)));
        database
            .call_control("test.writer_healthy", |store| {
                store
                    .connection
                    .execute("CREATE TABLE writer_still_healthy(id INTEGER)", [])?;
                Ok(())
            })
            .await
            .unwrap();
        assert!(database.health().alive);
        assert!(database.health().readers.alive);
        database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn nested_snapshot_and_failed_snapshot_leave_reader_usable() {
        let directory = TempDir::new().unwrap();
        let database = Database::open_with_options(directory.path().into(), None, options())
            .await
            .unwrap();
        database
            .call_control("test.setup", |store| {
                store.connection.execute_batch(
                    "CREATE TABLE nested_snapshot(value INTEGER NOT NULL);
                     INSERT INTO nested_snapshot VALUES(7);",
                )?;
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(
            database
                .read("test.nested_snapshot", |store| {
                    store.read_snapshot(|| {
                        store.read_snapshot(|| {
                            Ok(store.connection.query_row(
                                "SELECT value FROM nested_snapshot",
                                [],
                                |row| row.get::<_, i64>(0),
                            )?)
                        })
                    })
                })
                .await
                .unwrap(),
            7
        );
        assert!(matches!(
            database
                .read("test.failed_snapshot", |store| {
                    store.read_snapshot(|| Err::<(), _>(Error::Invalid("fixture".into())))
                })
                .await,
            Err(Error::Invalid(_))
        ));
        assert_eq!(
            database
                .read("test.after_failed_snapshot", |store| {
                    Ok(store.connection.query_row(
                        "SELECT value FROM nested_snapshot",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?)
                })
                .await
                .unwrap(),
            7
        );
        database.shutdown().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_overload_and_cancellation_are_bounded() {
        let directory = TempDir::new().unwrap();
        let database = Database::open_with_options(
            directory.path().into(),
            None,
            DatabaseOptions {
                reader_threads: 1,
                read_queue_capacity: 1,
                read_waiter_capacity: 1,
                read_enqueue_timeout: Duration::from_millis(100),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let (release, blocked) = std::sync::mpsc::channel();
        let (started, ready) = std::sync::mpsc::channel();
        let clone = database.clone();
        let blocker = tokio::spawn(async move {
            clone
                .read("test.block", move |_| {
                    started.send(()).unwrap();
                    blocked.recv_timeout(Duration::from_secs(2)).unwrap();
                    Ok(())
                })
                .await
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        let executed = Arc::new(AtomicBool::new(false));
        let flag = executed.clone();
        let clone = database.clone();
        let queued = tokio::spawn(async move {
            clone
                .read("test.cancelled", move |_| {
                    flag.store(true, Ordering::Release);
                    Ok(())
                })
                .await
        });
        while database.health().readers.queued != 1 {
            tokio::task::yield_now().await;
        }
        let clone = database.clone();
        let waiter = tokio::spawn(async move { clone.read("test.waiter", |_| Ok(())).await });
        while database.health().readers.waiting != 1 {
            tokio::task::yield_now().await;
        }
        let error = database
            .read("test.rejected", |_| Ok(()))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            Error::Backpressure(pressure)
                if pressure.resource == "database.read_queue"
                    && pressure.side_effect_committed == Some(false)
        ));
        queued.abort();
        waiter.abort();
        let _ = queued.await;
        let _ = waiter.await;
        release.send(()).unwrap();
        blocker.await.unwrap().unwrap();
        database.read("test.flush", |_| Ok(())).await.unwrap();
        assert!(!executed.load(Ordering::Acquire));
        let metrics = database.metrics();
        assert_eq!(metrics.readers.rejected_total, 1);
        assert_eq!(metrics.rejected_by_resource["database.read_queue"], 1);
        database.shutdown().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_drains_accepted_reads_and_closes_admission() {
        let directory = TempDir::new().unwrap();
        let database = Database::open_with_options(
            directory.path().into(),
            None,
            DatabaseOptions {
                reader_threads: 1,
                read_queue_capacity: 2,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let (release, blocked) = std::sync::mpsc::channel();
        let (started, ready) = std::sync::mpsc::channel();
        let clone = database.clone();
        let first = tokio::spawn(async move {
            clone
                .read("test.shutdown.block", move |_| {
                    started.send(()).unwrap();
                    blocked.recv_timeout(Duration::from_secs(2)).unwrap();
                    Ok(1)
                })
                .await
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        let clone = database.clone();
        let second =
            tokio::spawn(async move { clone.read("test.shutdown.queued", |_| Ok(2)).await });
        while database.health().readers.queued != 1 {
            tokio::task::yield_now().await;
        }
        let clone = database.clone();
        let shutdown = tokio::spawn(async move { clone.shutdown().await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!shutdown.is_finished());
        release.send(()).unwrap();
        assert_eq!(first.await.unwrap().unwrap(), 1);
        assert_eq!(second.await.unwrap().unwrap(), 2);
        shutdown.await.unwrap().unwrap();
        assert!(matches!(
            database.read("test.closed", |_| Ok(())).await,
            Err(Error::DatabaseUnavailable(_))
        ));
    }

    #[tokio::test]
    async fn readers_keep_owner_lock_after_writer_store_drops() {
        let directory = TempDir::new().unwrap();
        let writer = Store::open(directory.path()).unwrap();
        let pool = ReaderPool::open(
            directory.path().into(),
            writer.owner_lock(),
            ReaderOptions {
                threads: 2,
                queue_capacity: 2,
                waiter_capacity: 2,
                enqueue_timeout: Duration::from_millis(100),
                retry_after_ms: 100,
                latency_sample_capacity: 16,
            },
        )
        .await
        .unwrap();
        drop(writer);
        assert!(matches!(
            Store::open(directory.path()),
            Err(Error::AlreadyRunning)
        ));
        pool.shutdown().await.unwrap();
        let writer = Store::open(directory.path()).unwrap();
        drop(writer);
    }

    #[tokio::test]
    async fn dropping_database_stops_readers_and_releases_owner_lock() {
        let directory = TempDir::new().unwrap();
        let database = Database::open_with_options(directory.path().into(), None, options())
            .await
            .unwrap();
        drop(database);
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match Store::open(directory.path()) {
                    Ok(store) => {
                        drop(store);
                        break;
                    }
                    Err(Error::AlreadyRunning) => {
                        tokio::time::sleep(Duration::from_millis(10)).await
                    }
                    Err(error) => panic!("unexpected open error: {error}"),
                }
            }
        })
        .await
        .unwrap();
    }
}
