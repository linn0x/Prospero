use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex as StdMutex, RwLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::{Mutex, mpsc, oneshot};
use ts_rs::TS;

use crate::database::Store;
use crate::error::{Error, ResourceBackpressure, Result};
use crate::protocol::DATABASE_QUEUE_CAPACITY;
use crate::reader::{ReaderOptions, ReaderPool};

pub use crate::reader::{ReadPoolHealth, ReadPoolMetrics, ReaderLatencyPercentiles};

type Operation = Box<dyn FnOnce(&mut Store) + Send>;

#[derive(Debug, Clone)]
pub struct DatabaseOptions {
    pub background_queue_capacity: usize,
    pub control_queue_capacity: usize,
    pub background_waiter_capacity: usize,
    pub control_waiter_capacity: usize,
    pub background_enqueue_timeout: Duration,
    pub control_enqueue_timeout: Duration,
    pub control_weight: usize,
    pub degraded_queue_depth: usize,
    pub recovered_queue_depth: usize,
    pub overload_duration: Duration,
    pub retry_after_ms: u64,
    pub latency_sample_capacity: usize,
    pub recent_error_capacity: usize,
    pub reader_threads: usize,
    pub read_queue_capacity: usize,
    pub read_waiter_capacity: usize,
    pub read_enqueue_timeout: Duration,
}

impl Default for DatabaseOptions {
    fn default() -> Self {
        Self {
            background_queue_capacity: DATABASE_QUEUE_CAPACITY,
            control_queue_capacity: 64,
            background_waiter_capacity: DATABASE_QUEUE_CAPACITY,
            control_waiter_capacity: 64,
            background_enqueue_timeout: Duration::from_millis(250),
            control_enqueue_timeout: Duration::from_millis(500),
            control_weight: 4,
            degraded_queue_depth: DATABASE_QUEUE_CAPACITY * 3 / 4,
            recovered_queue_depth: DATABASE_QUEUE_CAPACITY / 2,
            overload_duration: Duration::from_millis(250),
            retry_after_ms: 100,
            latency_sample_capacity: 1024,
            recent_error_capacity: 32,
            reader_threads: 2,
            read_queue_capacity: 128,
            read_waiter_capacity: 128,
            read_enqueue_timeout: Duration::from_millis(250),
        }
    }
}

