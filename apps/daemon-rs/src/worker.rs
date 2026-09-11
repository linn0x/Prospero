use std::path::PathBuf;
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
    sender: mpsc::Sender<Job>,
    closed: AtomicBool,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct Database(Arc<Inner>);

impl Database {
    pub async fn open(directory: PathBuf) -> Result<Self> {
        let (sender, mut receiver) = mpsc::channel(DATABASE_QUEUE_CAPACITY);
        let (ready, initialized) = oneshot::channel();
        let thread = thread::Builder::new()
            .name("prospero-database".into())
            .spawn(move || {
                let mut store = match Store::open(&directory) {
                    Ok(store) => store,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
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
            sender,
            closed: AtomicBool::new(false),
            thread: Mutex::new(Some(thread)),
        })))
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
