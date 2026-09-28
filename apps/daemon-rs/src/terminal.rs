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

#[derive(Clone, serde::Serialize, serde::Deserialize)]
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
        let responses = self.terminal_query_responses(bytes);
        self.push(
            TerminalEvent::Output {
                data_b64: STANDARD.encode(bytes),
            },
            bytes.len(),
        );
        self.update_output_activity(bytes);
        responses
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
        let mut queries = Vec::new();
        // Match normalized numeric parameters, as xterm's public parser hooks
        // do (e.g. CSI 0006 n is still a cursor-position query).
        for start in 0..text.len().saturating_sub(2) {
            if text[start] != 0x1b || !matches!(text[start + 1], b'[' | b']') {
                continue;
            }
            let mut end = start + 2;
            while end < text.len() && text[end].is_ascii_digit() {
                end += 1;
            }
            let parameter = text[start + 2..end].iter().try_fold(0_u32, |value, digit| {
                value.checked_mul(10)?.checked_add(u32::from(digit - b'0'))
            });
            let kind = match (text[start + 1], parameter, text.get(end)) {
                (b'[', Some(6), Some(b'n')) => Some((end + 1, 0)),
                (b'[', Some(0), Some(b'c')) => Some((end + 1, 1)),
                (b']', Some(10 | 11), Some(b';')) if text.get(end + 1) == Some(&b'?') => {
                    Some((end + 2, if parameter == Some(10) { 2 } else { 3 }))
                }
                _ => None,
            };
            if let Some((end, kind)) = kind.filter(|(end, _)| *end > carry_len) {
                queries.push((end, kind));
            }
        }
        queries.sort_unstable();
        let mut responses = Vec::new();
        let mut processed = carry_len;
        for (end, kind) in queries {
            let current_end = end.min(text.len());
            if current_end > processed {
                self.screen.process(&text[processed..current_end]);
                processed = current_end;
            }
            responses.push(match kind {
                0 => {
                    let (row, col) = self.screen.cursor_position();
                    format!("\x1b[{};{}R", row + 1, col + 1).into_bytes()
                }
                1 => b"\x1b[?6c".to_vec(),
                2 => b"\x1b]10;rgb:c0c0/caca/f5f5\x1b\\".to_vec(),
                _ => b"\x1b]11;rgb:1a1a/1b1b/2626\x1b\\".to_vec(),
            });
        }
        if processed < text.len() {
            self.screen.process(&text[processed..]);
        }
        let tail = text
            .iter()
            .rposition(|byte| *byte == 0x1b)
            .filter(|start| text.len() - start <= 8192)
            .filter(|start| {
                let suffix = &text[*start + 1..];
                match suffix.first() {
                    Some(b'[') => suffix[1..].iter().all(u8::is_ascii_digit),
                    Some(b']') => suffix[1..]
                        .strip_suffix(b";")
                        .unwrap_or(&suffix[1..])
                        .iter()
                        .all(u8::is_ascii_digit),
                    _ => false,
                }
            })
            .unwrap_or_else(|| text.len().saturating_sub(8));
        self.query_carry = text[tail..].to_vec();
        responses
    }

    fn page(&self, after: i64) -> Result<TerminalPage> {
        if after < 0 {
            return Err(Error::Invalid("terminal cursor is ahead of output".into()));
        }
        let floor = self.seq - self.events.len() as i64;
        let mut events = Vec::new();
        let mut bytes = 0;
        if after >= floor && after <= self.seq {
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
            resync_required: after < floor || after > self.seq,
            events,
            exited: self.exited,
            exit_code: self.exit_code,
        })
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct TerminalActivity {
    version: u64,
    pub busy_since: Option<i64>,
    pub last_activity_at: Option<i64>,
    pub exited: bool,
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
    epoch: String,
    sender: mpsc::Sender<Control>,
    output: Arc<Mutex<Output>>,
    notifier: watch::Sender<u64>,
    changed: watch::Receiver<u64>,
    stop: Arc<AtomicBool>,
    wake: native::Wake,
    controller: Mutex<Option<String>>,
    controller_changed: watch::Sender<u64>,
    stream_slots: Arc<tokio::sync::Semaphore>,
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
    pub fn epoch(&self) -> &str {
        &self.0.epoch
    }
    pub fn controller(&self) -> Result<Option<String>> {
        Ok(self.0.controller.lock().map_err(|_| Error::Closed)?.clone())
    }
    pub fn acquire_controller(&self, client: &str, takeover: bool) -> Result<bool> {
        let mut c = self.0.controller.lock().map_err(|_| Error::Closed)?;
        if c.is_none() || c.as_deref() == Some(client) || takeover {
            if c.as_deref() != Some(client) {
                *c = Some(client.into());
                self.0
                    .controller_changed
                    .send_modify(|value| *value = value.wrapping_add(1));
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }
    pub fn release_controller(&self, client: &str) -> Result<bool> {
        let mut c = self.0.controller.lock().map_err(|_| Error::Closed)?;
        if c.as_deref() == Some(client) {
            *c = None;
            self.0
                .controller_changed
                .send_modify(|value| *value = value.wrapping_add(1));
            Ok(true)
        } else {
            Ok(false)
        }
    }
    pub fn legacy_control_allowed(&self) -> Result<bool> {
        Ok(self
            .0
            .controller
            .lock()
            .map_err(|_| Error::Closed)?
            .is_none())
    }
    pub(crate) fn controller_changes(&self) -> watch::Receiver<u64> {
        self.0.controller_changed.subscribe()
    }
    pub(crate) fn stream_permit(&self) -> Result<tokio::sync::OwnedSemaphorePermit> {
        self.0
            .stream_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)
    }
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
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait.into());
        loop {
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
            // Activity notifications are not output. Keep the same deadline
            // rather than returning an empty page or extending the long poll.
            match tokio::time::timeout_at(deadline, changed.changed()).await {
                Ok(Ok(())) => {}
                _ => return self.0.output.lock().map_err(|_| Error::Closed)?.page(after),
            }
        }
    }

    pub async fn input(&self, input: TerminalInput) -> Result<()> {
        self.input_authorized(input, None).await
    }
    pub async fn input_as(&self, client: &str, input: TerminalInput) -> Result<()> {
        self.input_authorized(input, Some(client)).await
    }
    async fn input_authorized(&self, input: TerminalInput, client: Option<&str>) -> Result<()> {
        if input.data_b64.len() > INPUT_BYTES.div_ceil(3) * 4 {
            return Err(Error::Invalid("terminal input exceeds limit".into()));
        }
        let bytes = STANDARD
            .decode(input.data_b64)
            .map_err(|_| Error::Invalid("invalid terminal input".into()))?;
        if bytes.is_empty() || bytes.len() > INPUT_BYTES {
            return Err(Error::Invalid("invalid terminal input length".into()));
        }
        let result = self
            .control(|reply| Control::Input(bytes, reply), None, client)
            .await;
        if result.is_ok() {
            if let Ok(mut output) = self.0.output.lock() {
                output.mark_activity(crate::database::now());
            }
            self.0.notifier.send_modify(|v| *v = v.wrapping_add(1));
        }
        result
    }

    pub async fn resize(&self, size: TerminalSize) -> Result<()> {
        self.resize_authorized(size, None).await
    }
    pub async fn resize_as(&self, client: &str, size: TerminalSize) -> Result<()> {
        self.resize_authorized(size, Some(client)).await
    }
    async fn resize_authorized(&self, size: TerminalSize, client: Option<&str>) -> Result<()> {
        let size = validate_size(size)?;
        self.control(
            |reply| Control::Resize(size, reply),
            Some(Duration::from_secs(1)),
            client,
        )
        .await
    }

    async fn control(
        &self,
        build: impl FnOnce(oneshot::Sender<Result<()>>) -> Control,
        timeout: Option<Duration>,
        client: Option<&str>,
    ) -> Result<()> {
        if self.0.stop.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let (reply, receiver) = oneshot::channel();
        {
            // Ownership check and queue admission share the same lock with
            // takeover. Commands accepted before takeover may finish; stale
            // commands arriving afterwards never enter the PTY queue.
            let owner = self.0.controller.lock().map_err(|_| Error::Closed)?;
            if owner.as_deref() != client {
                return Err(Error::Conflict);
            }
            self.0.sender.try_send(build(reply)).map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => Error::Busy,
                mpsc::error::TrySendError::Closed(_) => Error::Closed,
            })?;
        }
        self.0.wake();
        if let Some(timeout) = timeout {
            tokio::time::timeout(timeout, receiver)
                .await
                .map_err(|_| Error::Timeout)?
                .map_err(|_| Error::Closed)??;
        } else {
            receiver.await.map_err(|_| Error::Closed)??;
        }
        Ok(())
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
pub mod stream;
pub(crate) mod stream_session;

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

    #[test]
    fn dsr_response_uses_cursor_at_query_position() {
        let mut output = Output::new(TerminalSize { cols: 80, rows: 24 });
        let responses = output.write(b"abc\x1b[6nxyz");
        assert_eq!(responses, vec![b"\x1b[1;4R".to_vec()]);
    }

    #[test]
    fn split_terminal_query_is_answered_once() {
        let mut output = Output::new(TerminalSize { cols: 80, rows: 24 });
        assert!(output.write(b"abc\x1b[").is_empty());
        assert_eq!(output.write(b"6n"), vec![b"\x1b[1;4R".to_vec()]);
    }

    #[test]
    fn numeric_query_parameters_match_renderer_normalization_across_chunks() {
        let mut output = Output::new(TerminalSize { cols: 80, rows: 24 });
        let mut responses = Vec::new();
        for byte in b"abc\x1b[00000000000000000006nxyz\x1b[0000000000000000c\x1b]000000000010;?\x07"
        {
            responses.extend(output.write(&[*byte]));
        }
        assert_eq!(
            responses,
            vec![
                b"\x1b[1;4R".to_vec(),
                b"\x1b[?6c".to_vec(),
                b"\x1b]10;rgb:c0c0/caca/f5f5\x1b\\".to_vec()
            ]
        );
    }

    #[test]
    fn normalized_numeric_terminal_queries_are_answered() {
        let mut output = Output::new(TerminalSize { cols: 80, rows: 24 });
        assert_eq!(output.write(b"x\x1b[06n"), vec![b"\x1b[1;2R".to_vec()]);
        assert_eq!(output.write(b"\x1b[00c"), vec![b"\x1b[?6c".to_vec()]);
    }
}

pub mod host;

mod handle;