impl DatabaseOptions {
    pub fn from_env() -> Self {
        let mut options = Self::default();
        set_usize(
            "PROSPERO_DB_BACKGROUND_QUEUE_CAPACITY",
            &mut options.background_queue_capacity,
        );
        set_usize(
            "PROSPERO_DB_CONTROL_QUEUE_CAPACITY",
            &mut options.control_queue_capacity,
        );
        set_usize(
            "PROSPERO_DB_BACKGROUND_WAITER_CAPACITY",
            &mut options.background_waiter_capacity,
        );
        set_usize(
            "PROSPERO_DB_CONTROL_WAITER_CAPACITY",
            &mut options.control_waiter_capacity,
        );
        set_duration(
            "PROSPERO_DB_BACKGROUND_ENQUEUE_TIMEOUT_MS",
            &mut options.background_enqueue_timeout,
        );
        set_duration(
            "PROSPERO_DB_CONTROL_ENQUEUE_TIMEOUT_MS",
            &mut options.control_enqueue_timeout,
        );
        set_usize("PROSPERO_DB_CONTROL_WEIGHT", &mut options.control_weight);
        set_usize(
            "PROSPERO_DB_DEGRADED_QUEUE_DEPTH",
            &mut options.degraded_queue_depth,
        );
        set_usize(
            "PROSPERO_DB_RECOVERED_QUEUE_DEPTH",
            &mut options.recovered_queue_depth,
        );
        set_duration(
            "PROSPERO_DB_OVERLOAD_DURATION_MS",
            &mut options.overload_duration,
        );
        set_u64("PROSPERO_DB_RETRY_AFTER_MS", &mut options.retry_after_ms);
        set_usize("PROSPERO_DB_READER_THREADS", &mut options.reader_threads);
        set_usize(
            "PROSPERO_DB_READ_QUEUE_CAPACITY",
            &mut options.read_queue_capacity,
        );
        set_usize(
            "PROSPERO_DB_READ_WAITER_CAPACITY",
            &mut options.read_waiter_capacity,
        );
        set_duration(
            "PROSPERO_DB_READ_ENQUEUE_TIMEOUT_MS",
            &mut options.read_enqueue_timeout,
        );
        options
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LatencyPercentiles {
    pub samples: usize,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecentResourceError {
    pub at_ms: u64,
    pub operation: String,
    pub resource: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseMetrics {
    pub readers: ReadPoolMetrics,
    pub waiting: usize,
    pub queued: usize,
    pub inflight: usize,
    pub high_watermark: usize,
    pub oldest_queued_age_ms: u64,
    pub queue_latency: LatencyPercentiles,
    pub execution_latency: LatencyPercentiles,
    pub database_rejected_total: u64,
    pub database_rejected_by_operation: BTreeMap<String, u64>,
    pub rejected_total: u64,
    pub rejected_by_operation: BTreeMap<String, u64>,
    pub rejected_by_resource: BTreeMap<String, u64>,
    pub recent_rejected_total: u64,
    pub recent_rejected_by_operation: BTreeMap<String, u64>,
    pub recent_rejected_by_resource: BTreeMap<String, u64>,
    pub recent_errors: Vec<RecentResourceError>,
}

struct RejectionBucket {
    second: u64,
    total: u64,
    by_operation: BTreeMap<String, u64>,
    by_resource: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lane {
    Control,
    Background,
}

struct Job {
    operation: Operation,
    queued: QueuedJob,
}

struct WorkerState {
    alive: AtomicBool,
    waiting: AtomicUsize,
    queued: AtomicUsize,
    inflight: AtomicUsize,
    control_waiting: AtomicUsize,
    control_queued: AtomicUsize,
    control_inflight: AtomicUsize,
    background_waiting: AtomicUsize,
    background_queued: AtomicUsize,
    background_inflight: AtomicUsize,
    high_watermark: AtomicUsize,
    degraded: AtomicBool,
    overload_since: StdMutex<Option<Instant>>,
    next_job_id: AtomicU64,
    oldest: StdMutex<BTreeMap<u64, Instant>>,
    queue_latencies: StdMutex<VecDeque<u64>>,
    execution_latencies: StdMutex<VecDeque<u64>>,
    database_rejected_total: AtomicU64,
    database_rejected_by_operation: StdMutex<BTreeMap<String, u64>>,
    rejected_total: AtomicU64,
    rejected_by_operation: StdMutex<BTreeMap<String, u64>>,
    rejected_by_resource: StdMutex<BTreeMap<String, u64>>,
    recent_rejections: StdMutex<VecDeque<RejectionBucket>>,
    recent_errors: StdMutex<VecDeque<RecentResourceError>>,
    last_error: RwLock<Option<String>>,
    stopping: AtomicBool,
    options: DatabaseOptions,
}

struct Inner {
    directory: PathBuf,
    control_sender: mpsc::Sender<Job>,
    background_sender: mpsc::Sender<Job>,
    worker: thread::Thread,
    closed: AtomicBool,
    state: Arc<WorkerState>,
    readers: ReaderPool,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct Database(Arc<Inner>);

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseHealth {
    pub alive: bool,
    pub degraded: bool,
    pub queue_depth: usize,
    pub waiting: usize,
    pub queued: usize,
    pub inflight: usize,
    pub high_watermark: usize,
    pub oldest_queued_age_ms: u64,
    pub control_queue_depth: usize,
    pub control_queue_capacity: usize,
    pub background_queue_depth: usize,
    pub background_queue_capacity: usize,
    pub readers: ReadPoolHealth,
    pub last_error: Option<String>,
}

struct WaitingJob {
    state: Arc<WorkerState>,
    lane: Lane,
    active: bool,
}

struct QueuedJob {
    state: Arc<WorkerState>,
    lane: Lane,
    id: u64,
    enqueued: Instant,
    active: bool,
}

struct InflightJob {
    state: Arc<WorkerState>,
    lane: Lane,
    started: Instant,
}

struct WorkerAliveGuard(Arc<WorkerState>);

impl Drop for WaitingJob {
    fn drop(&mut self) {
        if self.active {
            self.state.finish_waiting(self.lane);
        }
    }
}

impl WaitingJob {
    fn enqueue(mut self) -> QueuedJob {
        self.active = false;
        self.state.queued.fetch_add(1, Ordering::AcqRel);
        self.state.waiting.fetch_sub(1, Ordering::AcqRel);
        match self.lane {
            Lane::Control => {
                self.state.control_queued.fetch_add(1, Ordering::AcqRel);
                self.state.control_waiting.fetch_sub(1, Ordering::AcqRel);
            }
            Lane::Background => {
                self.state.background_queued.fetch_add(1, Ordering::AcqRel);
                self.state.background_waiting.fetch_sub(1, Ordering::AcqRel);
            }
        }
        let id = self.state.next_job_id.fetch_add(1, Ordering::AcqRel);
        let enqueued = Instant::now();
        self.state.oldest.lock().unwrap().insert(id, enqueued);
        self.state.observe_depth();
        QueuedJob {
            state: self.state.clone(),
            lane: self.lane,
            id,
            enqueued,
            active: true,
        }
    }
}

impl Drop for QueuedJob {
    fn drop(&mut self) {
        if self.active {
            self.state.finish_queued(self.lane, self.id);
        }
    }
}

impl Drop for InflightJob {
    fn drop(&mut self) {
        self.state.finish(self.lane, self.started);
    }
}

impl Drop for WorkerAliveGuard {
    fn drop(&mut self) {
        self.0.alive.store(false, Ordering::Release);
    }
}

impl WorkerAliveGuard {
    fn finish(&self, reason: &str) {
        if let Ok(mut current) = self.0.last_error.write() {
            *current = Some(reason.into());
        }
    }
}

impl WorkerState {
    fn depth(&self) -> usize {
        self.waiting.load(Ordering::Acquire)
            + self.queued.load(Ordering::Acquire)
            + self.inflight.load(Ordering::Acquire)
    }

    fn lane_depth(&self, lane: Lane) -> usize {
        let (waiting, queued, inflight) = match lane {
            Lane::Control => (
                &self.control_waiting,
                &self.control_queued,
                &self.control_inflight,
            ),
            Lane::Background => (
                &self.background_waiting,
                &self.background_queued,
                &self.background_inflight,
            ),
        };
        waiting.load(Ordering::Acquire)
            + queued.load(Ordering::Acquire)
            + inflight.load(Ordering::Acquire)
    }

    fn lane_queued(&self, lane: Lane) -> usize {
        match lane {
            Lane::Control => self.control_queued.load(Ordering::Acquire),
            Lane::Background => self.background_queued.load(Ordering::Acquire),
        }
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
        let mut overload_since = self.overload_since.lock().unwrap();
        if self.degraded.load(Ordering::Acquire) {
            if depth <= self.options.recovered_queue_depth {
                self.degraded.store(false, Ordering::Release);
                *overload_since = None;
            }
        } else if depth >= self.options.degraded_queue_depth {
            let started = overload_since.get_or_insert_with(Instant::now);
            if started.elapsed() >= self.options.overload_duration {
                self.degraded.store(true, Ordering::Release);
            }
        } else {
            *overload_since = None;
        }
    }

    fn begin_waiting(self: &Arc<Self>, lane: Lane, operation: &str) -> Result<WaitingJob> {
        let (counter, capacity) = match lane {
            Lane::Control => (&self.control_waiting, self.options.control_waiter_capacity),
            Lane::Background => (
                &self.background_waiting,
                self.options.background_waiter_capacity,
            ),
        };
        let mut current = counter.load(Ordering::Acquire);
        loop {
            if current >= capacity {
                return Err(self.reject(operation, lane, false));
            }
            match counter.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(value) => current = value,
            }
        }
        self.waiting.fetch_add(1, Ordering::AcqRel);
        self.observe_depth();
        Ok(WaitingJob {
            state: self.clone(),
            lane,
            active: true,
        })
    }

    fn finish_waiting(&self, lane: Lane) {
        self.waiting.fetch_sub(1, Ordering::AcqRel);
        match lane {
            Lane::Control => self.control_waiting.fetch_sub(1, Ordering::AcqRel),
            Lane::Background => self.background_waiting.fetch_sub(1, Ordering::AcqRel),
        };
        self.observe_depth();
    }

    fn finish_queued(&self, lane: Lane, id: u64) {
        self.queued.fetch_sub(1, Ordering::AcqRel);
        match lane {
            Lane::Control => self.control_queued.fetch_sub(1, Ordering::AcqRel),
            Lane::Background => self.background_queued.fetch_sub(1, Ordering::AcqRel),
        };
        self.oldest.lock().unwrap().remove(&id);
        self.observe_depth();
    }

    fn start(self: &Arc<Self>, queued: &mut QueuedJob) -> InflightJob {
        queued.active = false;
        self.inflight.fetch_add(1, Ordering::AcqRel);
        self.queued.fetch_sub(1, Ordering::AcqRel);
        match queued.lane {
            Lane::Control => {
                self.control_inflight.fetch_add(1, Ordering::AcqRel);
                self.control_queued.fetch_sub(1, Ordering::AcqRel);
            }
            Lane::Background => {
                self.background_inflight.fetch_add(1, Ordering::AcqRel);
                self.background_queued.fetch_sub(1, Ordering::AcqRel);
            }
        };
        self.oldest.lock().unwrap().remove(&queued.id);
        self.push_latency(&self.queue_latencies, queued.enqueued.elapsed());
        self.observe_depth();
        InflightJob {
            state: self.clone(),
            lane: queued.lane,
            started: Instant::now(),
        }
    }

    fn finish(&self, lane: Lane, started: Instant) {
        self.push_latency(&self.execution_latencies, started.elapsed());
        self.inflight.fetch_sub(1, Ordering::AcqRel);
        match lane {
            Lane::Control => self.control_inflight.fetch_sub(1, Ordering::AcqRel),
            Lane::Background => self.background_inflight.fetch_sub(1, Ordering::AcqRel),
        };
        self.observe_depth();
    }

    fn push_latency(&self, samples: &StdMutex<VecDeque<u64>>, duration: Duration) {
        let mut samples = samples.lock().unwrap();
        if samples.len() == self.options.latency_sample_capacity {
            samples.pop_front();
        }
        samples.push_back(duration.as_millis().min(u128::from(u64::MAX)) as u64);
    }

    fn reject(&self, operation: &str, lane: Lane, timed_out: bool) -> Error {
        let resource = match lane {
            Lane::Control => "database.control_queue",
            Lane::Background => "database.background_queue",
        };
        let capacity = match lane {
            Lane::Control => self.options.control_queue_capacity,
            Lane::Background => self.options.background_queue_capacity,
        };
        let pressure = ResourceBackpressure {
            retry_after_ms: self.options.retry_after_ms,
            operation: operation.into(),
            resource: resource.into(),
            queue_depth: self.lane_queued(lane),
            queue_capacity: capacity,
            side_effect_committed: Some(false),
        };
        self.record_database_rejection(operation);
        self.record_rejection(operation, resource);
        self.record_recent_error(
            operation,
            resource,
            if timed_out {
                "queue admission timed out"
            } else {
                "queue admission capacity exhausted"
            },
        );
        Error::Backpressure(pressure)
    }

    fn record_database_rejection(&self, operation: &str) {
        self.database_rejected_total.fetch_add(1, Ordering::AcqRel);
        let mut rejected = self.database_rejected_by_operation.lock().unwrap();
        *rejected.entry(operation.into()).or_default() += 1;
    }

    fn record_rejection(&self, operation: &str, resource: &str) {
        self.rejected_total.fetch_add(1, Ordering::AcqRel);
        let mut rejected = self.rejected_by_operation.lock().unwrap();
        *rejected.entry(operation.into()).or_default() += 1;
        drop(rejected);
        let mut rejected = self.rejected_by_resource.lock().unwrap();
        *rejected.entry(resource.into()).or_default() += 1;
        drop(rejected);
        let second = unix_time_ms() / 1000;
        let mut recent = self.recent_rejections.lock().unwrap();
        prune_rejections(&mut recent, second);
        if recent.back().is_none_or(|bucket| bucket.second != second) {
            recent.push_back(RejectionBucket {
                second,
                total: 0,
                by_operation: BTreeMap::new(),
                by_resource: BTreeMap::new(),
            });
        }
        {
            let bucket = recent.back_mut().unwrap();
            bucket.total += 1;
            *bucket.by_operation.entry(operation.into()).or_default() += 1;
            *bucket.by_resource.entry(resource.into()).or_default() += 1;
        }
        while recent.len() > 60 {
            recent.pop_front();
        }
        drop(recent);
        self.observe_depth();
    }

    fn record_recent_error(&self, operation: &str, resource: &str, message: &str) {
        let mut errors = self.recent_errors.lock().unwrap();
        if errors.len() == self.options.recent_error_capacity {
            errors.pop_front();
        }
        errors.push_back(RecentResourceError {
            at_ms: unix_time_ms(),
            operation: operation.into(),
            resource: resource.into(),
            message: message.into(),
        });
    }

    fn oldest_queued_age_ms(&self) -> u64 {
        self.oldest
            .lock()
            .unwrap()
            .values()
            .min()
            .map(|started| started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0)
    }
}

impl Job {
    fn execute(self, store: &mut Store) {
        let Job {
            operation,
            mut queued,
        } = self;
        let state = queued.state.clone();
        let _inflight = state.start(&mut queued);
        operation(store);
    }
}

impl Database {
    pub async fn open(directory: PathBuf) -> Result<Self> {
        Self::open_with_legacy_home(
            directory,
            std::env::var_os("PROSPERO_LEGACY_HOME").map(PathBuf::from),
        )
        .await
    }

    pub async fn open_with_legacy_home(
        directory: PathBuf,
        legacy_home: Option<PathBuf>,
    ) -> Result<Self> {
        Self::open_with_options(directory, legacy_home, DatabaseOptions::from_env()).await
    }

    pub async fn open_with_options(
        directory: PathBuf,
        legacy_home: Option<PathBuf>,
        mut options: DatabaseOptions,
    ) -> Result<Self> {
        options.background_queue_capacity = options.background_queue_capacity.max(1);
        options.control_queue_capacity = options.control_queue_capacity.max(1);
        options.background_waiter_capacity = options.background_waiter_capacity.max(1);
        options.control_waiter_capacity = options.control_waiter_capacity.max(1);
        options.control_weight = options.control_weight.max(1);
        options.degraded_queue_depth = options.degraded_queue_depth.max(1);
        options.recovered_queue_depth = options
            .recovered_queue_depth
            .min(options.degraded_queue_depth.saturating_sub(1));
        options.latency_sample_capacity = options.latency_sample_capacity.max(1);
        options.recent_error_capacity = options.recent_error_capacity.max(1);
        options.reader_threads = options.reader_threads.clamp(1, 16);
        options.read_queue_capacity = options.read_queue_capacity.clamp(1, 4096);
        options.read_waiter_capacity = options.read_waiter_capacity.clamp(1, 4096);
        options.read_enqueue_timeout = options.read_enqueue_timeout.min(Duration::from_secs(30));
        let reader_options = ReaderOptions {
            threads: options.reader_threads,
            queue_capacity: options.read_queue_capacity,
            waiter_capacity: options.read_waiter_capacity,
            enqueue_timeout: options.read_enqueue_timeout,
            retry_after_ms: options.retry_after_ms,
            latency_sample_capacity: options.latency_sample_capacity,
        };
        let (control_sender, mut control_receiver) =
            mpsc::channel::<Job>(options.control_queue_capacity);
        let (background_sender, mut background_receiver) =
            mpsc::channel::<Job>(options.background_queue_capacity);
        let (ready, initialized) = oneshot::channel();
        let state = Arc::new(WorkerState {
            alive: AtomicBool::new(false),
            waiting: AtomicUsize::new(0),
            queued: AtomicUsize::new(0),
            inflight: AtomicUsize::new(0),
            control_waiting: AtomicUsize::new(0),
            control_queued: AtomicUsize::new(0),
            control_inflight: AtomicUsize::new(0),
            background_waiting: AtomicUsize::new(0),
            background_queued: AtomicUsize::new(0),
            background_inflight: AtomicUsize::new(0),
            high_watermark: AtomicUsize::new(0),
            degraded: AtomicBool::new(false),
            overload_since: StdMutex::new(None),
            next_job_id: AtomicU64::new(1),
            oldest: StdMutex::new(BTreeMap::new()),
            queue_latencies: StdMutex::new(VecDeque::new()),
            execution_latencies: StdMutex::new(VecDeque::new()),
            database_rejected_total: AtomicU64::new(0),
            database_rejected_by_operation: StdMutex::new(BTreeMap::new()),
            rejected_total: AtomicU64::new(0),
            rejected_by_operation: StdMutex::new(BTreeMap::new()),
            rejected_by_resource: StdMutex::new(BTreeMap::new()),
            recent_rejections: StdMutex::new(VecDeque::new()),
            recent_errors: StdMutex::new(VecDeque::new()),
            last_error: RwLock::new(None),
            stopping: AtomicBool::new(false),
            options,
        });
        let worker_state = state.clone();
        let worker_directory = directory.clone();
        let legacy_marker = worker_directory.join("legacy-orchestration-import.json");
        let import_legacy = !legacy_marker.exists();
        let thread = thread::Builder::new()
            .name("prospero-database".into())
            .spawn(move || {
                let mut store = match Store::open(&worker_directory) {
                    Ok(store) => store,
                    Err(error) => {
                        if let Ok(mut current) = worker_state.last_error.write() {
                            *current = Some(error.to_string());
                        }
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                if let Some(legacy_home) = legacy_home {
                    if let Err(error) = import_legacy_files(&worker_directory, &legacy_home) {
                        if let Ok(mut current) = worker_state.last_error.write() {
                            *current = Some(error.to_string());
                        }
                        let _ = ready.send(Err(error));
                        return;
                    }
                    if import_legacy {
                        match import_legacy_state(&mut store, &worker_directory, &legacy_home) {
                            Ok(imported) => {
                                if let Err(error) = crate::pairing::write_private_json(
                                    &worker_directory,
                                    "legacy-orchestration-import.json",
                                    &serde_json::json!({
                                        "source": legacy_home.to_string_lossy(),
                                        "imported": imported,
                                        "createdAt": crate::database::now(),
                                    }),
                                ) {
                                    if let Ok(mut current) = worker_state.last_error.write() {
                                        *current = Some(error.to_string());
                                    }
                                    let _ = ready.send(Err(error));
                                    return;
                                }
                            }
                            Err(error) => {
                                if let Ok(mut current) = worker_state.last_error.write() {
                                    *current = Some(error.to_string());
                                }
                                let _ = ready.send(Err(error));
                                return;
                            }
                        }
                    }
                }
                worker_state.alive.store(true, Ordering::Release);
                if ready.send(Ok(store.owner_lock())).is_err() {
                    worker_state.alive.store(false, Ordering::Release);
                    return;
                }
                let _alive = WorkerAliveGuard(worker_state.clone());
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut control_streak = 0;
                    while !worker_state.stopping.load(Ordering::Acquire) {
                        let weight = worker_state.options.control_weight.max(1);
                        let job = if control_streak >= weight {
                            background_receiver
                                .try_recv()
                                .ok()
                                .inspect(|_| control_streak = 0)
                                .or_else(|| control_receiver.try_recv().ok())
                        } else {
                            control_receiver
                                .try_recv()
                                .ok()
                                .inspect(|_| control_streak += 1)
                                .or_else(|| {
                                    background_receiver
                                        .try_recv()
                                        .ok()
                                        .inspect(|_| control_streak = 0)
                                })
                        };
                        if let Some(job) = job {
                            let result =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    job.execute(&mut store)
                                }));
                            if let Err(payload) = result {
                                let message = panic_message(payload);
                                if let Ok(mut current) = worker_state.last_error.write() {
                                    *current = Some(message);
                                }
                            }
                        } else if control_receiver.is_closed() && background_receiver.is_closed() {
                            break;
                        } else {
                            thread::park_timeout(Duration::from_millis(2));
                        }
                    }
                }));
                match result {
                    Err(payload) => {
                        if let Ok(mut current) = worker_state.last_error.write() {
                            *current = Some(panic_message(payload));
                        }
                    }
                    Ok(()) if !worker_state.stopping.load(Ordering::Acquire) => {
                        _alive.finish("database actor stopped")
                    }
                    Ok(()) => {}
                }
            })?;
        let worker = thread.thread().clone();
        let owner_lock = initialized.await.map_err(|_| Error::Closed)??;
        let readers = match ReaderPool::open(directory.clone(), owner_lock, reader_options).await {
            Ok(readers) => readers,
            Err(error) => {
                state.stopping.store(true, Ordering::Release);
                worker.unpark();
                tokio::task::spawn_blocking(move || thread.join())
                    .await
                    .map_err(|_| Error::Closed)?
                    .map_err(|_| Error::Closed)?;
                return Err(error);
            }
        };
        Ok(Self(Arc::new(Inner {
            directory,
            control_sender,
            background_sender,
            worker,
            closed: AtomicBool::new(false),
            state,
            readers,
            thread: Mutex::new(Some(thread)),
        })))
    }

    pub fn directory(&self) -> &std::path::Path {
        &self.0.directory
    }

    pub async fn call<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store) -> Result<T> + Send + 'static,
    {
        self.call_background("database.call", operation).await
    }

