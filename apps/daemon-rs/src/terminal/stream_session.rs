//! One streaming state machine for local and detached-owner PTYs.
use super::stream::{self, Frame, Kind};
use super::{Terminal, TerminalEvent, TerminalInput, TerminalQuery, TerminalSize, validate_size};
use crate::error::{Error, Result};
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use serde::Deserialize;
use serde_json::json;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

type Sink = SplitSink<WebSocket, Message>;
type Source = SplitStream<WebSocket>;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PENDING_FRAMES: usize = 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attach {
    after_seq: Option<u64>,
    epoch: Option<String>,
    want_control: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Acquire {
    takeover: bool,
}

pub(crate) struct ClientAttachInfo {
    pub after_seq: Option<u64>,
    pub epoch: Option<String>,
}

pub(crate) fn inspect_client_attach(bytes: &[u8]) -> Option<ClientAttachInfo> {
    let frame = stream::decode(bytes).ok()?;
    if frame.kind != Kind::Attach || frame.sequence != 0 || frame.payload.len() > 4096 {
        return None;
    }
    let attach: Attach = serde_json::from_slice(&frame.payload).ok()?;
    Some(ClientAttachInfo {
        after_seq: attach.after_seq,
        epoch: attach.epoch,
    })
}

pub(crate) fn is_hello_frame(bytes: &[u8]) -> bool {
    stream::decode(bytes).is_ok_and(|frame| frame.kind == Kind::Hello)
}

pub(crate) fn is_history_gap_error(bytes: &[u8]) -> bool {
    let Ok(frame) = stream::decode(bytes) else {
        return false;
    };
    if frame.kind != Kind::Error {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&frame.payload) else {
        return false;
    };
    value["code"].as_str() == Some("history_gap")
}

#[derive(Clone)]
enum StreamTarget {
    Local(Terminal),
    HostedFallback(super::host::Host),
}

impl StreamTarget {
    fn stream_permit(&self) -> Result<tokio::sync::OwnedSemaphorePermit> {
        match self {
            Self::Local(t) => t.stream_permit(),
            Self::HostedFallback(h) => h.fallback_stream_permit(),
        }
    }
    fn epoch(&self) -> &str {
        match self {
            Self::Local(t) => t.epoch(),
            Self::HostedFallback(h) => h.fallback_epoch(),
        }
    }
    fn controller(&self) -> Result<Option<String>> {
        match self {
            Self::Local(t) => t.controller(),
            Self::HostedFallback(h) => h.fallback_controller(),
        }
    }
    fn acquire_controller(&self, client: &str, takeover: bool) -> Result<bool> {
        match self {
            Self::Local(t) => t.acquire_controller(client, takeover),
            Self::HostedFallback(h) => h.acquire_fallback_controller(client, takeover),
        }
    }
    fn release_controller(&self, client: &str) -> Result<bool> {
        match self {
            Self::Local(t) => t.release_controller(client),
            Self::HostedFallback(h) => h.release_fallback_controller(client),
        }
    }
    fn controller_changes(&self) -> tokio::sync::watch::Receiver<u64> {
        match self {
            Self::Local(t) => t.controller_changes(),
            Self::HostedFallback(h) => h.fallback_controller_changes(),
        }
    }
    async fn snapshot(&self) -> Result<Option<super::TerminalSnapshot>> {
        match self {
            Self::Local(t) => {
                let term = t.clone();
                tokio::task::spawn_blocking(move || term.snapshot())
                    .await
                    .map_err(|_| Error::Closed)?
            }
            Self::HostedFallback(h) => h.get("snapshot").await,
        }
    }
    fn fallback_size(&self, default: TerminalSize) -> TerminalSize {
        match self {
            Self::Local(t) => t.size().unwrap_or(default),
            Self::HostedFallback(_) => default,
        }
    }
    async fn read(&self, query: TerminalQuery) -> Result<super::TerminalPage> {
        match self {
            Self::Local(t) => t.read(query).await,
            Self::HostedFallback(h) => {
                h.get(&format!(
                    "output?afterSeq={}&waitMs={}",
                    query.after_seq.unwrap_or(0),
                    query.wait_ms.unwrap_or(0)
                ))
                .await
            }
        }
    }
    fn spawn_input(
        &self,
        client: String,
        input: TerminalInput,
    ) -> tokio::task::JoinHandle<Result<()>> {
        match self {
            Self::Local(t) => {
                let term = t.clone();
                tokio::spawn(async move { term.input_as(&client, input).await })
            }
            Self::HostedFallback(h) => {
                let host = h.clone();
                tokio::spawn(async move { host.fallback_input_as(&client, input).await })
            }
        }
    }
    fn spawn_resize(
        &self,
        client: String,
        size: TerminalSize,
    ) -> tokio::task::JoinHandle<Result<()>> {
        match self {
            Self::Local(t) => {
                let term = t.clone();
                tokio::spawn(async move { term.resize_as(&client, size).await })
            }
            Self::HostedFallback(h) => {
                let host = h.clone();
                tokio::spawn(async move { host.fallback_resize_as(&client, size).await })
            }
        }
    }
}

struct HostedOutputWatcher {
    rx: tokio::sync::watch::Receiver<(i64, bool)>,
    task: tokio::task::JoinHandle<()>,
}

impl HostedOutputWatcher {
    fn spawn(host: super::host::Host, initial_seq: i64, initial_exited: bool) -> Self {
        let (tx, rx) = tokio::sync::watch::channel((initial_seq, initial_exited));
        let task = tokio::spawn(async move {
            let mut seen = initial_seq;
            if initial_exited {
                return;
            }
            loop {
                match host
                    .get::<super::TerminalPage>(&format!("output?afterSeq={seen}&waitMs=2000"))
                    .await
                {
                    Ok(page) => {
                        let prev = seen;
                        seen = if page.resync_required {
                            page.floor_seq.max(page.latest_seq)
                        } else {
                            page.latest_seq
                        };
                        let _ = tx.send_if_modified(|state| {
                            let next = (seen, page.exited);
                            if *state != next {
                                *state = next;
                                true
                            } else {
                                false
                            }
                        });
                        if page.exited {
                            break;
                        }
                        if seen == prev {
                            tokio::time::sleep(Duration::from_millis(25)).await;
                        }
                    }
                    Err(_) => {
                        let _ = tx.send_if_modified(|state| {
                            if !state.1 {
                                state.1 = true;
                                true
                            } else {
                                false
                            }
                        });
                        break;
                    }
                }
            }
        });
        Self { rx, task }
    }

    async fn wait_output(&mut self, cursor: i64) {
        loop {
            self.rx.borrow_and_update();
            let (latest, exited) = *self.rx.borrow();
            if latest != cursor || exited {
                return;
            }
            if self.rx.changed().await.is_err() {
                return;
            }
        }
    }
}

impl Drop for HostedOutputWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Lease {
    target: StreamTarget,
    client: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = self.target.release_controller(&self.client);
    }
}
struct Command(Option<(u64, tokio::task::JoinHandle<Result<()>>)>);
impl Drop for Command {
    fn drop(&mut self) {
        if let Some((_, task)) = &self.0 {
            task.abort();
        }
    }
}

