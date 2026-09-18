use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use tokio::sync::{mpsc, oneshot, watch};

use crate::error::{Error, Result};

pub const RETAINED_BYTES: usize = 1024 * 1024;
pub const RETAINED_EVENTS: usize = 512;
pub const INPUT_BYTES: usize = 8192;
const PAGE_BYTES: usize = 64 * 1024;
const ACTIVITY_IDLE_MS: i64 = 30_000;
const ACTIVITY_TAIL_LINES: usize = 10;

pub use prospero_protocol_rs::{
    CreateTerminal, TerminalEvent, TerminalInput, TerminalPage, TerminalQuery, TerminalSize,
    TerminalSnapshot,
};

pub fn validate_size(size: TerminalSize) -> Result<TerminalSize> {
    if !size.is_valid() {
        return Err(Error::Invalid("invalid terminal dimensions".into()));
    }
    Ok(size)
}

pub mod screen;

pub struct Output {
    screen: screen::Screen,
    initial_size: TerminalSize,
    events: VecDeque<(TerminalEvent, usize)>,
    bytes: usize,
    seq: i64,
    query_carry: Vec<u8>,
    exited: bool,
    exit_code: Option<u32>,
    busy_since: Option<i64>,
    last_activity_at: Option<i64>,
    activity_version: u64,
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
            query_carry: Vec::new(),
            exited: false,
            exit_code: None,
            busy_since: None,
            last_activity_at: None,
            activity_version: 0,
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

    fn write(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        self.screen.process(bytes);
        self.push(
            TerminalEvent::Output {
                data_b64: STANDARD.encode(bytes),
            },
            bytes.len(),
        );
        self.update_output_activity(bytes);
        self.terminal_query_responses(bytes)
    }

    fn mark_activity(&mut self, now: i64) {
        if self.exited {
            return;
        }
        let changed = self.busy_since.is_none() || self.last_activity_at != Some(now);
        self.busy_since.get_or_insert(now);
        self.last_activity_at = Some(now);
        if changed {
            self.activity_version = self.activity_version.wrapping_add(1);
        }
    }

    fn activity(&mut self, now: i64) -> TerminalActivity {
        if self.exited
            || self
                .last_activity_at
                .is_some_and(|last| now.saturating_sub(last) >= ACTIVITY_IDLE_MS)
        {
            self.clear_activity();
        }
        TerminalActivity {
            version: self.activity_version,
            busy_since: self.busy_since,
            last_activity_at: self.last_activity_at,
            exited: self.exited,
        }
    }

    fn set_exited(&mut self, exit_code: Option<u32>) {
        self.exited = true;
        self.exit_code = exit_code;
        self.clear_activity();
    }

    fn update_output_activity(&mut self, bytes: &[u8]) {
        if output_looks_idle(bytes) || self.screen_looks_idle() {
            self.clear_activity();
        } else {
            self.mark_activity(crate::database::now());
        }
    }

    fn clear_activity(&mut self) {
        if self.busy_since.is_some() || self.last_activity_at.is_some() {
            self.busy_since = None;
            self.last_activity_at = None;
            self.activity_version = self.activity_version.wrapping_add(1);
        }
    }

    fn screen_looks_idle(&self) -> bool {
        let text = self.screen.visible_tail_text(ACTIVITY_TAIL_LINES);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return false;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("esc to interrupt")
            || lower.contains("ctrl-c to quit")
            || lower.contains("background terminal running")
        {
            return false;
        }
        lower.contains("ask codex to do anything")
            || lower.contains("new task? /clear")
            || text
                .lines()
                .any(|line| matches!(line.trim(), "\u{276f}" | "\u{203a}"))
    }