    pub async fn read<T, F>(&self, name: impl Into<String>, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store) -> Result<T> + Send + 'static,
    {
        if self.0.closed.load(Ordering::Acquire) {
            return Err(self.unavailable());
        }
        let name = name.into();
        let result = self.0.readers.read(name.clone(), operation).await;
        if matches!(
            &result,
            Err(Error::Backpressure(pressure)) if pressure.resource == "database.read_queue"
        ) {
            self.0.state.record_rejection(&name, "database.read_queue");
            self.0.state.record_recent_error(
                &name,
                "database.read_queue",
                "database read queue admission failed",
            );
        }
        result
    }

    pub async fn call_control<T, F>(&self, name: impl Into<String>, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store) -> Result<T> + Send + 'static,
    {
        self.call_lane(Lane::Control, name.into(), operation).await
    }

    pub async fn call_background<T, F>(&self, name: impl Into<String>, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store) -> Result<T> + Send + 'static,
    {
        self.call_lane(Lane::Background, name.into(), operation)
            .await
    }

    async fn call_lane<T, F>(&self, lane: Lane, name: String, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store) -> Result<T> + Send + 'static,
    {
        let sender = match lane {
            Lane::Control => &self.0.control_sender,
            Lane::Background => &self.0.background_sender,
        };
        if self.0.closed.load(Ordering::Acquire) || sender.is_closed() {
            return Err(self.unavailable());
        }
        let waiting = self.0.state.begin_waiting(lane, &name)?;
        let timeout = match lane {
            Lane::Control => self.0.state.options.control_enqueue_timeout,
            Lane::Background => self.0.state.options.background_enqueue_timeout,
        };
        let permit = match tokio::time::timeout(timeout, sender.reserve()).await {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => return Err(self.unavailable()),
            Err(_) => return Err(self.0.state.reject(&name, lane, true)),
        };
        let queued = waiting.enqueue();
        let (sender, receiver) = oneshot::channel();
        let operation_state = self.0.state.clone();
        let job = Job {
            operation: Box::new(move |store| {
                if sender.is_closed() {
                    return;
                }
                let result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| operation(store)))
                        .unwrap_or_else(|payload| {
                            let message = panic_message(payload);
                            if let Ok(mut current) = operation_state.last_error.write() {
                                *current = Some(message.clone());
                            }
                            Err(Error::DatabaseOperationFailed(message))
                        });
                let _ = sender.send(result);
            }),
            queued,
        };
        permit.send(job);
        self.0.worker.unpark();
        receiver.await.map_err(|_| {
            if let Ok(mut current) = self.0.state.last_error.write() {
                if let Some(message) = current.clone() {
                    return Error::DatabaseOperationFailed(message);
                }
                *current = Some("database operation did not return a result".into());
            }
            Error::DatabaseOperationFailed("database operation did not return a result".into())
        })?
    }

    pub fn health(&self) -> DatabaseHealth {
        self.0.state.observe_depth();
        let alive = self.0.state.alive.load(Ordering::Acquire)
            && !self.0.closed.load(Ordering::Acquire)
            && !self.0.control_sender.is_closed()
            && !self.0.background_sender.is_closed();
        DatabaseHealth {
            alive,
            degraded: !alive || self.0.state.degraded.load(Ordering::Acquire),
            queue_depth: self.0.state.depth(),
            waiting: self.0.state.waiting.load(Ordering::Acquire),
            queued: self.0.state.queued.load(Ordering::Acquire),
            inflight: self.0.state.inflight.load(Ordering::Acquire),
            high_watermark: self.0.state.high_watermark.load(Ordering::Acquire),
            oldest_queued_age_ms: self.0.state.oldest_queued_age_ms(),
            control_queue_depth: self.0.state.lane_depth(Lane::Control),
            control_queue_capacity: self.0.state.options.control_queue_capacity,
            background_queue_depth: self.0.state.lane_depth(Lane::Background),
            background_queue_capacity: self.0.state.options.background_queue_capacity,
            readers: self.0.readers.health(),
            last_error: self
                .0
                .state
                .last_error
                .read()
                .ok()
                .and_then(|value| value.clone()),
        }
    }

    pub fn metrics(&self) -> DatabaseMetrics {
        let (recent_rejected_total, recent_rejected_by_operation, recent_rejected_by_resource) =
            recent_rejection_metrics(&self.0.state.recent_rejections);
        DatabaseMetrics {
            readers: self.0.readers.metrics(),
            waiting: self.0.state.waiting.load(Ordering::Acquire),
            queued: self.0.state.queued.load(Ordering::Acquire),
            inflight: self.0.state.inflight.load(Ordering::Acquire),
            high_watermark: self.0.state.high_watermark.load(Ordering::Acquire),
            oldest_queued_age_ms: self.0.state.oldest_queued_age_ms(),
            queue_latency: latency_percentiles(&self.0.state.queue_latencies),
            execution_latency: latency_percentiles(&self.0.state.execution_latencies),
            database_rejected_total: self.0.state.database_rejected_total.load(Ordering::Acquire),
            database_rejected_by_operation: self
                .0
                .state
                .database_rejected_by_operation
                .lock()
                .unwrap()
                .clone(),
            rejected_total: self.0.state.rejected_total.load(Ordering::Acquire),
            rejected_by_operation: self.0.state.rejected_by_operation.lock().unwrap().clone(),
            rejected_by_resource: self.0.state.rejected_by_resource.lock().unwrap().clone(),
            recent_rejected_total,
            recent_rejected_by_operation,
            recent_rejected_by_resource,
            recent_errors: self
                .0
                .state
                .recent_errors
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .collect(),
        }
    }

    pub fn record_rejection(&self, operation: &str, resource: &str) {
        self.0.state.record_rejection(operation, resource);
    }

    pub fn record_recent_error(&self, operation: &str, resource: &str, message: &str) {
        self.0
            .state
            .record_recent_error(operation, resource, message);
    }

    pub fn recent_rejections(&self, operation_prefix: &str) -> u64 {
        let (_, operations, _) = recent_rejection_metrics(&self.0.state.recent_rejections);
        operations
            .into_iter()
            .filter(|(operation, _)| operation.starts_with(operation_prefix))
            .map(|(_, count)| count)
            .sum()
    }

    fn unavailable(&self) -> Error {
        Error::DatabaseUnavailable(
            self.health()
                .last_error
                .unwrap_or_else(|| "database actor channel is closed".into()),
        )
    }

    pub async fn shutdown(&self) -> Result<()> {
        if self.0.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.0.state.stopping.store(true, Ordering::Release);
        self.0.worker.unpark();
        if let Some(thread) = self.0.thread.lock().await.take() {
            tokio::task::spawn_blocking(move || thread.join())
                .await
                .map_err(|_| Error::Closed)?
                .map_err(|_| Error::Closed)?;
        }
        self.0.readers.shutdown().await?;
        Ok(())
    }
}

