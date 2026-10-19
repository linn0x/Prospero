use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, watch};
use tokio::time::sleep;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct FakeHostIdentity {
    pub host_id: String,
    pub host_epoch: String,
    pub task_id: String,
    pub attempt_id: String,
    pub execution_epoch: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandDisposition {
    Accepted,
    Replayed,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CommandReceipt {
    pub operation_id: String,
    pub command_id: String,
    pub fingerprint: String,
    pub accepted_sequence: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct AcceptedCommand {
    pub receipt: CommandReceipt,
    pub disposition: CommandDisposition,
    pub response_lost: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct FakeFaultProfile {
    pub start_delay_ms: u64,
    pub rate_limit_delay_ms: u64,
    pub disconnect_after_accept: bool,
    pub ignore_cancellation: bool,
    pub spawn_child_process: bool,
    pub output_pressure_bytes: usize,
    pub wait_for_approval: bool,
    pub unknown_external_effect: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FakeExecutionOutcome {
    Completed,
    Cancelled,
    ExitConfirmed,
    ManualRequired,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct FakeHostEvent {
    pub identity: FakeHostIdentity,
    pub sequence: u64,
    pub kind: String,
    pub body: Value,
}

#[derive(Debug, thiserror::Error)]
pub enum FakeExecutorError {
    #[error("command fingerprint conflict")]
    CommandConflict,
    #[error("operation id conflict")]
    OperationConflict,
    #[error("fake host log is malformed: {0}")]
    MalformedLog(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("fake child process could not be started: {0}")]
    ChildProcess(String),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "record_type", rename_all = "snake_case")]
enum LogRecord {
    Command { receipt: CommandReceipt },
    Event { event: FakeHostEvent },
}

pub struct FakeExecutor {
    identity: FakeHostIdentity,
    log_path: PathBuf,
    commands: HashMap<String, CommandReceipt>,
    operations: HashMap<String, String>,
    event_sequence: u64,
    command_count: usize,
    event_count: usize,
}

impl FakeExecutor {
    pub fn open(directory: &Path, identity: FakeHostIdentity) -> Result<Self, FakeExecutorError> {
        fs::create_dir_all(directory)?;
        let log_path = directory.join("fake-host.jsonl");
        if !log_path.exists() {
            File::create(&log_path)?.sync_all()?;
        }
        let mut executor = Self {
            identity,
            log_path,
            commands: HashMap::new(),
            operations: HashMap::new(),
            event_sequence: 0,
            command_count: 0,
            event_count: 0,
        };
        executor.replay()?;
        Ok(executor)
    }

    pub fn accept(
        &mut self,
        operation_id: &str,
        command_id: &str,
        payload: Value,
    ) -> Result<AcceptedCommand, FakeExecutorError> {
        self.accept_with_profile(
            operation_id,
            command_id,
            payload,
            &FakeFaultProfile::default(),
        )
    }

    pub fn accept_with_profile(
        &mut self,
        operation_id: &str,
        command_id: &str,
        payload: Value,
        profile: &FakeFaultProfile,
    ) -> Result<AcceptedCommand, FakeExecutorError> {
        let fingerprint = fingerprint(&payload)?;
        if let Some(existing) = self.commands.get(command_id) {
            if existing.fingerprint != fingerprint {
                return Err(FakeExecutorError::CommandConflict);
            }
            if existing.operation_id != operation_id {
                return Err(FakeExecutorError::OperationConflict);
            }
            return Ok(AcceptedCommand {
                receipt: existing.clone(),
                disposition: CommandDisposition::Replayed,
                response_lost: false,
            });
        }
        if self.operations.contains_key(operation_id) {
            return Err(FakeExecutorError::OperationConflict);
        }
        let mut file = OpenOptions::new().append(true).open(&self.log_path)?;
        let receipt = CommandReceipt {
            operation_id: operation_id.to_owned(),
            command_id: command_id.to_owned(),
            fingerprint,
            accepted_sequence: self.command_count as u64 + 1,
        };
        append_record(
            &mut file,
            &LogRecord::Command {
                receipt: receipt.clone(),
            },
        )?;
        self.operations
            .insert(operation_id.to_owned(), command_id.to_owned());
        self.commands.insert(command_id.to_owned(), receipt.clone());
        self.command_count += 1;
        Ok(AcceptedCommand {
            receipt,
            disposition: CommandDisposition::Accepted,
            response_lost: profile.disconnect_after_accept,
        })
    }

    pub async fn run_profile(
        &mut self,
        profile: &FakeFaultProfile,
        mut cancellation: watch::Receiver<bool>,
        mut force_stop: oneshot::Receiver<()>,
        mut approval: oneshot::Receiver<()>,
    ) -> Result<FakeExecutionOutcome, FakeExecutorError> {
        self.append_event("starting", json!({}))?;
        if profile.rate_limit_delay_ms > 0 {
            self.append_event(
                "waiting_rate_limit",
                json!({"retryAfterMs": profile.rate_limit_delay_ms}),
            )?;
            sleep(Duration::from_millis(profile.rate_limit_delay_ms)).await;
        }
        if profile.start_delay_ms > 0 {
            sleep(Duration::from_millis(profile.start_delay_ms)).await;
        }
        let mut child = if profile.spawn_child_process {
            let child = spawn_test_child()?;
            self.append_event("child_process_started", json!({"pid": child.id()}))?;
            Some(child)
        } else {
            None
        };
        if profile.output_pressure_bytes > 64 * 1024 * 1024 {
            return Err(FakeExecutorError::MalformedLog(
                "output pressure is capped at 64 MiB per run".into(),
            ));
        }
        if profile.output_pressure_bytes > 0 {
            self.write_output_pressure(profile.output_pressure_bytes)?;
            self.append_event(
                "output_pressure",
                json!({"bytes": profile.output_pressure_bytes}),
            )?;
        }
        if profile.wait_for_approval {
            self.append_event("waiting_input", json!({"requestId": "fake-request-1"}))?;
            let _ = (&mut approval).await;
            self.append_event("approval_resolved", json!({"requestId": "fake-request-1"}))?;
        }
        if profile.unknown_external_effect {
            self.append_event("external_effect_unknown", json!({"effectState": "unknown"}))?;
            self.append_event(
                "manual_required",
                json!({"reason": "external_effect_unknown"}),
            )?;
            stop_test_child(&mut child).await?;
            return Ok(FakeExecutionOutcome::ManualRequired);
        }
        self.append_event("running", json!({}))?;
        if *cancellation.borrow() {
            if profile.ignore_cancellation {
                self.append_event("cancellation_ignored", json!({}))?;
                let _ = (&mut force_stop).await;
                stop_test_child(&mut child).await?;
                self.append_event("exit_confirmed", json!({"forced": true}))?;
                return Ok(FakeExecutionOutcome::ExitConfirmed);
            }
            self.append_event("cancelled", json!({}))?;
            stop_test_child(&mut child).await?;
            return Ok(FakeExecutionOutcome::Cancelled);
        }
        if profile.ignore_cancellation {
            tokio::select! {
                changed = cancellation.changed() => {
                    let _ = changed;
                    if *cancellation.borrow() {
                        self.append_event("cancellation_ignored", json!({}))?;
                        let _ = (&mut force_stop).await;
                        stop_test_child(&mut child).await?;
                        self.append_event("exit_confirmed", json!({"forced": true}))?;
                        return Ok(FakeExecutionOutcome::ExitConfirmed);
                    }
                }
                _ = sleep(Duration::from_millis(profile.start_delay_ms.max(1))) => {}
            }
        }
        stop_test_child(&mut child).await?;
        self.append_event("exit_confirmed", json!({"forced": false}))?;
        Ok(FakeExecutionOutcome::Completed)
    }

    pub fn append_event(
        &mut self,
        kind: &str,
        body: Value,
    ) -> Result<FakeHostEvent, FakeExecutorError> {
        let event = FakeHostEvent {
            identity: self.identity.clone(),
            sequence: self.event_sequence + 1,
            kind: kind.to_owned(),
            body,
        };
        let mut file = OpenOptions::new().append(true).open(&self.log_path)?;
        append_record(
            &mut file,
            &LogRecord::Event {
                event: event.clone(),
            },
        )?;
        self.event_sequence = event.sequence;
        self.event_count += 1;
        Ok(event)
    }

    pub fn command_count(&self) -> usize {
        self.command_count
    }

    pub fn event_count(&self) -> usize {
        self.event_count
    }

    fn write_output_pressure(&self, byte_count: usize) -> Result<(), FakeExecutorError> {
        let output_path = self.log_path.with_file_name("fake-output.bin");
        let mut output = OpenOptions::new()
            .create(true)
            .append(true)
            .open(output_path)?;
        let chunk = [b'x'; 4096];
        let mut remaining = byte_count;
        while remaining > 0 {
            let next = remaining.min(chunk.len());
            output.write_all(&chunk[..next])?;
            remaining -= next;
        }
        output.sync_all()?;
        Ok(())
    }

    fn replay(&mut self) -> Result<(), FakeExecutorError> {
        let file = File::open(&self.log_path)?;
        for (line_index, line) in BufReader::new(file).lines().enumerate() {
            let line = line?;
            let record: LogRecord = serde_json::from_str(&line).map_err(|error| {
                FakeExecutorError::MalformedLog(format!("line {}: {error}", line_index + 1))
            })?;
            match record {
                LogRecord::Command { receipt } => {
                    if self.commands.contains_key(&receipt.command_id)
                        || self.operations.contains_key(&receipt.operation_id)
                    {
                        return Err(FakeExecutorError::MalformedLog(format!(
                            "duplicate command record at line {}",
                            line_index + 1
                        )));
                    }
                    self.operations
                        .insert(receipt.operation_id.clone(), receipt.command_id.clone());
                    self.commands.insert(receipt.command_id.clone(), receipt);
                    self.command_count += 1;
                }
                LogRecord::Event { event } => {
                    if event.identity.host_id != self.identity.host_id
                        || event.identity.host_epoch != self.identity.host_epoch
                    {
                        return Err(FakeExecutorError::MalformedLog(format!(
                            "event host identity mismatch at line {}",
                            line_index + 1
                        )));
                    }
                    if event.sequence != self.event_sequence + 1 {
                        return Err(FakeExecutorError::MalformedLog(format!(
                            "event sequence gap at line {}",
                            line_index + 1
                        )));
                    }
                    self.event_sequence = event.sequence;
                    self.event_count += 1;
                }
            }
        }
        Ok(())
    }
}

fn append_record(file: &mut File, record: &LogRecord) -> Result<(), FakeExecutorError> {
    serde_json::to_writer(&mut *file, record)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn fingerprint(value: &Value) -> Result<String, FakeExecutorError> {
    let canonical = serde_json::to_vec(value)?;
    let digest = Sha256::digest(canonical);
    Ok(format!("sha256:{}", hex(&digest)))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[(byte >> 4) as usize]));
        output.push(char::from(DIGITS[(byte & 0x0f) as usize]));
    }
    output
}

#[cfg(unix)]
fn spawn_test_child() -> Result<Child, FakeExecutorError> {
    Command::new("sleep")
        .arg("600")
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| FakeExecutorError::ChildProcess(error.to_string()))
}

#[cfg(windows)]
fn spawn_test_child() -> Result<Child, FakeExecutorError> {
    Command::new("cmd")
        .args(["/C", "ping", "-t", "127.0.0.1"])
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| FakeExecutorError::ChildProcess(error.to_string()))
}

#[cfg(not(any(unix, windows)))]
fn spawn_test_child() -> Result<Child, FakeExecutorError> {
    Err(FakeExecutorError::ChildProcess(
        "platform process fixture is unsupported".into(),
    ))
}

async fn stop_test_child(child: &mut Option<Child>) -> Result<(), FakeExecutorError> {
    if let Some(mut process) = child.take()
        && process.id().is_some()
    {
        process.start_kill()?;
        let _ = process.wait().await?;
    }
    Ok(())
}
