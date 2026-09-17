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
                if import_legacy && let Some(legacy_home) = legacy_home {
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
    copy_legacy_file(directory, legacy_home, "identity.json")?;
    copy_legacy_file(directory, legacy_home, "devices.json")?;
    copy_legacy_file(directory, legacy_home, "config.json")?;
    copy_legacy_model_sources(directory, legacy_home)?;
    let accounts = store.import_legacy_accounts(directory, legacy_home)?;
    let orchestration = store.import_legacy_orchestration(legacy_home)?;
    Ok(accounts + orchestration)
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