#[derive(Default)]
struct Credit {
    pending: VecDeque<(u64, usize)>,
    bytes: usize,
    last_sent: u64,
    acknowledged: u64,
}
impl Credit {
    fn accepts(&self, bytes: usize, snapshot: bool) -> bool {
        self.pending.len() < MAX_PENDING_FRAMES
            && (self.bytes + bytes <= stream::WINDOW_BYTES
                || snapshot && self.pending.is_empty() && bytes <= stream::MAX_PAYLOAD)
    }
    fn sent(&mut self, sequence: u64, bytes: usize) {
        self.pending.push_back((sequence, bytes));
        self.bytes += bytes;
        self.last_sent = sequence;
    }
    fn applied(&mut self, sequence: u64) -> Result<()> {
        if sequence > self.last_sent || sequence < self.acknowledged {
            return Err(Error::Invalid("invalid terminal acknowledgement".into()));
        }
        self.acknowledged = sequence;
        while self
            .pending
            .front()
            .is_some_and(|(seq, _)| *seq <= sequence)
        {
            self.bytes -= self.pending.pop_front().expect("front exists").1;
        }
        Ok(())
    }
}

pub(crate) async fn serve(socket: WebSocket, terminal: Terminal) -> Result<()> {
    let (sink, source) = socket.split();
    serve_parts(sink, source, StreamTarget::Local(terminal), None).await
}

