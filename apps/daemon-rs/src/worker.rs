use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::RwLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use tokio::sync::{Mutex, mpsc, oneshot};

use crate::database::Store;
use crate::error::{Error, Result};
use crate::protocol::DATABASE_QUEUE_CAPACITY;

type Operation = Box<dyn FnOnce(&mut Store) + Send>;

enum Job {
    Execute(Operation),
    Stop,
}

struct WorkerState {
    alive: AtomicBool,
    queue_depth: std::sync::atomic::AtomicUsize,
    last_error: RwLock<Option<String>>,
    stopping: AtomicBool,
}

struct Inner {
    directory: PathBuf,
    sender: mpsc::Sender<Job>,
    closed: AtomicBool,
    state: Arc<WorkerState>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct Database(Arc<Inner>);

#[derive(Debug, Clone)]
pub struct DatabaseHealth {
    pub alive: bool,
    pub queue_depth: usize,
    pub last_error: Option<String>,
}

struct PendingJob {
    state: Arc<WorkerState>,
}

struct WorkerAliveGuard(Arc<WorkerState>);

impl Drop for PendingJob {
    fn drop(&mut self) {
        self.state.queue_depth.fetch_sub(1, Ordering::AcqRel);
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
        let (sender, mut receiver) = mpsc::channel(DATABASE_QUEUE_CAPACITY);
        let (ready, initialized) = oneshot::channel();
        let state = Arc::new(WorkerState {
            alive: AtomicBool::new(false),
            queue_depth: std::sync::atomic::AtomicUsize::new(0),
            last_error: RwLock::new(None),
            stopping: AtomicBool::new(false),
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
                if ready.send(Ok(())).is_err() {
                    worker_state.alive.store(false, Ordering::Release);
                    return;
                }
                let _alive = WorkerAliveGuard(worker_state.clone());
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    while let Some(job) = receiver.blocking_recv() {
                        match job {
                            Job::Execute(operation) => {
                                let result =
                                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                        operation(&mut store);
                                    }));
                                if let Err(payload) = result {
                                    let message = panic_message(payload);
                                    if let Ok(mut current) = worker_state.last_error.write() {
                                        *current = Some(message);
                                    }
                                }
                            }
                            Job::Stop => break,
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
        initialized.await.map_err(|_| Error::Closed)??;
        Ok(Self(Arc::new(Inner {
            directory,
            sender,
            closed: AtomicBool::new(false),
            state,
            thread: Mutex::new(Some(thread)),
        })))
    }

    /// Private daemon data directory (never the user's shared CLI home).
    pub fn directory(&self) -> &std::path::Path {
        &self.0.directory
    }

    pub async fn call<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store) -> Result<T> + Send + 'static,
    {
        if self.0.closed.load(Ordering::Acquire) || self.0.sender.is_closed() {
            return Err(self.unavailable());
        }
        let (sender, receiver) = oneshot::channel();
        let pending = PendingJob {
            state: self.0.state.clone(),
        };
        let operation_state = self.0.state.clone();
        let job = Job::Execute(Box::new(move |store| {
            let _pending = pending;
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
        }));
        self.0.state.queue_depth.fetch_add(1, Ordering::AcqRel);
        self.0.sender.try_send(job).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => Error::Busy,
            mpsc::error::TrySendError::Closed(_) => self.unavailable(),
        })?;
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
        DatabaseHealth {
            alive: self.0.state.alive.load(Ordering::Acquire)
                && !self.0.closed.load(Ordering::Acquire)
                && !self.0.sender.is_closed(),
            queue_depth: self.0.state.queue_depth.load(Ordering::Acquire),
            last_error: self
                .0
                .state
                .last_error
                .read()
                .ok()
                .and_then(|value| value.clone()),
        }
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
        let _ = self.0.sender.send(Job::Stop).await;
        if let Some(thread) = self.0.thread.lock().await.take() {
            tokio::task::spawn_blocking(move || thread.join())
                .await
                .map_err(|_| Error::Closed)?
                .map_err(|_| Error::Closed)?;
        }
        Ok(())
    }
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
