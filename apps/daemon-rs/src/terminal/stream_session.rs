//! One streaming state machine for local and detached-owner PTYs.
use super::stream::{self, Frame, Kind};
use super::{Terminal, TerminalEvent, TerminalInput, TerminalQuery, TerminalSize, validate_size};
use crate::error::{Error, Result};
use axum::extract::ws::{Message, WebSocket};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use serde::Deserialize;
use serde_json::json;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

type Sink = SplitSink<WebSocket, Message>;
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

struct Lease {
    terminal: Terminal,
    client: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = self.terminal.release_controller(&self.client);
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
    let (mut sink, mut source) = socket.split();
    let _permit = match terminal.stream_permit() {
        Ok(permit) => permit,
        Err(error) => {
            send_error(&mut sink, "busy", "Too many terminal viewers").await?;
            return Err(error);
        }
    };
    let result = async {
        let first = tokio::time::timeout(IO_TIMEOUT, source.next()).await.map_err(|_| Error::Timeout)?
            .ok_or(Error::Closed)?.map_err(|_| Error::Closed)?;
        let Message::Binary(bytes) = first else { return Err(Error::Invalid("binary Attach required".into())); };
        let frame = stream::decode(&bytes)?;
        if frame.kind != Kind::Attach || frame.sequence != 0 || frame.payload.len() > 4096 {
            return Err(Error::Invalid("Attach required as first frame".into()));
        }
        let attach: Attach = serde_json::from_slice(&frame.payload)?;
        if attach.after_seq.is_some() && attach.epoch.is_none() {
            return Err(Error::Invalid("resume requires an epoch".into()));
        }
        if attach.epoch.as_deref().is_some_and(|seen| seen != terminal.epoch()) {
            send_error(&mut sink, "epoch_mismatch", "The terminal process changed; start a fresh attachment").await?;
            return Ok(());
        }
        let client = uuid::Uuid::new_v4().to_string();
        let _lease = Lease { terminal: terminal.clone(), client: client.clone() };
        let mut lease_changes = terminal.controller_changes();
        let mut cursor = attach.after_seq.unwrap_or(0);
        let initial = terminal.read(TerminalQuery { after_seq: Some(cursor as i64), wait_ms: Some(0) }).await?;
        let snapshot = if attach.after_seq.is_none() {
            let term = terminal.clone();
            tokio::task::spawn_blocking(move || term.snapshot()).await.map_err(|_| Error::Closed)??
        } else { None };
        if (initial.resync_required && snapshot.is_none()) || cursor > initial.latest_seq as u64 {
            send_error(&mut sink, "history_gap", "The retained output cannot reconstruct this terminal").await?;
            return Ok(());
        }
        let size = snapshot.as_ref().map(|s| s.size).unwrap_or(initial.initial_size);
        let barrier = snapshot.as_ref().map(|s| s.seq as u64).unwrap_or(initial.latest_seq as u64);
        let mut exited = initial.exited;
        if attach.want_control && !exited { let _ = terminal.acquire_controller(&client, false)?; }
        let owner = terminal.controller()?;
        send_json(&mut sink, Kind::Hello, 0, json!({"version":1,"epoch":terminal.epoch(),"clientId":client,
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
            // Pull one bounded page from the owner, never through HTTP. Credit
            // remains in force during bootstrap replay as well as live output.
            if !output_blocked && !exit_sent {
                let page = terminal.read(TerminalQuery { after_seq: Some(cursor as i64), wait_ms: Some(0) }).await?;
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
                    let _ = terminal.release_controller(&client);
                    send_json(&mut sink, Kind::Exit, cursor, json!({"exitCode":page.exit_code})).await?;
                    exit_sent = true;
                }
            }
            let owner = terminal.controller()?;
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
                            if !ready || exited || terminal.controller()?.as_deref()!=Some(&client) {
                                send_result(&mut sink, frame.sequence, Err(Error::Conflict)).await?; continue;
                            }
                            if command.0.is_some() { send_result(&mut sink, frame.sequence, Err(Error::Busy)).await?; continue; }
                            let term = terminal.clone(); let client = client.clone(); let sequence = frame.sequence;
                            let task = if frame.kind == Kind::Input {
                                if frame.payload.is_empty() || frame.payload.len() > super::INPUT_BYTES { return Err(Error::Invalid("invalid input size".into())); }
                                let input = TerminalInput { data_b64: STANDARD.encode(frame.payload) };
                                tokio::spawn(async move { term.input_as(&client, input).await })
                            } else {
                                if frame.payload.len()!=4 { return Err(Error::Invalid("invalid resize size".into())); }
                                let size = validate_size(TerminalSize { cols:u16::from_be_bytes([frame.payload[0],frame.payload[1]]), rows:u16::from_be_bytes([frame.payload[2],frame.payload[3]]) })?;
                                tokio::spawn(async move { term.resize_as(&client, size).await })
                            };
                            command.0 = Some((sequence, task));
                        }
                        Kind::Acquire => {
                            if frame.payload.len()>4096 { return Err(Error::Invalid("Acquire too large".into())); }
                            let request: Acquire = serde_json::from_slice(&frame.payload)?;
                            let acquired = !exited && terminal.acquire_controller(&client, request.takeover)?;
                            send_result(&mut sink, frame.sequence, if acquired {Ok(())} else {Err(Error::Conflict)}).await?;
                        }
                        Kind::Release => {
                            if !frame.payload.is_empty() { return Err(Error::Invalid("Release must be empty".into())); }
                            let released = terminal.release_controller(&client)?;
                            send_result(&mut sink, frame.sequence, if released {Ok(())} else {Err(Error::Conflict)}).await?;
                        }
                        _ => return Err(Error::Invalid("unexpected client terminal frame".into())),
                    }
                }
                completed = async { (&mut command.0.as_mut().expect("guarded command").1).await }, if command.0.is_some() => {
                    let sequence = command.0.take().expect("completed command").0;
                    send_result(&mut sink, sequence, completed.map_err(|_| Error::Closed)?).await?;
                }
                _ = terminal.wait_output(cursor as i64), if !output_blocked && !exit_sent => {}
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
            _ => "protocol_error",
        };
        let message = if let Error::Invalid(reason) = error {
            reason.as_str()
        } else {
            "Terminal stream ended; unacknowledged input was not replayed"
        };
        let _ = send_error(&mut sink, code, message).await;
    }
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
}