fn latency_percentiles(samples: &StdMutex<VecDeque<u64>>) -> LatencyPercentiles {
    let mut values: Vec<_> = samples.lock().unwrap().iter().copied().collect();
    values.sort_unstable();
    LatencyPercentiles {
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

fn set_usize(name: &str, target: &mut usize) {
    if let Some(value) = std::env::var_os(name)
        .and_then(|value| value.into_string().ok())
        .and_then(|value| value.parse().ok())
    {
        *target = value;
    }
}

fn set_u64(name: &str, target: &mut u64) {
    if let Some(value) = std::env::var_os(name)
        .and_then(|value| value.into_string().ok())
        .and_then(|value| value.parse().ok())
    {
        *target = value;
    }
}

fn set_duration(name: &str, target: &mut Duration) {
    let mut milliseconds = target.as_millis().min(u128::from(u64::MAX)) as u64;
    set_u64(name, &mut milliseconds);
    *target = Duration::from_millis(milliseconds);
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn prune_rejections(rejections: &mut VecDeque<RejectionBucket>, now: u64) {
    while rejections
        .front()
        .is_some_and(|bucket| bucket.second.saturating_add(60) <= now)
    {
        rejections.pop_front();
    }
    while rejections.len() > 60 {
        rejections.pop_front();
    }
}

fn recent_rejection_metrics(
    rejections: &StdMutex<VecDeque<RejectionBucket>>,
) -> (u64, BTreeMap<String, u64>, BTreeMap<String, u64>) {
    let now = unix_time_ms() / 1000;
    let mut rejections = rejections.lock().unwrap();
    prune_rejections(&mut rejections, now);
    let mut total = 0;
    let mut by_operation = BTreeMap::new();
    let mut by_resource = BTreeMap::new();
    for bucket in rejections.iter() {
        total += bucket.total;
        for (operation, count) in &bucket.by_operation {
            *by_operation.entry(operation.clone()).or_default() += count;
        }
        for (resource, count) in &bucket.by_resource {
            *by_resource.entry(resource.clone()).or_default() += count;
        }
    }
    (total, by_operation, by_resource)
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|value| (*value).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "database operation panicked".into())
}

fn import_legacy_state(store: &mut Store, directory: &Path, legacy_home: &Path) -> Result<usize> {
    import_legacy_files(directory, legacy_home)?;
    let accounts = store.import_legacy_accounts(directory, legacy_home)?;
    let orchestration = store.import_legacy_orchestration(legacy_home)?;
    Ok(accounts + orchestration)
}

fn import_legacy_files(directory: &Path, legacy_home: &Path) -> Result<()> {
    copy_legacy_file(directory, legacy_home, "identity.json")?;
    copy_legacy_file(directory, legacy_home, "devices.json")?;
    copy_legacy_config(directory, legacy_home)?;
    merge_legacy_relay_sync_state(directory, legacy_home)?;
    copy_legacy_model_sources(directory, legacy_home)?;
    Ok(())
}

fn copy_legacy_file(directory: &Path, legacy_home: &Path, name: &str) -> Result<()> {
    let source = legacy_home.join(name);
    let target = directory.join(name);
    if !source.exists() || target.exists() {
        return Ok(());
    }
    let bytes = std::fs::read(source)?;
    crate::pairing::write_private_json(
        directory,
        name,
        &serde_json::from_slice::<serde_json::Value>(&bytes)?,
    )?;
    Ok(())
}

fn copy_legacy_config(directory: &Path, legacy_home: &Path) -> Result<()> {
    let source = legacy_home.join("config.json");
    let target = directory.join("config.json");
    if !source.exists() {
        return Ok(());
    }
    let source_value = serde_json::from_slice::<serde_json::Value>(&std::fs::read(source)?)?;
    if !target.exists() {
        crate::pairing::write_private_json(directory, "config.json", &source_value)?;
        return Ok(());
    }
    let mut target_value = serde_json::from_slice::<serde_json::Value>(&std::fs::read(&target)?)?;
    let Some(source_relay) = source_value.get("relay").cloned() else {
        return Ok(());
    };
    if target_value.get("relay").is_some() {
        return Ok(());
    }
    let Some(object) = target_value.as_object_mut() else {
        return Ok(());
    };
    object.insert("relay".into(), source_relay);
    crate::pairing::write_private_json(directory, "config.json", &target_value)
}

fn merge_legacy_relay_sync_state(directory: &Path, legacy_home: &Path) -> Result<()> {
    let source = legacy_home.join(crate::relay::RELAY_SYNC_STATE_FILE);
    if !source.exists() {
        return Ok(());
    }
    let source_value = serde_json::from_slice::<serde_json::Value>(&std::fs::read(source)?)?;
    let Some(source_routes) = source_value
        .get("routes")
        .and_then(serde_json::Value::as_object)
    else {
        return Ok(());
    };
    let target_path = directory.join(crate::relay::RELAY_SYNC_STATE_FILE);
    let mut target_value = if target_path.exists() {
        serde_json::from_slice::<serde_json::Value>(&std::fs::read(&target_path)?)?
    } else {
        serde_json::json!({ "version": 1, "routes": {} })
    };
    if !target_value.is_object() {
        return Ok(());
    }
    target_value["version"] = serde_json::json!(1);
    if !target_value
        .get("routes")
        .is_some_and(serde_json::Value::is_object)
    {
        target_value["routes"] = serde_json::json!({});
    }
    let Some(target_routes) = target_value
        .get_mut("routes")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return Ok(());
    };
    for (route_id, source_generation) in source_routes {
        let Some(source_generation) = source_generation.as_u64() else {
            continue;
        };
        let target_generation = target_routes
            .get(route_id)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        if source_generation > target_generation {
            target_routes.insert(route_id.clone(), serde_json::json!(source_generation));
        }
    }
    crate::pairing::write_private_json(
        directory,
        crate::relay::RELAY_SYNC_STATE_FILE,
        &target_value,
    )
}

fn copy_legacy_model_sources(directory: &Path, legacy_home: &Path) -> Result<()> {
    let source = legacy_home.join("model-sources").join(".registry.json");
    let target_root = directory.join("model-sources");
    let target = target_root.join(".registry.json");
    if !source.exists() || target.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(&target_root)?;
    let value = serde_json::from_slice::<serde_json::Value>(&std::fs::read(source)?)?;
    crate::pairing::write_private_json(&target_root, ".registry.json", &value)
}