    fn terminal_query_responses(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        let carry_len = self.query_carry.len();
        let mut text = std::mem::take(&mut self.query_carry);
        text.extend_from_slice(bytes);
        self.query_carry = text[text.len().saturating_sub(8)..].to_vec();

        let mut responses = Vec::new();
        scan_terminal_query(
            &text,
            carry_len,
            b"\x1b[6n",
            || {
                let (row, col) = self.screen.cursor_position();
                format!("\x1b[{};{}R", row + 1, col + 1).into_bytes()
            },
            &mut responses,
        );
        scan_terminal_query(
            &text,
            carry_len,
            b"\x1b[c",
            || b"\x1b[?6c".to_vec(),
            &mut responses,
        );
        scan_terminal_query(
            &text,
            carry_len,
            b"\x1b[0c",
            || b"\x1b[?6c".to_vec(),
            &mut responses,
        );
        scan_terminal_query(
            &text,
            carry_len,
            b"\x1b]10;?",
            || b"\x1b]10;rgb:c0c0/caca/f5f5\x1b\\".to_vec(),
            &mut responses,
        );
        scan_terminal_query(
            &text,
            carry_len,
            b"\x1b]11;?",
            || b"\x1b]11;rgb:1a1a/1b1b/2626\x1b\\".to_vec(),
            &mut responses,
        );
        responses
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

pub(crate) struct TerminalActivity {
    version: u64,
    pub busy_since: Option<i64>,
    pub last_activity_at: Option<i64>,
    pub exited: bool,
}

fn scan_terminal_query(
    text: &[u8],
    carry_len: usize,
    pattern: &[u8],
    response: impl Fn() -> Vec<u8>,
    responses: &mut Vec<Vec<u8>>,
) {
    for index in text
        .windows(pattern.len())
        .enumerate()
        .filter_map(|(index, window)| (window == pattern).then_some(index))
    {
        if index + pattern.len() > carry_len {
            responses.push(response());
        }
    }
}

fn output_looks_idle(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let lower = text.to_ascii_lowercase();
    text.lines()
        .any(|line| matches!(line.trim(), "\u{276f}" | "\u{203a}"))
        || lower.contains("ask codex to do anything")
        || lower.contains("new task? /clear")
}

enum Control {
    Input(Vec<u8>, oneshot::Sender<Result<()>>),
    Resize(TerminalSize, oneshot::Sender<Result<()>>),
}

struct Inner {
    sender: mpsc::Sender<Control>,
    output: Arc<Mutex<Output>>,
    notifier: watch::Sender<u64>,
    changed: watch::Receiver<u64>,
    stop: Arc<AtomicBool>,
    wake: native::Wake,
}

impl Inner {
    fn wake(&self) {
        self.wake.signal();
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

    pub(crate) fn activity(&self) -> Result<TerminalActivity> {
        Ok(self
            .0
            .output
            .lock()
            .map_err(|_| Error::Closed)?
            .activity(crate::database::now()))
    }

    pub(crate) async fn wait_activity(&self, version: u64, timeout: Duration) {
        let mut changed = self.0.changed.clone();
        loop {
            changed.borrow_and_update();
            if self
                .0
                .output
                .lock()
                .is_ok_and(|output| output.activity_version != version || output.exited)
            {
                return;
            }
            match tokio::time::timeout(timeout, changed.changed()).await {
                Ok(Ok(())) => {}
                _ => return,
            }
        }
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
        let result = self.control(|reply| Control::Input(bytes, reply)).await;
        if result.is_ok() {
            if let Ok(mut output) = self.0.output.lock() {
                output.mark_activity(crate::database::now());
            }
            self.0.notifier.send_modify(|v| *v = v.wrapping_add(1));
        }
        result
    }

    pub async fn resize(&self, size: TerminalSize) -> Result<()> {
        let size = validate_size(size)?;
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
        tokio::time::timeout(Duration::from_secs(1), receiver)
            .await
            .map_err(|_| Error::Timeout)?
            .map_err(|_| Error::Closed)?
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

mod native;

#[cfg(unix)]
pub mod guard;

pub use native::spawn;

pub mod runtime;
mod store;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_activity_clears_when_prompt_returns() {
        let mut output = Output::new(TerminalSize { cols: 80, rows: 24 });
        output.write(b"running");
        assert!(output.activity(crate::database::now()).busy_since.is_some());
        output.write("\r\n\u{276f}\r\n".as_bytes());
        assert_eq!(output.activity(crate::database::now()).busy_since, None);
    }
}
