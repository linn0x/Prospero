use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, watch};
use ts_rs::TS;

use crate::error::{Error, Result};

pub const RETAINED_BYTES: usize = 1024 * 1024;
pub const RETAINED_EVENTS: usize = 512;
pub const INPUT_BYTES: usize = 8192;
const PAGE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl TerminalSize {
    pub fn validate(self) -> Result<Self> {
        if !(20..=500).contains(&self.cols) || !(5..=300).contains(&self.rows) {
            return Err(Error::Invalid("invalid terminal dimensions".into()));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTerminal {
    pub title: String,
    pub workspace: String,
    pub size: TerminalSize,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TerminalEvent {
    Output { data_b64: String },
    Resize { size: TerminalSize },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalQuery {
    #[ts(type = "number | null")]
    pub after_seq: Option<i64>,
    pub wait_ms: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPage {
    pub initial_size: TerminalSize,
    #[ts(type = "number")]
    pub base_seq: i64,
    #[ts(type = "number")]
    pub next_seq: i64,
    #[ts(type = "number")]
    pub latest_seq: i64,
    #[ts(type = "number")]
    pub floor_seq: i64,
    pub events: Vec<TerminalEvent>,
    pub resync_required: bool,
    pub exited: bool,
    pub exit_code: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalInput {
    pub data_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    #[ts(type = "number")]
    pub seq: i64,
    pub size: TerminalSize,
    pub data_b64: String,
}

pub mod screen;

pub struct Output {
    screen: screen::Screen,
    initial_size: TerminalSize,
    events: VecDeque<(TerminalEvent, usize)>,
    bytes: usize,
    seq: i64,
    exited: bool,
    exit_code: Option<u32>,
}

#[derive(Clone)]
pub(crate) struct Archive {
    snapshot: Option<TerminalSnapshot>,
    floor: i64,
    start: i64,
    seq: i64,
    events: Vec<TerminalEvent>,
    exit_code: Option<u32>,
}

impl Output {
    fn new(size: TerminalSize) -> Self {
        Self {
            screen: screen::Screen::new(size),
            initial_size: size,
            events: VecDeque::new(),
            bytes: 0,
            seq: 0,
            exited: false,
            exit_code: None,
        }
    }

    fn push(&mut self, event: TerminalEvent, bytes: usize) {
        if let TerminalEvent::Resize { size } = &event {
            self.screen.resize(*size);
        }
        self.events.push_back((event, bytes));
        self.bytes += bytes;
        self.seq += 1;
        while self.bytes > RETAINED_BYTES || self.events.len() > RETAINED_EVENTS {
            self.bytes -= self.events.pop_front().expect("retained event").1;
        }
    }

    fn write(&mut self, bytes: &[u8]) {
        self.screen.process(bytes);
        self.push(
            TerminalEvent::Output {
                data_b64: STANDARD.encode(bytes),
            },
            bytes.len(),
        );
    }

    fn page(&self, after: i64) -> Result<TerminalPage> {
        if after < 0 || after > self.seq {
            return Err(Error::Invalid("terminal cursor is ahead of output".into()));
        }
        let floor = self.seq - self.events.len() as i64;
        let mut events = Vec::new();
        let mut bytes = 0;
        if after >= floor {
            for (event, size) in self.events.iter().skip((after - floor) as usize).take(64) {
                if bytes + size > PAGE_BYTES {
                    break;
                }
                bytes += size;
                events.push(event.clone());
            }
        }
        Ok(TerminalPage {
            initial_size: self.initial_size,
            base_seq: after,
            next_seq: after + events.len() as i64,
            latest_seq: self.seq,
            floor_seq: floor,
            resync_required: after < floor,
            events,
            exited: self.exited,
            exit_code: self.exit_code,
        })
    }
}

enum Control {
    Input(Vec<u8>, oneshot::Sender<Result<()>>),
    Resize(TerminalSize, oneshot::Sender<Result<()>>),
}

struct Inner {
    sender: mpsc::Sender<Control>,
    output: Arc<Mutex<Output>>,
    changed: watch::Receiver<u64>,
    stop: Arc<AtomicBool>,
    #[cfg(unix)]
    wake: std::os::unix::net::UnixStream,
}

impl Inner {
    fn wake(&self) {
        #[cfg(unix)]
        {
            use std::io::Write;
            let _ = (&self.wake).write(&[1]);
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.wake();
    }
}

#[derive(Clone)]
pub struct Terminal(Arc<Inner>);

impl Terminal {
    pub(crate) async fn wait_output(&self, after: i64) {
        let mut changed = self.0.changed.clone();
        loop {
            changed.borrow_and_update();
            if self
                .0
                .output
                .lock()
                .is_ok_and(|output| output.seq != after || output.exited)
            {
                return;
            }
            if changed.changed().await.is_err() {
                return;
            }
        }
    }

    pub(crate) fn archive(&self) -> Result<Archive> {
        self.checkpoint(None)?.ok_or(Error::Conflict)
    }

    pub(crate) fn checkpoint(&self, after: Option<i64>) -> Result<Option<Archive>> {
        let output = self.0.output.lock().map_err(|_| Error::Closed)?;
        if after.is_none() && !output.exited {
            return Err(Error::Conflict);
        }
        if after == Some(output.seq) {
            return Ok(None);
        }
        let floor = output.seq - output.events.len() as i64;
        let start = after.unwrap_or(floor).max(floor).min(output.seq);
        Ok(Some(Archive {
            snapshot: output.screen.snapshot(output.seq).ok(),
            floor,
            start,
            seq: output.seq,
            events: output
                .events
                .iter()
                .skip((start - floor) as usize)
                .map(|(event, _)| event.clone())
                .collect(),
            exit_code: output.exit_code,
        }))
    }
    pub fn snapshot(&self) -> Result<Option<TerminalSnapshot>> {
        let output = self.0.output.lock().map_err(|_| Error::Closed)?;
        Ok(output.screen.snapshot(output.seq).ok())
    }
    pub async fn read(&self, query: TerminalQuery) -> Result<TerminalPage> {
        let after = query.after_seq.unwrap_or(0);
        let wait = query.wait_ms.unwrap_or(0);
        if wait > 5000 {
            return Err(Error::Invalid("terminal wait exceeds limit".into()));
        }
        let mut changed = self.0.changed.clone();
        changed.borrow_and_update();
        let page = self
            .0
            .output
            .lock()
            .map_err(|_| Error::Closed)?
            .page(after)?;
        if page.next_seq != after || page.resync_required || page.exited || wait == 0 {
            return Ok(page);
        }
        let _ = tokio::time::timeout(Duration::from_millis(wait.into()), changed.changed()).await;
        self.0.output.lock().map_err(|_| Error::Closed)?.page(after)
    }

    pub async fn input(&self, input: TerminalInput) -> Result<()> {
        if input.data_b64.len() > INPUT_BYTES.div_ceil(3) * 4 {
            return Err(Error::Invalid("terminal input exceeds limit".into()));
        }
        let bytes = STANDARD
            .decode(input.data_b64)
            .map_err(|_| Error::Invalid("invalid terminal input".into()))?;
        if bytes.is_empty() || bytes.len() > INPUT_BYTES {
            return Err(Error::Invalid("invalid terminal input length".into()));
        }
        self.control(|reply| Control::Input(bytes, reply)).await
    }

    pub async fn resize(&self, size: TerminalSize) -> Result<()> {
        let size = size.validate()?;
        self.control(|reply| Control::Resize(size, reply)).await
    }

    async fn control(
        &self,
        build: impl FnOnce(oneshot::Sender<Result<()>>) -> Control,
    ) -> Result<()> {
        if self.0.stop.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let (reply, receiver) = oneshot::channel();
        self.0.sender.try_send(build(reply)).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => Error::Busy,
            mpsc::error::TrySendError::Closed(_) => Error::Closed,
        })?;
        self.0.wake();
        receiver.await.map_err(|_| Error::Closed)?
    }

    pub fn stop(&self) {
        self.0.stop.store(true, Ordering::Release);
        self.0.wake();
    }

    pub async fn wait_exited(&self) {
        let mut changed = self.0.changed.clone();
        loop {
            changed.borrow_and_update();
            if self.0.output.lock().is_ok_and(|output| output.exited) {
                return;
            }
            if changed.changed().await.is_err() {
                return;
            }
        }
    }
}

#[cfg(unix)]
mod native;

#[cfg(unix)]
pub use native::spawn;

pub mod runtime;
mod store;