pub(crate) async fn serve_hosted_fallback(
    sink: Sink,
    source: Source,
    host: super::host::Host,
    first_frame: Bytes,
) -> Result<()> {
    serve_parts(
        sink,
        source,
        StreamTarget::HostedFallback(host),
        Some(first_frame),
    )
    .await
}

async fn wait_target_output(
    target: &StreamTarget,
    watcher: &mut Option<HostedOutputWatcher>,
    cursor: i64,
) {
    match (target, watcher) {
        (StreamTarget::Local(t), _) => t.wait_output(cursor).await,
        (StreamTarget::HostedFallback(_), Some(w)) => w.wait_output(cursor).await,
        (StreamTarget::HostedFallback(_), None) => {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

async fn close_sink(sink: &mut Sink) {
    let _ = tokio::time::timeout(Duration::from_secs(1), sink.close()).await;
}

async fn serve_parts(
    mut sink: Sink,
    mut source: Source,
    target: StreamTarget,
    initial_attach: Option<Bytes>,
) -> Result<()> {
    let _permit = match target.stream_permit() {
        Ok(permit) => permit,
        Err(error) => {
            let _ = send_error(&mut sink, "busy", "Too many terminal viewers").await;
            close_sink(&mut sink).await;
            return Err(error);
        }
    };
    let result = async {
        let bytes = match initial_attach {
            Some(bytes) => bytes,
            None => {
                let first = tokio::time::timeout(IO_TIMEOUT, source.next()).await.map_err(|_| Error::Timeout)?
                    .ok_or(Error::Closed)?.map_err(|_| Error::Closed)?;
                let Message::Binary(bytes) = first else { return Err(Error::Invalid("binary Attach required".into())); };
                bytes
            }
        };
        let frame = stream::decode(&bytes)?;
        if frame.kind != Kind::Attach || frame.sequence != 0 || frame.payload.len() > 4096 {
            return Err(Error::Invalid("Attach required as first frame".into()));
        }
        let attach: Attach = serde_json::from_slice(&frame.payload)?;
        if attach.after_seq.is_some() && attach.epoch.is_none() {
            return Err(Error::Invalid("resume requires an epoch".into()));
        }
        if attach.epoch.as_deref().is_some_and(|seen| seen != target.epoch()) {
            send_error(&mut sink, "epoch_mismatch", "The terminal process changed; start a fresh attachment").await?;
            return Ok(());
        }
        let client = uuid::Uuid::new_v4().to_string();
        let _lease = Lease { target: target.clone(), client: client.clone() };
        let mut lease_changes = target.controller_changes();
        let mut cursor = attach.after_seq.unwrap_or(0);
        let mut snapshot = if attach.after_seq.is_none() {
            target.snapshot().await?
        } else { None };
        let initial = target.read(TerminalQuery { after_seq: Some(snapshot.as_ref().map(|snapshot| snapshot.seq).unwrap_or(cursor as i64)), wait_ms: Some(0) }).await?;
        if attach.after_seq.is_none() && snapshot.is_none() && initial.resync_required {
            snapshot = Some(super::TerminalSnapshot {
                seq: initial.floor_seq,
                size: target.fallback_size(initial.initial_size),
                data_b64: String::new(),
            });
        }
        if (initial.resync_required && snapshot.is_none()) || cursor > initial.latest_seq as u64 {
            send_error(&mut sink, "history_gap", "The retained output cannot reconstruct this terminal").await?;
            return Ok(());
        }
        let mut hosted_watcher = match &target {
            StreamTarget::Local(_) => None,
            StreamTarget::HostedFallback(host) => Some(HostedOutputWatcher::spawn(
                host.clone(),
                initial.latest_seq,
                initial.exited,
            )),
        };
        let size = snapshot.as_ref().map(|s| s.size).unwrap_or(initial.initial_size);
        let barrier = initial.latest_seq as u64;
        let mut exited = initial.exited;
        if attach.want_control && !exited { let _ = target.acquire_controller(&client, false)?; }
        let owner = target.controller()?;
        send_json(&mut sink, Kind::Hello, 0, json!({"version":1,"epoch":target.epoch(),"clientId":client,
            "controllerId":owner,"cols":size.cols,"rows":size.rows,"windowBytes":stream::WINDOW_BYTES,
            "latestSeq":barrier,"floorSeq":initial.floor_seq,"exited":exited})).await?;
        let mut credit = Credit { last_sent: cursor, acknowledged: cursor, ..Credit::default() };
        if let Some(snapshot) = snapshot {
            let payload = STANDARD.decode(snapshot.data_b64).map_err(|_| Error::Closed)?;
            if !credit.accepts(payload.len(), true) { return Err(Error::Invalid("snapshot exceeds stream limit".into())); }
            cursor = snapshot.seq as u64;
            credit.sent(cursor, payload.len());
            send(&mut sink, Frame { kind: Kind::Snapshot, sequence: cursor, payload }).await?;
        }
        let mut ready = false;
        let mut exit_sent = false;
        let mut output_blocked = false;
        let mut last_operation = 0;
        let mut command = Command(None);
        let mut last_state = None;
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last_received = Instant::now();
        loop {
            // Pull one bounded page from the owner. Credit remains in force
            // during bootstrap replay as well as live output.
            if !output_blocked && !exit_sent {
                let page = target.read(TerminalQuery { after_seq: Some(cursor as i64), wait_ms: Some(0) }).await?;
                if page.resync_required {
                    send_error(&mut sink, "history_gap", "This viewer fell behind retained terminal output").await?;
                    return Ok(());
                }
                for event in page.events {
                    let (kind, payload) = match event {
                        TerminalEvent::Output { data_b64 } => (Kind::Output, STANDARD.decode(data_b64).map_err(|_| Error::Closed)?),
                        TerminalEvent::Resize { size } => (Kind::Resize, [size.cols.to_be_bytes(), size.rows.to_be_bytes()].concat()),
                    };
                    if !credit.accepts(payload.len(), false) { output_blocked = true; break; }
                    cursor += 1;
                    credit.sent(cursor, payload.len());
                    send(&mut sink, Frame { kind, sequence: cursor, payload }).await?;
                }
                exited = page.exited && cursor == page.latest_seq as u64;
                if !ready && cursor >= barrier {
                    // This marker follows all output sent through this cursor.
                    send(&mut sink, Frame { kind: Kind::Ready, sequence: cursor, payload: vec![] }).await?;
                    ready = true;
                }
                if exited && !exit_sent {
                    let _ = target.release_controller(&client);
                    send_json(&mut sink, Kind::Exit, cursor, json!({"exitCode":page.exit_code})).await?;
                    exit_sent = true;
                }
            }
            let owner = target.controller()?;
            if last_state.as_ref() != Some(&(owner.clone(), exited)) {
                send_json(&mut sink, Kind::State, cursor, json!({"controllerId":owner,
                    "readOnly":exited || owner.as_deref()!=Some(&client),"exited":exited})).await?;
                last_state = Some((owner, exited));
            }
            // All final output has reached the renderer; do not keep an
            // already-exited Host alive solely for an idle viewer socket.
            if exit_sent && credit.pending.is_empty() { break; }
            tokio::select! {
                message = source.next() => {
                    let Some(message) = message else { break; };
                    last_received = Instant::now();
                    let bytes = match message.map_err(|_| Error::Closed)? {
                        Message::Binary(bytes) => bytes,
                        Message::Close(_) => break,
                        Message::Ping(bytes) => { send_message(&mut sink, Message::Pong(bytes)).await?; continue; }
                        Message::Pong(_) => continue,
                        _ => return Err(Error::Invalid("binary terminal frames required".into())),
                    };
                    let frame = stream::decode(&bytes)?;
                    if frame.kind == Kind::Applied {
                        if !frame.payload.is_empty() { return Err(Error::Invalid("Applied must be empty".into())); }
                        credit.applied(frame.sequence)?; output_blocked = false; continue;
                    }
                    if frame.sequence == 0 || frame.sequence <= last_operation {
                        return Err(Error::Invalid("duplicate/out-of-order terminal operation".into()));
                    }
                    last_operation = frame.sequence;
                    match frame.kind {
                        Kind::Input | Kind::ResizeRequest => {
                            if !ready || exited || target.controller()?.as_deref()!=Some(&client) {
                                send_result(&mut sink, frame.sequence, Err(Error::Conflict)).await?; continue;
                            }
                            if command.0.is_some() { send_result(&mut sink, frame.sequence, Err(Error::Busy)).await?; continue; }
                            let sequence = frame.sequence;
                            let task = if frame.kind == Kind::Input {
                                if frame.payload.is_empty() || frame.payload.len() > super::INPUT_BYTES { return Err(Error::Invalid("invalid input size".into())); }
                                let input = TerminalInput { data_b64: STANDARD.encode(frame.payload) };
                                target.spawn_input(client.clone(), input)
                            } else {
                                if frame.payload.len()!=4 { return Err(Error::Invalid("invalid resize size".into())); }
                                let size = validate_size(TerminalSize { cols:u16::from_be_bytes([frame.payload[0],frame.payload[1]]), rows:u16::from_be_bytes([frame.payload[2],frame.payload[3]]) })?;
                                target.spawn_resize(client.clone(), size)
                            };
                            command.0 = Some((sequence, task));
                        }
                        Kind::Acquire => {
                            if frame.payload.len()>4096 { return Err(Error::Invalid("Acquire too large".into())); }
                            let request: Acquire = serde_json::from_slice(&frame.payload)?;
                            let acquired = !exited && target.acquire_controller(&client, request.takeover)?;
                            send_result(&mut sink, frame.sequence, if acquired {Ok(())} else {Err(Error::Conflict)}).await?;
                        }
                        Kind::Release => {
                            if !frame.payload.is_empty() { return Err(Error::Invalid("Release must be empty".into())); }
                            let released = target.release_controller(&client)?;
                            send_result(&mut sink, frame.sequence, if released {Ok(())} else {Err(Error::Conflict)}).await?;
                        }
                        _ => return Err(Error::Invalid("unexpected client terminal frame".into())),
                    }
                }
                completed = async { (&mut command.0.as_mut().expect("guarded command").1).await }, if command.0.is_some() => {
                    let sequence = command.0.take().expect("completed command").0;
                    send_result(&mut sink, sequence, completed.map_err(|_| Error::Closed)?).await?;
                }
                _ = wait_target_output(&target, &mut hosted_watcher, cursor as i64), if !output_blocked && !exit_sent => {}
                changed = lease_changes.changed() => { changed.map_err(|_| Error::Closed)?; }
                _ = heartbeat.tick() => {
                    if last_received.elapsed() > Duration::from_secs(45) { return Err(Error::Timeout); }
                    send_message(&mut sink, Message::Ping(Vec::new().into())).await?;
                }
            }
        }
        Ok(())
    }.await;
    if let Err(error) = &result {
        let code = match error {
            Error::Busy => "busy",
            Error::Timeout => "timeout",
            Error::Closed => "closed",
            Error::Feature(code, _) if code == "terminal_replay_unavailable" => code.as_str(),
            _ => "protocol_error",
        };
        let message = if let Error::Invalid(reason) | Error::Feature(_, reason) = error {
            reason.as_str()
        } else {
            "Terminal stream ended; unacknowledged input was not replayed"
        };
        let _ = send_error(&mut sink, code, message).await;
    }
    close_sink(&mut sink).await;
    result
}

async fn send_message(sink: &mut Sink, message: Message) -> Result<()> {
    tokio::time::timeout(IO_TIMEOUT, sink.send(message))
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::Closed)
}
async fn send(sink: &mut Sink, frame: Frame) -> Result<()> {
    send_message(sink, Message::Binary(stream::encode(&frame)?.into())).await
}
async fn send_json(
    sink: &mut Sink,
    kind: Kind,
    sequence: u64,
    value: serde_json::Value,
) -> Result<()> {
    send(
        sink,
        Frame {
            kind,
            sequence,
            payload: serde_json::to_vec(&value)?,
        },
    )
    .await
}
async fn send_error(sink: &mut Sink, code: &str, message: &str) -> Result<()> {
    send_json(
        sink,
        Kind::Error,
        0,
        json!({"code":code,"message":message,"recoverable":false}),
    )
    .await
}
async fn send_result(sink: &mut Sink, sequence: u64, result: Result<()>) -> Result<()> {
    let value = match result {
        Ok(()) => json!({"ok":true}),
        Err(Error::Conflict) => json!({"ok":false,"code":"not_controller"}),
        Err(Error::Busy) => json!({"ok":false,"code":"busy"}),
        Err(_) => json!({"ok":false,"code":"input_failed"}),
    };
    send_json(sink, Kind::Result, sequence, value).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credit_accounts_snapshot_zero_and_rejects_future_or_backwards_acks() {
        let mut credit = Credit::default();
        credit.sent(0, 100);
        credit.applied(0).unwrap();
        assert_eq!(credit.bytes, 0);
        credit.sent(1, 8192);
        credit.sent(2, 8192);
        assert!(credit.applied(3).is_err());
        credit.applied(1).unwrap();
        assert_eq!(credit.bytes, 8192);
        credit.applied(1).unwrap();
        assert_eq!(credit.bytes, 8192);
        credit.applied(2).unwrap();
        assert!(credit.applied(1).is_err());
    }
    #[test]
    fn slow_viewers_and_oversized_snapshots_are_bounded() {
        let mut credit = Credit::default();
        assert!(credit.accepts(stream::MAX_PAYLOAD, true));
        credit.sent(4, stream::MAX_PAYLOAD);
        assert!(!credit.accepts(1, false));
        credit.applied(4).unwrap();
        assert!(credit.accepts(1, false));
        credit.sent(5, stream::WINDOW_BYTES);
        assert!(!credit.accepts(1, false));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cold_attach_recovers_tail_when_snapshot_is_unavailable_while_stale_resume_reports_gap()
    {
        use axum::{Router, extract::State, extract::ws::WebSocketUpgrade, routing::get};
        use futures_util::{SinkExt, StreamExt};
        use portable_pty::CommandBuilder;
        use tokio_tungstenite::tungstenite::Message as WsMessage;

        // Emit OSC 4 palette customization (which disables Screen snapshots), then
        // > 4,700 output events so replay prunes past 0, then wait for stdin.
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args([
            "-c",
            "printf '\\033]4;1;rgb:ff/00/00\\007'; \
             python3 -c 'import os, time\nfor i in range(4700):\n os.write(1, b\"x\")\n time.sleep(0.0002)\nos.write(1, b\"\\r\\nTAIL_OK\\r\\n\")'; \
             read line; printf 'ECHO:%s\\n' \"$line\"",
        ]);
        let terminal = super::super::spawn(cmd, TerminalSize { cols: 80, rows: 24 }).unwrap();
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let page = terminal
                    .read(TerminalQuery {
                        after_seq: Some(0),
                        wait_ms: Some(50),
                    })
                    .await
                    .unwrap();
                if page.resync_required {
                    let tail = terminal
                        .read(TerminalQuery {
                            after_seq: Some(page.latest_seq.saturating_sub(5)),
                            wait_ms: Some(0),
                        })
                        .await
                        .unwrap();
                    let combined: Vec<u8> = tail
                        .events
                        .into_iter()
                        .filter_map(|e| match e {
                            TerminalEvent::Output { data_b64 } => STANDARD.decode(data_b64).ok(),
                            _ => None,
                        })
                        .flatten()
                        .collect();
                    if String::from_utf8_lossy(&combined).contains("TAIL_OK") {
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("terminal should prune past floor_seq with TAIL_OK");
        assert!(terminal.snapshot().unwrap().is_none());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(
                "/stream",
                get(
                    |State(t): State<Terminal>, ws: WebSocketUpgrade| async move {
                        ws.on_upgrade(move |socket| async move {
                            let _ = serve(socket, t).await;
                        })
                    },
                ),
            )
            .with_state(terminal.clone());
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        // 1. Cold attach succeeds with retained tail + Ready + live input!
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/stream"))
            .await
            .unwrap();
        let attach = stream::encode(&Frame {
            kind: Kind::Attach,
            sequence: 0,
            payload: serde_json::to_vec(&json!({"wantControl": true})).unwrap(),
        })
        .unwrap();
        ws.send(WsMessage::Binary(attach.into())).await.unwrap();

        let mut epoch = String::new();
        let mut collected = Vec::new();
        loop {
            let bytes = match ws.next().await {
                Some(Ok(WsMessage::Binary(bytes))) => bytes,
                Some(Ok(WsMessage::Ping(payload))) => {
                    ws.send(WsMessage::Pong(payload)).await.unwrap();
                    continue;
                }
                Some(Ok(WsMessage::Pong(_))) => continue,
                other => panic!("unexpected stream message before Ready: {other:?}"),
            };
            let frame = stream::decode(&bytes).unwrap();
            match frame.kind {
                Kind::Hello => {
                    let val: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
                    epoch = val["epoch"].as_str().unwrap().to_owned();
                }
                Kind::Snapshot | Kind::Output | Kind::Resize => {
                    if frame.kind == Kind::Output {
                        collected.extend_from_slice(&frame.payload);
                    }
                    let ack = stream::encode(&Frame {
                        kind: Kind::Applied,
                        sequence: frame.sequence,
                        payload: vec![],
                    })
                    .unwrap();
                    ws.send(WsMessage::Binary(ack.into())).await.unwrap();
                }
                Kind::Ready => break,
                Kind::Error => {
                    let val: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
                    panic!("cold attach must not fail with error: {val}");
                }
                _ => {}
            }
        }
        assert!(String::from_utf8_lossy(&collected).contains("TAIL_OK"));
        let _ = ws.close(None).await;

        // 2. Stale incremental resume (afterSeq: 1) still reports history_gap + clean WS Close!
        let (mut resume_ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/stream"))
            .await
            .unwrap();
        let stale_attach = stream::encode(&Frame {
            kind: Kind::Attach,
            sequence: 0,
            payload: serde_json::to_vec(&json!({
                "afterSeq": 1,
                "epoch": epoch,
                "wantControl": false,
            }))
            .unwrap(),
        })
        .unwrap();
        resume_ws
            .send(WsMessage::Binary(stale_attach.into()))
            .await
            .unwrap();
        let err_bytes = loop {
            match resume_ws.next().await.unwrap().unwrap() {
                WsMessage::Binary(bytes) => break bytes,
                WsMessage::Ping(_) | WsMessage::Pong(_) => {}
                other => panic!("expected binary Error frame, got {other:?}"),
            }
        };
        assert!(is_history_gap_error(&err_bytes));
        let close_reply = loop {
            match resume_ws.next().await.unwrap().unwrap() {
                WsMessage::Ping(_) | WsMessage::Pong(_) => {}
                other => break other,
            }
        };
        assert!(
            matches!(close_reply, WsMessage::Close(_)),
            "expected clean WebSocket Close frame, got {close_reply:?}"
        );

        terminal.stop();
        server.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hosted_fallback_streams_retained_tail_and_forwards_input_for_legacy_hosts() {
        use axum::{
            Json, Router,
            extract::{Query, State, ws::WebSocketUpgrade},
            routing::{get, post},
        };
        use futures_util::{SinkExt, StreamExt};
        use std::sync::{Arc, Mutex};
        use tokio_tungstenite::tungstenite::Message as WsMessage;

        let received_inputs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let host_inputs = received_inputs.clone();
        let host_dir = tempfile::tempdir().unwrap();
        let session_dir = host_dir.path().join("legacy-host-id");
        std::fs::create_dir_all(&session_dir).unwrap();
        let token = "a".repeat(64);

        let legacy_host_router = Router::new()
            .route(
                "/identity",
                get(|| async {
                    Json(json!({
                        "id": "legacy-host-id",
                        "version": 1,
                        "capabilities": ["terminal.stream.v1"],
                    }))
                }),
            )
            .route(
                "/snapshot",
                get(|| async { Json(Option::<super::super::TerminalSnapshot>::None) }),
            )
            .route(
                "/output",
                get(|Query(q): Query<TerminalQuery>| async move {
                    let after = q.after_seq.unwrap_or(0);
                    if after < 500 {
                        Json(super::super::TerminalPage {
                            instance_start_seq: Some(0),
                            initial_size: TerminalSize {
                                cols: 120,
                                rows: 40,
                            },
                            base_seq: after,
                            next_seq: after,
                            latest_seq: 501,
                            floor_seq: 500,
                            resync_required: true,
                            events: vec![],
                            exited: false,
                            exit_code: None,
                        })
                    } else if after == 500 {
                        Json(super::super::TerminalPage {
                            instance_start_seq: Some(0),
                            initial_size: TerminalSize {
                                cols: 120,
                                rows: 40,
                            },
                            base_seq: 500,
                            next_seq: 501,
                            latest_seq: 501,
                            floor_seq: 500,
                            resync_required: false,
                            events: vec![TerminalEvent::Output {
                                data_b64: STANDARD.encode("RECOVERED_PROMPT$ "),
                            }],
                            exited: false,
                            exit_code: None,
                        })
                    } else {
                        if let Some(ms) = q.wait_ms.filter(|&m| m > 0) {
                            tokio::time::sleep(Duration::from_millis(u64::from(ms.min(50)))).await;
                        }
                        Json(super::super::TerminalPage {
                            instance_start_seq: Some(0),
                            initial_size: TerminalSize {
                                cols: 120,
                                rows: 40,
                            },
                            base_seq: after,
                            next_seq: after,
                            latest_seq: 501,
                            floor_seq: 500,
                            resync_required: false,
                            events: vec![],
                            exited: false,
                            exit_code: None,
                        })
                    }
                }),
            )
            .route(
                "/input",
                post(move |Json(inp): Json<TerminalInput>| {
                    let store = host_inputs.clone();
                    async move {
                        let decoded = STANDARD.decode(inp.data_b64).unwrap();
                        store
                            .lock()
                            .unwrap()
                            .push(String::from_utf8(decoded).unwrap());
                        Json(true)
                    }
                }),
            );

        let host_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host_addr = host_listener.local_addr().unwrap();
        let host_server = tokio::spawn(async move {
            let _ = axum::serve(host_listener, legacy_host_router).await;
        });

        std::fs::write(
            session_dir.join("host.json"),
            json!({
                "base_url": format!("http://{host_addr}/"),
                "token": token,
            })
            .to_string(),
        )
        .unwrap();
        let host = super::super::host::Host::attach(session_dir).await.unwrap();

        let proxy_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_router = Router::new()
            .route(
                "/stream",
                get(
                    |State(h): State<super::super::host::Host>, ws: WebSocketUpgrade| async move {
                        ws.on_upgrade(move |socket| async move {
                            let (tx, mut rx) = socket.split();
                            let Some(Ok(Message::Binary(first))) = rx.next().await else {
                                return;
                            };
                            let _ = serve_hosted_fallback(tx, rx, h, first).await;
                        })
                    },
                ),
            )
            .with_state(host);
        let proxy_server = tokio::spawn(async move {
            let _ = axum::serve(proxy_listener, proxy_router).await;
        });

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{proxy_addr}/stream"))
            .await
            .unwrap();
        let attach = stream::encode(&Frame {
            kind: Kind::Attach,
            sequence: 0,
            payload: serde_json::to_vec(&json!({"wantControl": true})).unwrap(),
        })
        .unwrap();
        ws.send(WsMessage::Binary(attach.into())).await.unwrap();

        let mut output_bytes = Vec::new();
        loop {
            let bytes = match ws.next().await.unwrap().unwrap() {
                WsMessage::Binary(b) => b,
                WsMessage::Ping(p) => {
                    ws.send(WsMessage::Pong(p)).await.unwrap();
                    continue;
                }
                WsMessage::Pong(_) => continue,
                other => panic!("unexpected frame: {other:?}"),
            };
            let frame = stream::decode(&bytes).unwrap();
            match frame.kind {
                Kind::Snapshot | Kind::Output => {
                    if frame.kind == Kind::Output {
                        output_bytes.extend_from_slice(&frame.payload);
                    }
                    let ack = stream::encode(&Frame {
                        kind: Kind::Applied,
                        sequence: frame.sequence,
                        payload: vec![],
                    })
                    .unwrap();
                    ws.send(WsMessage::Binary(ack.into())).await.unwrap();
                }
                Kind::Ready => break,
                Kind::Error => panic!("unexpected error frame"),
                _ => {}
            }
        }
        assert_eq!(
            String::from_utf8(output_bytes).unwrap(),
            "RECOVERED_PROMPT$ "
        );

        let input_frame = stream::encode(&Frame {
            kind: Kind::Input,
            sequence: 1,
            payload: b"ls\n".to_vec(),
        })
        .unwrap();
        ws.send(WsMessage::Binary(input_frame.into()))
            .await
            .unwrap();
        loop {
            let bytes = match ws.next().await.unwrap().unwrap() {
                WsMessage::Binary(b) => b,
                WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
                other => panic!("unexpected frame: {other:?}"),
            };
            let frame = stream::decode(&bytes).unwrap();
            if frame.kind == Kind::Result {
                let res: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
                assert_eq!(res["ok"], true);
                break;
            }
        }
        assert_eq!(&*received_inputs.lock().unwrap(), &["ls\n".to_owned()]);

        let _ = ws.close(None).await;
        proxy_server.abort();
        host_server.abort();
    }
}
