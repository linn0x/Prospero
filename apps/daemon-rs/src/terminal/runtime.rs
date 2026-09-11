use std::collections::HashMap;
use std::path::Path;

use tokio::sync::Semaphore;

use super::*;
use crate::protocol::{SessionHead, SessionStatus, UpdateSession};
use crate::worker::Database;

struct State {
    database: Database,
    entries: Mutex<HashMap<String, Terminal>>,
    slots: Arc<Semaphore>,
    closed: AtomicBool,
    failed: AtomicBool,
    changed: watch::Sender<u64>,
}

#[derive(Clone)]
pub struct Terminals(Arc<State>);

impl Terminals {
    pub fn new(database: Database) -> Self {
        Self(Arc::new(State {
            database,
            entries: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(16)),
            closed: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            changed: watch::channel(0).0,
        }))
    }

    pub fn count(&self) -> usize {
        16 - self.0.slots.available_permits()
    }

    pub(crate) fn changes(&self) -> watch::Sender<u64> {
        self.0.changed.clone()
    }

    pub fn check(&self) -> Result<()> {
        if self.0.failed.load(Ordering::Acquire) {
            Err(Error::Closed)
        } else {
            Ok(())
        }
    }

    pub async fn create(&self, input: CreateTerminal) -> Result<SessionHead> {
        input.size.validate()?;
        crate::database::validate_text(&input.title, 512, false)?;
        crate::database::validate_text(&input.workspace, 4096, false)?;
        if !Path::new(&input.workspace).is_absolute() {
            return Err(Error::Invalid("workspace must be absolute".into()));
        }
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let permit = self
            .0
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let runtime = self.clone();
        let (reply, result) = oneshot::channel();
        tokio::spawn(async move {
            let created = if reply.is_closed() {
                Err(Error::Closed)
            } else {
                runtime.start(input).await
            };
            match created {
                Ok((head, terminal)) => {
                    if reply.send(Ok(head.clone())).is_err()
                        || runtime.0.closed.load(Ordering::Acquire)
                    {
                        terminal.stop();
                    }
                    terminal.wait_exited().await;
                    let finalized = match terminal.archive() {
                        Ok(archive) => runtime.finish(&head.id, archive).await,
                        Err(error) => Err(error),
                    };
                    if finalized.is_err() {
                        runtime.0.failed.store(true, Ordering::Release);
                        runtime.0.closed.store(true, Ordering::Release);
                        eprintln!("terminal finalization failed");
                    }
                    if !runtime.0.failed.load(Ordering::Acquire)
                        && let Ok(mut entries) = runtime.0.entries.lock()
                    {
                        entries.remove(&head.id);
                    }
                }
                Err(error) => {
                    let _ = reply.send(Err(error));
                }
            }
            drop(permit);
            runtime
                .0
                .changed
                .send_modify(|seq| *seq = seq.wrapping_add(1));
        });
        result.await.map_err(|_| Error::Closed)?
    }

    async fn finish(&self, id: &str, archive: Archive) -> Result<()> {
        for attempt in 0..20 {
            let id = id.to_owned();
            let archive = archive.clone();
            match self
                .0
                .database
                .call(move |store| store.finish_terminal(&id, archive))
                .await
            {
                Ok(_) => return Ok(()),
                Err(Error::Busy) if attempt < 19 => {
                    tokio::time::sleep(Duration::from_millis(25)).await
                }
                Err(error) => return Err(error),
            }
        }
        Err(Error::Busy)
    }

    #[cfg(unix)]
    async fn start(&self, mut input: CreateTerminal) -> Result<(SessionHead, Terminal)> {
        let workspace = input.workspace.clone();
        let directory = tokio::task::spawn_blocking(move || std::fs::canonicalize(workspace))
            .await
            .map_err(|_| Error::Closed)??;
        if !directory.is_dir() {
            return Err(Error::Invalid("workspace is not a directory".into()));
        }
        input.workspace = directory
            .to_str()
            .ok_or_else(|| Error::Invalid("workspace must be Unicode".into()))?
            .into();
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let size = input.size;
        let head = self
            .0
            .database
            .call(move |store| store.create_terminal(input))
            .await?;
        let child = tokio::task::spawn_blocking(move || {
            let shell = std::env::var_os("SHELL")
                .filter(|shell| Path::new(shell).is_absolute())
                .unwrap_or_else(|| "/bin/sh".into());
            let mut command = portable_pty::CommandBuilder::new(shell);
            command.arg("-l");
            command.cwd(directory);
            command.env("TERM", "xterm-256color");
            command.env("COLORTERM", "truecolor");
            for key in ["TMUX", "TMUX_PANE", "STY"] {
                command.env_remove(key);
            }
            spawn(command, size)
        })
        .await
        .map_err(|_| Error::Closed)
        .and_then(|result| result);
        let terminal = match child {
            Ok(terminal) => terminal,
            Err(error) => {
                let id = head.id;
                self.0
                    .database
                    .call(move |store| {
                        store.finish_terminal(
                            &id,
                            Archive {
                                floor: 0,
                                seq: 0,
                                events: Vec::new(),
                                exit_code: None,
                            },
                        )
                    })
                    .await?;
                return Err(error);
            }
        };
        let id = head.id.clone();
        let running = self
            .0
            .database
            .call(move |store| {
                let head = store.session(&id)?;
                store.update_session(
                    &id,
                    UpdateSession {
                        revision: head.revision,
                        title: None,
                        lifecycle: None,
                        status: Some(SessionStatus::Running),
                    },
                )
            })
            .await;
        if let Err(error) = running {
            terminal.stop();
            terminal.wait_exited().await;
            let archive = terminal.archive()?;
            let id = head.id;
            self.0
                .database
                .call(move |store| store.finish_terminal(&id, archive))
                .await?;
            return Err(error);
        }
        self.0
            .entries
            .lock()
            .map_err(|_| Error::Closed)?
            .insert(head.id.clone(), terminal.clone());
        Ok((running?, terminal))
    }

    #[cfg(not(unix))]
    async fn start(&self, _input: CreateTerminal) -> Result<(SessionHead, Terminal)> {
        Err(Error::Invalid(
            "terminal runtime is not available on this platform".into(),
        ))
    }

    fn terminal(&self, id: &str) -> Result<Terminal> {
        crate::database::validate_id(id)?;
        self.0
            .entries
            .lock()
            .map_err(|_| Error::Closed)?
            .get(id)
            .cloned()
            .ok_or(Error::NotFound)
    }

    pub async fn read(&self, id: String, query: TerminalQuery) -> Result<TerminalPage> {
        match self.terminal(&id) {
            Ok(terminal) => terminal.read(query).await,
            Err(Error::NotFound) => {
                self.0
                    .database
                    .call(move |store| store.terminal_output(&id, query))
                    .await
            }
            Err(error) => Err(error),
        }
    }

    pub async fn input(&self, id: &str, input: TerminalInput) -> Result<()> {
        self.terminal(id)?.input(input).await
    }
    pub async fn resize(&self, id: &str, size: TerminalSize) -> Result<()> {
        self.terminal(id)?.resize(size).await
    }
    pub fn close(&self, id: &str) -> Result<()> {
        self.terminal(id)?.stop();
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.0.closed.store(true, Ordering::Release);
        for terminal in self.0.entries.lock().map_err(|_| Error::Closed)?.values() {
            terminal.stop();
        }
        let mut changed = self.0.changed.subscribe();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                changed.borrow_and_update();
                if self.count() == 0 {
                    return;
                }
                if changed.changed().await.is_err() {
                    return;
                }
            }
        })
        .await
        .map_err(|_| Error::Timeout)?;
        self.check()
    }
}
