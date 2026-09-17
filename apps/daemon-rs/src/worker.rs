use std::path::{Path, PathBuf};
use std::sync::Arc;
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

struct Inner {
    directory: PathBuf,
    sender: mpsc::Sender<Job>,
    closed: AtomicBool,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct Database(Arc<Inner>);

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
        let worker_directory = directory.clone();
        let legacy_marker = worker_directory.join("legacy-orchestration-import.json");
        let import_legacy = !legacy_marker.exists();
        let thread = thread::Builder::new()
            .name("prospero-database".into())
            .spawn(move || {
                let mut store = match Store::open(&worker_directory) {
                    Ok(store) => store,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                if let Some(legacy_home) = legacy_home {
                    if let Err(error) = import_legacy_files(&worker_directory, &legacy_home) {
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
                                    let _ = ready.send(Err(error));
                                    return;
                                }
                            }
                            Err(error) => {
                                let _ = ready.send(Err(error));
                                return;
                            }
                        }
                    }
                }
                if ready.send(Ok(())).is_err() {
                    return;
                }
                while let Some(job) = receiver.blocking_recv() {
                    match job {
                        Job::Execute(operation) => operation(&mut store),
                        Job::Stop => break,
                    }
                }
            })?;
        initialized.await.map_err(|_| Error::Closed)??;
        Ok(Self(Arc::new(Inner {
            directory,
            sender,
            closed: AtomicBool::new(false),
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
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let (sender, receiver) = oneshot::channel();
        let job = Job::Execute(Box::new(move |store| {
            if sender.is_closed() {
                return;
            }
            let result = operation(store);
            let _ = sender.send(result);
        }));
        self.0.sender.try_send(job).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => Error::Busy,
            mpsc::error::TrySendError::Closed(_) => Error::Closed,
        })?;
        receiver.await.map_err(|_| Error::Closed)?
    }

    pub async fn shutdown(&self) -> Result<()> {
        if self.0.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
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
