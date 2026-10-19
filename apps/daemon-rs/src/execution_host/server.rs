use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader},
    net::{UnixListener, UnixStream},
    sync::{Mutex, Semaphore},
    time::timeout,
};

use crate::{
    agent::{Agents, CreateAgentSession},
    database::now,
    orchestration::reliability::{
        CommandReceipt, ControlEffectState, ExecutionIdentity, ExitProofKind, ExitProofVerifier,
        HostCommand, HostCommandKind, HostCommandState, HostIdentity, InteractionReply,
        VerifiedExitProof, host_command_fingerprint,
    },
    protocol::{AttachmentInput, TimelineQuery},
    worker::Database,
};

use super::{
    HOST_PROTOCOL_VERSION, HostConfig, HostEvent, HostEventPage, HostRequest, HostResponse,
};

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_EVENT_PAGE: usize = 1000;
const MAX_JOURNAL_BYTES: u64 = 512 * 1024 * 1024;
const CONTROL_JOURNAL_RESERVE: u64 = 8 * 1024 * 1024;
const MAX_JOURNAL_RECORDS: usize = 1_000_000;
const CONTROL_RECORD_RESERVE: usize = 10_000;
const MAX_EVENTS_IN_MEMORY: usize = 100_000;
const MAX_EVENTS_IN_MEMORY_BYTES: usize = 8 * 1024 * 1024;
const MAX_EVENT_PAYLOAD_BYTES: usize = 256 * 1024;
const MAX_EVENT_PAGE_BYTES: usize = 1024 * 1024;
const MAX_CONCURRENT_CLIENTS: usize = 64;
const CLIENT_TIMEOUT_SECONDS: u64 = 5;

#[derive(Clone)]
struct Runtime {
    config: HostConfig,
    token: Arc<Vec<u8>>,
    agents: Agents,
    database: Database,
    journal: Arc<Mutex<Journal>>,
    shutdown: tokio::sync::watch::Sender<bool>,
    closing: Arc<AtomicBool>,
    execution: Arc<Mutex<()>>,
    owned: Arc<Mutex<HashSet<String>>>,
    storage_failed: Arc<AtomicBool>,
    inflight: Arc<AtomicUsize>,
    pump_sequence: Arc<AtomicU64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "recordType", rename_all = "snake_case")]
enum JournalRecord {
    Command {
        command: Box<HostCommand>,
        receipt: CommandReceipt,
    },
    Receipt {
        receipt: CommandReceipt,
    },
    Event {
        event: HostEvent,
    },
}

#[derive(Clone)]
struct JournalCommand {
    command: HostCommand,
    receipt: CommandReceipt,
}

struct Journal {
    path: PathBuf,
    host_id: String,
    host_epoch: String,
    sequence: u64,
    commands: HashMap<String, JournalCommand>,
    operations: HashMap<String, String>,
    events: BTreeMap<u64, HostEvent>,
    active: HashMap<String, ExecutionIdentity>,
    canonical_exit: Option<(ExecutionIdentity, VerifiedExitProof)>,
    bytes: u64,
    record_count: usize,
    event_bytes: usize,
}

#[derive(Debug, thiserror::Error)]
enum HostError {
    #[error("invalid Host configuration: {0}")]
    Config(String),
    #[error("invalid command: {0}")]
    Invalid(String),
    #[error("command conflicts with an earlier command ID")]
    Conflict,
    #[error("managed account and API profile execution are unsupported by this Host")]
    UnsupportedManagedAccount,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Agent(#[from] crate::error::Error),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartPayload {
    session: CreateAgentSession,
    prompt: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagePayload {
    text: String,
    #[serde(default)]
    delivery: Option<String>,
}

pub async fn serve(config: HostConfig) -> std::io::Result<()> {
    validate_config(&config)?;
    prepare_private_directory(&config.data_dir)?;
    let socket_parent = config
        .socket_path
        .parent()
        .ok_or_else(|| std::io::Error::other("socket path has no parent directory"))?;
    prepare_private_directory(socket_parent)?;
    if config.socket_path.as_os_str().len() > 100 {
        return Err(std::io::Error::other(
            "Unix socket path exceeds the portable path limit",
        ));
    }
    let token = read_token(&config.token_file)?;
    let database = Database::open(config.data_dir.join("driver-state").to_path_buf())
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let agents = Agents::new(database.clone());
    let journal_path = journal_path(&config);
    let journal = Journal::open(
        journal_path,
        config.host_id.clone(),
        config.host_epoch.clone(),
    )
    .map_err(|error| std::io::Error::other(error.to_string()))?;
    let (shutdown, mut stopping) = tokio::sync::watch::channel(false);
    let runtime = Runtime {
        config: config.clone(),
        token: Arc::new(token),
        agents,
        database,
        journal: Arc::new(Mutex::new(journal)),
        shutdown,
        closing: Arc::new(AtomicBool::new(false)),
        execution: Arc::new(Mutex::new(())),
        owned: Arc::new(Mutex::new(HashSet::new())),
        storage_failed: Arc::new(AtomicBool::new(false)),
        inflight: Arc::new(AtomicUsize::new(0)),
        pump_sequence: Arc::new(AtomicU64::new(0)),
    };
    runtime
        .journal
        .lock()
        .await
        .mark_restarted_attempts()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let listener = UnixListener::bind(&config.socket_path)?;
    set_private_socket_permissions(&config.socket_path)?;
    let clients = Arc::new(Semaphore::new(MAX_CONCURRENT_CLIENTS));
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            _ = stopping.changed() => break,
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                if let Ok(permit) = clients.clone().try_acquire_owned() {
                    let runtime = runtime.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        let _ = serve_connection(stream, runtime).await;
                    });
                } else {
                    let _ = reject_overloaded(stream).await;
                }
            }
            signal = tokio::signal::ctrl_c() => {
                signal?;
                break;
            }
            _ = terminate.recv() => break,
        }
    }
    let _execution = runtime.execution.lock().await;
    runtime
        .agents
        .shutdown()
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let _ = fs::remove_file(&config.socket_path);
    Ok(())
}

pub async fn request(socket_path: &Path, request: HostRequest) -> std::io::Result<HostResponse> {
    let mut stream = UnixStream::connect(socket_path).await?;
    let bytes =
        serde_json::to_vec(&request).map_err(|error| std::io::Error::other(error.to_string()))?;
    stream.write_all(&bytes).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    let mut reader = AsyncBufReader::new(stream);
    let response = timeout(
        std::time::Duration::from_secs(CLIENT_TIMEOUT_SECONDS),
        read_bounded_line(&mut reader, MAX_REQUEST_BYTES * 2),
    )
    .await
    .map_err(|_| std::io::Error::other("execution Host response timed out"))??;
    serde_json::from_slice(&response).map_err(|error| std::io::Error::other(error.to_string()))
}

async fn serve_connection(stream: UnixStream, runtime: Runtime) -> std::io::Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = AsyncBufReader::new(reader);
    let read_result = timeout(
        std::time::Duration::from_secs(CLIENT_TIMEOUT_SECONDS),
        read_bounded_line(&mut reader, MAX_REQUEST_BYTES),
    )
    .await;
    let bytes = match read_result {
        Ok(Ok(request_bytes)) => request_bytes,
        Ok(Err(error)) => return Err(error),
        Err(_) => {
            return write_response(
                &mut writer,
                HostResponse::Error {
                    code: "REQUEST_TIMEOUT".into(),
                    message: "request read timed out".into(),
                },
            )
            .await;
        }
    };
    let request = match serde_json::from_slice::<HostRequest>(&bytes) {
        Ok(request) => request,
        Err(error) => {
            return write_response(
                &mut writer,
                HostResponse::Error {
                    code: "INVALID_REQUEST".into(),
                    message: error.to_string(),
                },
            )
            .await;
        }
    };
    let token = match &request {
        HostRequest::Command { token, .. }
        | HostRequest::Events { token, .. }
        | HostRequest::InteractionReply { token, .. }
        | HostRequest::CommandQuery { token, .. }
        | HostRequest::Shutdown { token, .. }
        | HostRequest::Health { token } => token,
    };
    if !valid_token(&runtime.token, token.as_bytes()) {
        return write_response(
            &mut writer,
            HostResponse::Error {
                code: "UNAUTHORIZED".into(),
                message: "invalid Host capability".into(),
            },
        )
        .await;
    }
    let mut shutdown_requested = false;
    let response = match request {
        HostRequest::Shutdown {
            acknowledged_sequence,
            ..
        } => {
            let journal = runtime.journal.lock().await;
            if acknowledged_sequence.is_some_and(|sequence| {
                sequence != journal.sequence || runtime.inflight.load(Ordering::Acquire) != 0
            }) {
                HostResponse::Error {
                    code: "COMMAND_CONFLICT".into(),
                    message: "Host has unacknowledged events or commands in flight".into(),
                }
            } else {
                runtime.closing.store(true, Ordering::Release);
                shutdown_requested = true;
                HostResponse::Shutdown {
                    accepted: true,
                    identity: HostIdentity {
                        host_id: runtime.config.host_id.clone(),
                        host_epoch: runtime.config.host_epoch.clone(),
                    },
                }
            }
        }
        HostRequest::CommandQuery { command_id, .. } => {
            match runtime.command_detail(&command_id).await {
                Some(detail) => HostResponse::CommandDetail {
                    detail: Box::new(detail),
                },
                None => HostResponse::Error {
                    code: "NOT_FOUND".into(),
                    message: "command not found".into(),
                },
            }
        }
        HostRequest::Command { command, .. } => match runtime.accept(command).await {
            Ok(receipt) => HostResponse::Command { receipt },
            Err(error) => HostResponse::Error {
                code: error_code(&error).into(),
                message: error.to_string(),
            },
        },
        HostRequest::Events {
            after_sequence,
            limit,
            ..
        } => {
            let page = runtime
                .journal
                .lock()
                .await
                .page(after_sequence, limit.min(MAX_EVENT_PAGE));
            HostResponse::Events { page }
        }
        HostRequest::Health { .. } => {
            let journal = runtime.journal.lock().await;
            HostResponse::Health {
                ready: !runtime.storage_failed.load(Ordering::Acquire),
                protocol_version: HOST_PROTOCOL_VERSION,
                identity: HostIdentity {
                    host_id: runtime.config.host_id.clone(),
                    host_epoch: runtime.config.host_epoch.clone(),
                },
                capabilities: vec![
                    "unix_private_ipc".into(),
                    "durable_command_journal".into(),
                    "ordered_event_replay".into(),
                    "native_agent_accounts".into(),
                ],
                unresolved_attempts: journal.active.len(),
            }
        }
        HostRequest::InteractionReply { reply, .. } => {
            match runtime.accept_interaction_reply(reply).await {
                Ok(receipt) => HostResponse::Command { receipt },
                Err(error) => HostResponse::Error {
                    code: error_code(&error).into(),
                    message: error.to_string(),
                },
            }
        }
    };
    let result = write_response(&mut writer, response).await;
    if shutdown_requested {
        runtime.shutdown.send_replace(true);
    }
    result
}

impl Runtime {
    async fn accept(&self, command: HostCommand) -> Result<CommandReceipt, HostError> {
        validate_command(&self.config, &command)?;
        if self.closing.load(Ordering::Acquire) {
            return Err(HostError::Invalid("Host is shutting down".into()));
        }
        let (accepted, is_new) = {
            let mut journal = self.journal.lock().await;
            if self.closing.load(Ordering::Acquire) {
                return Err(HostError::Invalid("Host is shutting down".into()));
            }
            let (receipt, is_new) = journal.accept(command.clone())?;
            if is_new {
                self.inflight.fetch_add(1, Ordering::AcqRel);
            }
            (receipt, is_new)
        };
        if is_new {
            let runtime = self.clone();
            let command = command.clone();
            tokio::spawn(async move {
                let _ = runtime.execute(command).await;
                runtime.inflight.fetch_sub(1, Ordering::AcqRel);
            });
        }
        Ok(accepted)
    }

    async fn command_detail(&self, command_id: &str) -> Option<super::HostCommandDetail> {
        let initial = self
            .journal
            .lock()
            .await
            .commands
            .get(command_id)
            .cloned()?;
        let proven = self
            .journal
            .lock()
            .await
            .canonical_exit_proof(&initial.command.identity)
            .is_some();
        let owned = self
            .owned
            .lock()
            .await
            .contains(&initial.command.identity.attempt_id);
        if initial.command.kind == HostCommandKind::Stop
            && initial.receipt.state == HostCommandState::Unknown
            && (owned || proven)
            && let Ok(_execution) = self.execution.try_lock()
        {
            let command = {
                let journal = self.journal.lock().await;
                let current = journal.commands.get(command_id)?;
                let original_owner = journal.commands.values().any(|record| {
                    record.command.kind == HostCommandKind::Start
                        && record.command.identity == current.command.identity
                });
                if current.receipt.state == HostCommandState::Unknown
                    && current.command.identity == initial.command.identity
                    && (journal
                        .canonical_exit_proof(&current.command.identity)
                        .is_some()
                        || (owned && original_owner))
                    && validate_identity(&self.config, &current.command.identity).is_ok()
                    && !self.closing.load(Ordering::Acquire)
                {
                    self.inflight.fetch_add(1, Ordering::AcqRel);
                    Some(current.command.clone())
                } else {
                    None
                }
            };
            if let Some(command) = command {
                let _ = self.execute_locked(command).await;
                self.inflight.fetch_sub(1, Ordering::AcqRel);
            }
        }
        self.journal
            .lock()
            .await
            .commands
            .get(command_id)
            .map(|record| super::HostCommandDetail {
                command: record.command.clone(),
                receipt: record.receipt.clone(),
            })
    }

    async fn accept_interaction_reply(
        &self,
        reply: InteractionReply,
    ) -> Result<CommandReceipt, HostError> {
        validate_identity(&self.config, &reply.identity)?;
        let mut command = HostCommand {
            command_id: reply.command_id.clone(),
            operation_id: reply.operation_id.clone(),
            identity: reply.identity.clone(),
            kind: HostCommandKind::InteractionReply,
            fingerprint: String::new(),
            payload: serde_json::to_string(&reply)?,
        };
        command.fingerprint = host_command_fingerprint(&command)?;
        self.accept(command).await
    }

    async fn execute(&self, command: HostCommand) -> Result<(), HostError> {
        let _execution = self.execution.lock().await;
        self.execute_locked(command).await
    }

    async fn execute_locked(&self, command: HostCommand) -> Result<(), HostError> {
        let identity = command.identity.clone();
        let outcome = match command.kind {
            HostCommandKind::Start => self.start(&command).await,
            HostCommandKind::Stop => self.stop(&command).await,
            HostCommandKind::Send => self.send(&command).await,
            HostCommandKind::Result => self.receive_result(&command).await,
            HostCommandKind::InteractionReply => self.reply_interaction(&command).await,
            HostCommandKind::Snapshot | HostCommandKind::Reconcile => {
                self.snapshot(identity.clone()).await.map(|_| {
                    (
                        HostCommandState::Completed,
                        ControlEffectState::Received,
                        Some("snapshot recorded".into()),
                    )
                })
            }
        };
        match outcome {
            Ok((state, effect, receipt)) => {
                self.journal.lock().await.update_receipt(
                    &command.command_id,
                    state,
                    effect,
                    receipt,
                )?;
                Ok(())
            }
            Err(error) => {
                if self.storage_failed.load(Ordering::Acquire) {
                    let _ = self.agents.close(&identity.attempt_id).await;
                }
                self.journal.lock().await.update_receipt(
                    &command.command_id,
                    HostCommandState::Unknown,
                    ControlEffectState::Unknown,
                    Some(json!({"error": error.to_string()}).to_string()),
                )?;
                self.record_event(
                    &identity,
                    "command_outcome_unknown",
                    json!({"commandId": command.command_id, "kind": command.kind}),
                )
                .await?;
                Err(error)
            }
        }
    }

    async fn start(
        &self,
        command: &HostCommand,
    ) -> Result<(HostCommandState, ControlEffectState, Option<String>), HostError> {
        if self
            .journal
            .lock()
            .await
            .commands
            .values()
            .any(|record| record.command.kind == HostCommandKind::Stop)
        {
            return Err(HostError::Invalid(
                "attempt was fenced by an accepted stop command".into(),
            ));
        }
        let payload: StartPayload = serde_json::from_str(&command.payload)?;
        if payload.session.account_id.is_some()
            || matches!(payload.session.agent, crate::protocol::AgentKind::Opencode)
        {
            return Err(HostError::UnsupportedManagedAccount);
        }
        if payload.session.resume.is_some() {
            return Err(HostError::Invalid(
                "resuming provider sessions is not supported by this Host adapter".into(),
            ));
        }
        self.agents
            .set_execution_environment(
                &command.identity.attempt_id,
                vec![
                    (
                        "PROSPERO_EXECUTION_HOST_SOCKET".into(),
                        self.config.socket_path.to_string_lossy().into_owned(),
                    ),
                    (
                        "PROSPERO_EXECUTION_HOST_TOKEN_PATH".into(),
                        self.config.token_file.to_string_lossy().into_owned(),
                    ),
                    (
                        "PROSPERO_EXECUTION_IDENTITY_JSON".into(),
                        serde_json::to_string(&command.identity)?,
                    ),
                ],
            )
            .await?;
        self.agents
            .create_with_id(payload.session, command.identity.attempt_id.clone())
            .await?;
        self.owned
            .lock()
            .await
            .insert(command.identity.attempt_id.clone());
        self.agents
            .send(
                &command.identity.attempt_id,
                payload.prompt,
                None,
                Vec::<AttachmentInput>::new(),
            )
            .await?;
        self.record_event(
            &command.identity,
            "driver_started",
            json!({"sessionId": command.identity.attempt_id}),
        )
        .await?;
        self.start_event_pump(command.identity.clone()).await;
        Ok((
            HostCommandState::Completed,
            ControlEffectState::Delivered,
            Some("driver session accepted".into()),
        ))
    }

    async fn stop(
        &self,
        command: &HostCommand,
    ) -> Result<(HostCommandState, ControlEffectState, Option<String>), HostError> {
        let proof_id = format!("proof-{}", payload_digest(command.command_id.as_bytes()));
        let previous_proof = self
            .journal
            .lock()
            .await
            .canonical_exit_proof(&command.identity);
        if let Some(proof) = previous_proof {
            return Ok((
                HostCommandState::Completed,
                ControlEffectState::Delivered,
                Some(serde_json::to_string(&proof)?),
            ));
        }
        self.record_event(
            &command.identity,
            "stop_requested",
            json!({"commandId": command.command_id, "stopGeneration": stop_generation(command)?}),
        )
        .await?;
        let owned = self
            .owned
            .lock()
            .await
            .contains(&command.identity.attempt_id);
        let has_start = self
            .journal
            .lock()
            .await
            .commands
            .values()
            .any(|record| record.command.kind == HostCommandKind::Start);
        if owned {
            self.agents.close(&command.identity.attempt_id).await?;
        } else if has_start {
            return Err(HostError::Invalid(
                "Host cannot verify a driver owned by a prior process".into(),
            ));
        }
        if owned {
            let scope = format!("timeline:{}", command.identity.attempt_id);
            let target = self
                .database
                .call(move |store| Ok(store.events(&scope, 0, 1)?.latest_seq))
                .await? as u64;
            timeout(std::time::Duration::from_secs(5), async {
                while self.pump_sequence.load(Ordering::Acquire) < target {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .map_err(|_| HostError::Invalid("driver event journal has not drained".into()))?;
        }
        let proof = VerifiedExitProof {
            proof_id,
            attempt_id: command.identity.attempt_id.clone(),
            execution_epoch: command.identity.execution_epoch,
            host: command.identity.host.clone(),
            config_digest: command.identity.config_digest.clone(),
            kind: ExitProofKind::DriverQuiescence,
            verifier: ExitProofVerifier::Driver,
            evidence_digest: payload_digest(
                serde_json::to_string(&json!({
                    "identity": command.identity,
                    "commandId": command.command_id,
                    "ownedDriverReapedAndOutputDrained": owned,
                "emptyScopeFencedBeforeStart": !has_start,
                }))?
                .as_bytes(),
            ),
            verified_at: now(),
        };
        self.record_event(&command.identity, "exit_confirmed", json!({"proof": proof}))
            .await?;
        Ok((
            HostCommandState::Completed,
            ControlEffectState::Delivered,
            Some(serde_json::to_string(&proof)?),
        ))
    }

    async fn send(
        &self,
        command: &HostCommand,
    ) -> Result<(HostCommandState, ControlEffectState, Option<String>), HostError> {
        if self
            .journal
            .lock()
            .await
            .commands
            .values()
            .any(|record| record.command.kind == HostCommandKind::Stop)
        {
            return Ok((
                HostCommandState::Rejected,
                ControlEffectState::Failed,
                Some("message fenced by an accepted stop command".into()),
            ));
        }
        let payload: MessagePayload = serde_json::from_str(&command.payload)?;
        self.agents
            .send(
                &command.identity.attempt_id,
                payload.text,
                payload.delivery,
                Vec::new(),
            )
            .await?;
        self.record_event(
            &command.identity,
            "message_received",
            json!({"operationId": command.operation_id}),
        )
        .await?;
        Ok((
            HostCommandState::Received,
            ControlEffectState::Received,
            Some("message accepted by Host runtime; provider processing is unconfirmed".into()),
        ))
    }

    async fn receive_result(
        &self,
        command: &HostCommand,
    ) -> Result<(HostCommandState, ControlEffectState, Option<String>), HostError> {
        self.record_event(
            &command.identity,
            "delivery_received_offline",
            json!({
                "operationId": command.operation_id,
                "commandId": command.command_id,
                "payloadBytes": command.payload.len(),
                "payloadSha256": payload_digest(command.payload.as_bytes()),
            }),
        )
        .await?;
        Ok((
            HostCommandState::Received,
            ControlEffectState::Received,
            Some(
                "delivery received by Host; business acceptance is pending daemon validation"
                    .into(),
            ),
        ))
    }

    async fn reply_interaction(
        &self,
        command: &HostCommand,
    ) -> Result<(HostCommandState, ControlEffectState, Option<String>), HostError> {
        let reply: InteractionReply = serde_json::from_str(&command.payload)?;
        if reply.command_id != command.command_id
            || reply.operation_id != command.operation_id
            || serde_json::to_value(&reply.identity)? != serde_json::to_value(&command.identity)?
        {
            return Err(HostError::Invalid(
                "interaction reply identity does not match its command".into(),
            ));
        }
        if let Some(allow) = reply.allow {
            self.agents
                .respond_permission(&reply.identity.attempt_id, &reply.request_id, allow)
                .await?;
        } else if !reply.answers.is_empty() || reply.cancelled {
            self.agents
                .respond_question(
                    &reply.identity.attempt_id,
                    &reply.request_id,
                    reply.answers,
                    reply.cancelled,
                )
                .await?;
        } else {
            return Err(HostError::Invalid(
                "interaction reply contains no decision".into(),
            ));
        }
        self.record_event(
            &reply.identity,
            "interaction_replied",
            json!({"requestId": reply.request_id, "operationId": reply.operation_id}),
        )
        .await?;
        Ok((
            HostCommandState::Completed,
            ControlEffectState::Delivered,
            Some("interaction reply delivered to the original request".into()),
        ))
    }

    async fn snapshot(&self, identity: ExecutionIdentity) -> Result<(), HostError> {
        let session_id = identity.attempt_id.clone();
        let page = self
            .database
            .call(move |store| {
                store.timeline(
                    &session_id,
                    TimelineQuery {
                        before: None,
                        after: Some(0),
                        limit: Some(100),
                    },
                )
            })
            .await?;
        self.record_event(&identity, "execution_snapshot", serde_json::to_value(page)?)
            .await?;
        Ok(())
    }

    async fn start_event_pump(&self, identity: ExecutionIdentity) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let mut sequence = 0;
            let mut revisions = HashMap::<String, i64>::new();
            loop {
                let session_id = identity.attempt_id.clone();
                let page = runtime
                    .database
                    .call(move |store| {
                        let page = store.events(&format!("timeline:{session_id}"), sequence, 40)?;
                        let ids = page
                            .items
                            .iter()
                            .map(|event| event.entity_id.clone())
                            .collect();
                        let records = store.timeline_lookup(&session_id, ids)?.items;
                        Ok((page, records))
                    })
                    .await;
                let Ok((page, records)) = page else { return };
                if page.resync_required {
                    let _ = runtime
                        .record_event(
                            &identity,
                            "driver_event_gap",
                            json!({
                                "afterSequence": sequence, "floorSequence": page.floor_seq,
                            }),
                        )
                        .await;
                    return;
                }
                for item in records {
                    if revisions
                        .get(&item.id)
                        .is_some_and(|revision| *revision >= item.revision)
                    {
                        continue;
                    }
                    if revisions.len() >= MAX_EVENTS_IN_MEMORY && !revisions.contains_key(&item.id)
                    {
                        let _ = runtime
                            .record_event(
                                &identity,
                                "manual_required",
                                json!({"reason": "driver timeline tracking limit reached"}),
                            )
                            .await;
                        return;
                    }
                    let payload = json!({"position": item.position, "revision": item.revision, "body": item.body, "preview": item.preview});
                    if runtime
                        .record_event(&identity, "driver_timeline", payload)
                        .await
                        .is_err()
                    {
                        let _ = runtime.agents.close(&identity.attempt_id).await;
                        return;
                    }
                    revisions.insert(item.id, item.revision);
                }
                sequence = page.next_seq;
                runtime
                    .pump_sequence
                    .store(sequence as u64, Ordering::Release);
                if !runtime
                    .journal
                    .lock()
                    .await
                    .active
                    .contains_key(&identity.attempt_id)
                {
                    return;
                }
                if page.has_more {
                    continue;
                }
                let session_id = identity.attempt_id.clone();
                let is_active = runtime
                    .database
                    .call(move |store| Ok(store.agent_run(&session_id)?.active))
                    .await;
                match is_active {
                    Ok(false) => {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                    Err(_) => return,
                    Ok(true) => {}
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        });
    }

    async fn record_event(
        &self,
        identity: &ExecutionIdentity,
        kind: &str,
        payload: Value,
    ) -> Result<(), HostError> {
        let payload = payload.to_string();
        if payload.len() > MAX_EVENT_PAYLOAD_BYTES {
            return Err(HostError::Invalid(
                "Host event payload exceeded size limit".into(),
            ));
        }
        let mut journal = self.journal.lock().await;
        if self.closing.load(Ordering::Acquire) {
            return Err(HostError::Invalid("Host is shutting down".into()));
        }
        match journal.append_event(identity, kind, payload) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.storage_failed.store(true, Ordering::Release);
                Err(error)
            }
        }
    }
}

impl Journal {
    fn open(path: PathBuf, host_id: String, host_epoch: String) -> Result<Self, HostError> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
        {
            Ok(file) => {
                file.sync_all()?;
                File::open(
                    path.parent()
                        .ok_or_else(|| HostError::Config("journal has no directory".into()))?,
                )?
                .sync_all()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || metadata.nlink() != 1
        {
            return Err(HostError::Config(
                "journal must be a private regular file".into(),
            ));
        }
        let bytes = metadata.len();
        if bytes > MAX_JOURNAL_BYTES {
            return Err(HostError::Config(
                "Host journal exceeded its configured size limit".into(),
            ));
        }
        let mut journal = Self {
            path,
            host_id,
            host_epoch,
            sequence: 0,
            commands: HashMap::new(),
            operations: HashMap::new(),
            events: BTreeMap::new(),
            active: HashMap::new(),
            canonical_exit: None,
            bytes,
            record_count: 0,
            event_bytes: 0,
        };
        journal.replay()?;
        Ok(journal)
    }

    fn accept(&mut self, command: HostCommand) -> Result<(CommandReceipt, bool), HostError> {
        if let Some(existing) = self.commands.get(&command.command_id) {
            if serde_json::to_value(&existing.command)? != serde_json::to_value(&command)? {
                return Err(HostError::Conflict);
            }
            return Ok((existing.receipt.clone(), false));
        }
        if self.operations.contains_key(&command.operation_id) {
            return Err(HostError::Conflict);
        }
        if self
            .commands
            .values()
            .any(|record| record.command.identity != command.identity)
        {
            return Err(HostError::Conflict);
        }
        if command.kind == HostCommandKind::Send
            && self
                .commands
                .values()
                .any(|record| record.command.kind == HostCommandKind::Stop)
        {
            return Err(HostError::Conflict);
        }
        if command.kind == HostCommandKind::Start
            && self.commands.values().any(|existing| {
                matches!(
                    existing.command.kind,
                    HostCommandKind::Start | HostCommandKind::Stop
                )
            })
        {
            return Err(HostError::Conflict);
        }
        if !matches!(command.kind, HostCommandKind::Start | HostCommandKind::Stop) {
            let start = self.commands.values().find(|existing| {
                existing.command.kind == HostCommandKind::Start
                    && existing.command.identity.attempt_id == command.identity.attempt_id
            });
            let Some(start) = start else {
                return Err(HostError::Invalid(
                    "attempt has no accepted start command".into(),
                ));
            };
            if (matches!(
                command.kind,
                HostCommandKind::Send | HostCommandKind::InteractionReply
            ) && start.receipt.state != HostCommandState::Completed)
                || start.command.identity != command.identity
            {
                return Err(HostError::Conflict);
            }
        }
        if command.kind == HostCommandKind::Stop {
            let incoming = stop_generation(&command)?;
            let previous = self
                .commands
                .values()
                .filter(|record| record.command.kind == HostCommandKind::Stop)
                .filter_map(|record| stop_generation(&record.command).ok().flatten())
                .max();
            if previous.is_some_and(|previous| incoming.is_none_or(|incoming| incoming <= previous))
            {
                return Err(HostError::Conflict);
            }
        }
        let receipt = CommandReceipt {
            command_id: command.command_id.clone(),
            identity: command.identity.clone(),
            state: HostCommandState::Received,
            effect_state: ControlEffectState::Received,
            receipt: Some("durably received by execution Host".into()),
        };
        self.append(&JournalRecord::Command {
            command: Box::new(command.clone()),
            receipt: receipt.clone(),
        })?;
        if command.kind == HostCommandKind::Start {
            self.active.insert(
                command.identity.attempt_id.clone(),
                command.identity.clone(),
            );
        }
        self.operations
            .insert(command.operation_id.clone(), command.command_id.clone());
        self.commands.insert(
            command.command_id.clone(),
            JournalCommand {
                command,
                receipt: receipt.clone(),
            },
        );
        Ok((receipt, true))
    }

    fn canonical_exit_proof(&self, identity: &ExecutionIdentity) -> Option<VerifiedExitProof> {
        self.canonical_exit
            .as_ref()
            .filter(|(owner, _)| owner == identity)
            .map(|(_, proof)| proof.clone())
    }

    fn check_exit_proof(
        &self,
        identity: &ExecutionIdentity,
        proof: &VerifiedExitProof,
    ) -> Result<(), HostError> {
        if proof.attempt_id != identity.attempt_id
            || proof.execution_epoch != identity.execution_epoch
            || proof.host != identity.host
            || proof.config_digest != identity.config_digest
            || proof.kind != ExitProofKind::DriverQuiescence
            || proof.verifier != ExitProofVerifier::Driver
            || proof.verified_at <= 0
            || proof.evidence_digest.len() != 64
            || !proof
                .evidence_digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || crate::database::validate_id(&proof.proof_id).is_err()
        {
            return Err(HostError::Conflict);
        }
        if let Some((owner, original)) = &self.canonical_exit
            && (owner != identity
                || serde_json::to_value(original)? != serde_json::to_value(proof)?)
        {
            return Err(HostError::Conflict);
        }
        Ok(())
    }

    fn remember_exit_proof(
        &mut self,
        identity: &ExecutionIdentity,
        proof: VerifiedExitProof,
    ) -> Result<(), HostError> {
        self.check_exit_proof(identity, &proof)?;
        if self.canonical_exit.is_none() {
            self.canonical_exit = Some((identity.clone(), proof));
        }
        self.active.remove(&identity.attempt_id);
        Ok(())
    }

    fn update_receipt(
        &mut self,
        command_id: &str,
        state: HostCommandState,
        effect_state: ControlEffectState,
        detail: Option<String>,
    ) -> Result<(), HostError> {
        let Some(command) = self.commands.get(command_id).cloned() else {
            return Err(HostError::Invalid("unknown command ID".into()));
        };
        let receipt = CommandReceipt {
            command_id: command_id.to_owned(),
            identity: command.command.identity.clone(),
            state,
            effect_state,
            receipt: detail,
        };
        if matches!(
            command.receipt.state,
            HostCommandState::Completed | HostCommandState::Rejected
        ) {
            return if serde_json::to_value(&command.receipt)? == serde_json::to_value(&receipt)? {
                Ok(())
            } else {
                Err(HostError::Conflict)
            };
        }
        let proof = if command.command.kind == HostCommandKind::Stop
            && receipt.state == HostCommandState::Completed
        {
            let proof: VerifiedExitProof =
                serde_json::from_str(receipt.receipt.as_deref().ok_or(HostError::Conflict)?)?;
            self.check_exit_proof(&receipt.identity, &proof)?;
            Some(proof)
        } else {
            None
        };
        self.append(&JournalRecord::Receipt {
            receipt: receipt.clone(),
        })?;
        if let Some(proof) = proof {
            self.remember_exit_proof(&receipt.identity, proof)?;
        }
        if let Some(record) = self.commands.get_mut(command_id) {
            record.receipt = receipt;
        }
        Ok(())
    }

    fn append_event(
        &mut self,
        identity: &ExecutionIdentity,
        kind: &str,
        payload: String,
    ) -> Result<(), HostError> {
        let sequence = self.sequence + 1;
        let event = HostEvent {
            event_id: format!(
                "event-{}-{sequence}",
                payload_digest(format!("{}\0{}", self.host_id, self.host_epoch).as_bytes())
            ),
            identity: identity.clone(),
            sequence,
            kind: kind.to_owned(),
            payload,
            observed_at: now(),
        };
        let proof = if kind == "exit_confirmed" {
            let payload: Value = serde_json::from_str(&event.payload)?;
            let proof: VerifiedExitProof =
                serde_json::from_value(payload.get("proof").cloned().ok_or(HostError::Conflict)?)?;
            self.check_exit_proof(identity, &proof)?;
            Some(proof)
        } else {
            None
        };
        self.append(&JournalRecord::Event {
            event: event.clone(),
        })?;
        if let Some(proof) = proof {
            self.remember_exit_proof(identity, proof)?;
        }
        self.sequence = sequence;
        if kind == "driver_started" {
            self.active
                .insert(identity.attempt_id.clone(), identity.clone());
        }
        if kind == "exit_confirmed" {
            self.active.remove(&identity.attempt_id);
        }
        self.events.insert(event.sequence, event);
        self.event_bytes += serde_json::to_vec(&self.events[&sequence])?.len();
        while self.events.len() > MAX_EVENTS_IN_MEMORY
            || self.event_bytes > MAX_EVENTS_IN_MEMORY_BYTES
        {
            if let Some(first) = self.events.keys().next().copied()
                && let Some(event) = self.events.remove(&first)
            {
                self.event_bytes = self
                    .event_bytes
                    .saturating_sub(serde_json::to_vec(&event)?.len());
            }
        }
        Ok(())
    }

    fn page(&self, after_sequence: u64, limit: usize) -> HostEventPage {
        let limit = limit.clamp(1, MAX_EVENT_PAGE);
        let mut events = Vec::new();
        let mut page_bytes = 0usize;
        for (_, event) in self
            .events
            .range((after_sequence.saturating_add(1))..)
            .take(limit)
        {
            let event_bytes =
                serde_json::to_vec(event).map_or(MAX_EVENT_PAGE_BYTES, |bytes| bytes.len());
            if page_bytes.saturating_add(event_bytes) > MAX_EVENT_PAGE_BYTES {
                break;
            }
            page_bytes += event_bytes;
            events.push(event.clone());
        }
        let next_sequence = events.last().map_or(after_sequence, |event| event.sequence);
        let first_available = self
            .events
            .keys()
            .next()
            .copied()
            .unwrap_or(self.sequence + 1);
        HostEventPage {
            protocol_version: HOST_PROTOCOL_VERSION,
            events,
            next_sequence,
            gap: after_sequence.saturating_add(1) < first_available,
        }
    }

    fn mark_restarted_attempts(&mut self) -> Result<(), HostError> {
        let active = self.active.clone();
        for (_, identity) in active {
            self.append_event(
                &identity,
                "owner_unreachable",
                json!({"reason": "Host process restarted; driver ownership cannot be reattached"})
                    .to_string(),
            )?;
        }
        let pending: Vec<_> = self
            .commands
            .iter()
            .filter(|(_, record)| {
                record.receipt.state == HostCommandState::Received
                    && record.command.kind != HostCommandKind::Result
            })
            .map(|(id, record)| (id.clone(), record.command.identity.clone()))
            .collect();
        for (command_id, identity) in pending {
            self.update_receipt(
                &command_id,
                HostCommandState::Unknown,
                ControlEffectState::Unknown,
                Some("Host restarted with command effect unresolved".into()),
            )?;
            self.append_event(
                &identity,
                "command_outcome_unknown",
                json!({"commandId": command_id}).to_string(),
            )?;
        }
        Ok(())
    }

    fn replay(&mut self) -> Result<(), HostError> {
        let file = File::open(&self.path)?;
        for (line_number, line) in BufReader::new(file).lines().enumerate() {
            let line = line?;
            let record: JournalRecord = serde_json::from_str(&line).map_err(|error| {
                HostError::Config(format!("journal line {}: {error}", line_number + 1))
            })?;
            match record {
                JournalRecord::Command { command, receipt } => {
                    if command.identity.host.as_ref()
                        != Some(&HostIdentity {
                            host_id: self.host_id.clone(),
                            host_epoch: self.host_epoch.clone(),
                        })
                        || command.fingerprint != host_command_fingerprint(&command)?
                        || receipt.command_id != command.command_id
                        || receipt.identity != command.identity
                    {
                        return Err(HostError::Config(
                            "invalid command identity or fingerprint in journal".into(),
                        ));
                    }
                    if command.kind == HostCommandKind::Start {
                        self.active.insert(
                            command.identity.attempt_id.clone(),
                            command.identity.clone(),
                        );
                    }
                    if self.commands.contains_key(&command.command_id)
                        || self.operations.contains_key(&command.operation_id)
                    {
                        return Err(HostError::Config(format!(
                            "duplicate command ID in journal line {}",
                            line_number + 1
                        )));
                    }
                    self.operations
                        .insert(command.operation_id.clone(), command.command_id.clone());
                    self.commands.insert(
                        command.command_id.clone(),
                        JournalCommand {
                            command: *command,
                            receipt,
                        },
                    );
                }
                JournalRecord::Receipt { receipt } => {
                    let command =
                        self.commands
                            .get(&receipt.command_id)
                            .cloned()
                            .ok_or_else(|| {
                                HostError::Config(format!(
                                    "receipt for unknown command at journal line {}",
                                    line_number + 1
                                ))
                            })?;
                    if receipt.identity != command.command.identity
                        || (matches!(
                            command.receipt.state,
                            HostCommandState::Completed | HostCommandState::Rejected
                        ) && serde_json::to_value(&command.receipt)?
                            != serde_json::to_value(&receipt)?)
                    {
                        return Err(HostError::Config(
                            "nonmonotonic or mismatched receipt in journal".into(),
                        ));
                    }
                    if command.command.kind == HostCommandKind::Stop
                        && receipt.state == HostCommandState::Completed
                    {
                        let proof: VerifiedExitProof = serde_json::from_str(
                            receipt.receipt.as_deref().ok_or(HostError::Conflict)?,
                        )?;
                        self.remember_exit_proof(&receipt.identity, proof)?;
                    }
                    if let Some(command) = self.commands.get_mut(&receipt.command_id) {
                        command.receipt = receipt;
                    }
                }
                JournalRecord::Event { event } => {
                    if event.identity.host.as_ref().is_none_or(|host| {
                        host.host_id != self.host_id || host.host_epoch != self.host_epoch
                    }) {
                        return Err(HostError::Config(format!(
                            "Host identity mismatch in journal line {}",
                            line_number + 1
                        )));
                    }
                    if event.sequence != self.sequence + 1 {
                        return Err(HostError::Config(format!(
                            "event sequence gap in journal line {}",
                            line_number + 1
                        )));
                    }
                    if event.kind == "exit_confirmed" {
                        let payload: Value = serde_json::from_str(&event.payload)?;
                        let proof: VerifiedExitProof = serde_json::from_value(
                            payload.get("proof").cloned().ok_or(HostError::Conflict)?,
                        )?;
                        self.remember_exit_proof(&event.identity, proof)?;
                    }
                    self.sequence = event.sequence;
                    if event.kind == "driver_started" {
                        self.active
                            .insert(event.identity.attempt_id.clone(), event.identity.clone());
                    }
                    if event.kind == "exit_confirmed" {
                        self.active.remove(&event.identity.attempt_id);
                    }
                    self.events.insert(event.sequence, event);
                    self.event_bytes += serde_json::to_vec(&self.events[&self.sequence])?.len();
                    while self.events.len() > MAX_EVENTS_IN_MEMORY
                        || self.event_bytes > MAX_EVENTS_IN_MEMORY_BYTES
                    {
                        if let Some(first) = self.events.keys().next().copied()
                            && let Some(event) = self.events.remove(&first)
                        {
                            self.event_bytes = self
                                .event_bytes
                                .saturating_sub(serde_json::to_vec(&event)?.len());
                        }
                    }
                }
            }
            self.record_count += 1;
            if self.record_count > MAX_JOURNAL_RECORDS {
                return Err(HostError::Config(
                    "Host journal exceeded its configured record limit".into(),
                ));
            }
        }
        Ok(())
    }

    fn append(&mut self, record: &JournalRecord) -> Result<(), HostError> {
        let reserved = self.can_use_control_reserve(record);
        let record_limit = if reserved {
            MAX_JOURNAL_RECORDS
        } else {
            MAX_JOURNAL_RECORDS - CONTROL_RECORD_RESERVE
        };
        if self.record_count >= record_limit {
            return Err(HostError::Config(
                "Host journal reached its configured record limit".into(),
            ));
        }
        let mut bytes = serde_json::to_vec(record)?;
        bytes.push(b'\n');
        let byte_limit = if reserved {
            MAX_JOURNAL_BYTES
        } else {
            MAX_JOURNAL_BYTES - CONTROL_JOURNAL_RESERVE
        };
        if self.bytes.saturating_add(bytes.len() as u64) > byte_limit {
            return Err(HostError::Config(
                "Host journal reached its configured size limit".into(),
            ));
        }
        let mut file = OpenOptions::new().append(true).open(&self.path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        self.bytes += bytes.len() as u64;
        self.record_count += 1;
        Ok(())
    }

    fn can_use_control_reserve(&self, record: &JournalRecord) -> bool {
        match record {
            JournalRecord::Command { command, .. } => command.kind == HostCommandKind::Stop,
            JournalRecord::Receipt { receipt } => self
                .commands
                .get(&receipt.command_id)
                .is_some_and(|command| command.command.kind == HostCommandKind::Stop),
            JournalRecord::Event { event } => matches!(
                event.kind.as_str(),
                "stop_requested"
                    | "stop_unconfirmed"
                    | "command_outcome_unknown"
                    | "owner_unreachable"
                    | "manual_required"
                    | "exit_confirmed"
            ),
        }
    }
}

fn validate_command(config: &HostConfig, command: &HostCommand) -> Result<(), HostError> {
    validate_identity(config, &command.identity)?;
    crate::database::validate_id(&command.command_id)?;
    crate::database::validate_id(&command.operation_id)?;
    if command.fingerprint != host_command_fingerprint(command)? {
        return Err(HostError::Invalid("command fingerprint mismatch".into()));
    }
    if command.command_id.is_empty()
        || command.operation_id.is_empty()
        || command.fingerprint.is_empty()
        || command.identity.attempt_id.is_empty()
        || command.identity.task_id.is_empty()
    {
        return Err(HostError::Invalid("incomplete command identity".into()));
    }
    if command.payload.len() > MAX_REQUEST_BYTES {
        return Err(HostError::Invalid(
            "command payload exceeded size limit".into(),
        ));
    }
    if command.kind == HostCommandKind::Start {
        let payload: StartPayload = serde_json::from_str(&command.payload)?;
        if payload.session.account_id.is_some()
            || matches!(payload.session.agent, crate::protocol::AgentKind::Opencode)
        {
            return Err(HostError::UnsupportedManagedAccount);
        }
        if payload.session.resume.is_some() {
            return Err(HostError::Invalid(
                "resuming provider sessions is not supported by this Host adapter".into(),
            ));
        }
    }
    if command.kind == HostCommandKind::Stop {
        let _ = stop_generation(command)?;
    }
    if command.kind == HostCommandKind::Send {
        let _: MessagePayload = serde_json::from_str(&command.payload)?;
    }
    if command.kind == HostCommandKind::InteractionReply {
        let reply: InteractionReply = serde_json::from_str(&command.payload)?;
        if reply.command_id != command.command_id
            || reply.operation_id != command.operation_id
            || reply.identity != command.identity
        {
            return Err(HostError::Invalid(
                "interaction reply identity does not match its command".into(),
            ));
        }
        if reply.allow.is_none() && reply.answers.is_empty() && !reply.cancelled {
            return Err(HostError::Invalid(
                "interaction reply contains no decision".into(),
            ));
        }
    }
    Ok(())
}

fn stop_generation(command: &HostCommand) -> Result<Option<u64>, HostError> {
    let payload: Value = serde_json::from_str(&command.payload)?;
    let Some(generation) = payload.get("stopGeneration") else {
        return Ok(None);
    };
    generation
        .as_u64()
        .filter(|generation| *generation > 0 && *generation <= i64::MAX as u64)
        .map(Some)
        .ok_or_else(|| HostError::Invalid("invalid stop generation".into()))
}

fn validate_identity(config: &HostConfig, identity: &ExecutionIdentity) -> Result<(), HostError> {
    let host = identity
        .host
        .as_ref()
        .ok_or_else(|| HostError::Invalid("command has no Host identity".into()))?;
    if host.host_id != config.host_id || host.host_epoch != config.host_epoch {
        return Err(HostError::Invalid("Host identity mismatch".into()));
    }
    crate::database::validate_id(&identity.attempt_id)?;
    crate::database::validate_id(&identity.task_id)?;
    if let Some(dispatch_id) = &identity.dispatch_id {
        crate::database::validate_id(dispatch_id)?;
    }
    if identity.execution_epoch == 0
        || identity.execution_epoch > i64::MAX as u64
        || identity.config_digest.len() != 64
        || !identity
            .config_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(HostError::Invalid("incomplete execution identity".into()));
    }
    Ok(())
}

fn validate_config(config: &HostConfig) -> std::io::Result<()> {
    if crate::database::validate_id(&config.host_id).is_err()
        || crate::database::validate_id(&config.host_epoch).is_err()
    {
        return Err(std::io::Error::other("Host ID and epoch are required"));
    }
    Ok(())
}

fn journal_path(config: &HostConfig) -> PathBuf {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(config.host_id.as_bytes());
    digest.update(b"\0");
    digest.update(config.host_epoch.as_bytes());
    let suffix = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    config.data_dir.join(format!("host-journal-{suffix}.jsonl"))
}

fn prepare_private_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(std::io::Error::other(
            "Host directory must be private and owned by the current user",
        ));
    }
    Ok(())
}

fn read_token(path: &Path) -> std::io::Result<Vec<u8>> {
    Ok(super::read_private_token(path)?.into_bytes())
}

fn set_private_socket_permissions(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn valid_token(expected: &[u8], actual: &[u8]) -> bool {
    expected.len() == actual.len() && bool::from(expected.ct_eq(actual))
}

fn payload_digest(payload: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(payload)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn error_code(error: &HostError) -> &'static str {
    match error {
        HostError::Config(_) => "HOST_CONFIG",
        HostError::Invalid(_) => "INVALID_COMMAND",
        HostError::Conflict => "COMMAND_CONFLICT",
        HostError::UnsupportedManagedAccount => "CAPABILITY_UNSUPPORTED",
        HostError::Io(_) => "HOST_STORAGE",
        HostError::Json(_) => "INVALID_PAYLOAD",
        HostError::Agent(_) => "DRIVER_OUTCOME_UNKNOWN",
    }
}

async fn write_response(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    response: HostResponse,
) -> std::io::Result<()> {
    let bytes =
        serde_json::to_vec(&response).map_err(|error| std::io::Error::other(error.to_string()))?;
    timeout(
        std::time::Duration::from_secs(CLIENT_TIMEOUT_SECONDS),
        async {
            writer.write_all(&bytes).await?;
            writer.write_all(b"\n").await?;
            writer.shutdown().await
        },
    )
    .await
    .map_err(|_| std::io::Error::other("Host response write timed out"))?
}

async fn read_bounded_line<R>(reader: &mut R, limit: usize) -> std::io::Result<Vec<u8>>
where
    R: AsyncBufRead + Unpin,
{
    let mut bytes = Vec::with_capacity(limit.min(8192));
    loop {
        let (count, complete) = {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                return Ok(bytes);
            }
            let count = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |index| index + 1);
            if bytes.len().saturating_add(count) > limit {
                return Err(std::io::Error::other("request exceeded the size limit"));
            }
            bytes.extend_from_slice(&available[..count]);
            (count, bytes.last() == Some(&b'\n'))
        };
        reader.consume(count);
        if complete {
            return Ok(bytes);
        }
    }
}

async fn reject_overloaded(stream: UnixStream) -> std::io::Result<()> {
    let (_, mut writer) = stream.into_split();
    write_response(
        &mut writer,
        HostResponse::Error {
            code: "HOST_BUSY".into(),
            message: "execution Host request capacity is full".into(),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> ExecutionIdentity {
        ExecutionIdentity {
            task_id: "task".into(),
            dispatch_id: Some("dispatch".into()),
            attempt_id: "attempt".into(),
            execution_epoch: 1,
            host: Some(HostIdentity {
                host_id: "host".into(),
                host_epoch: "epoch".into(),
            }),
            config_digest: "a".repeat(64),
        }
    }

    fn config() -> HostConfig {
        HostConfig {
            data_dir: PathBuf::new(),
            socket_path: PathBuf::new(),
            token_file: PathBuf::new(),
            host_id: "host".into(),
            host_epoch: "epoch".into(),
        }
    }

    fn command(kind: HostCommandKind, id: &str) -> HostCommand {
        let mut command = HostCommand {
            command_id: format!("command-{id}"),
            operation_id: format!("operation-{id}"),
            identity: identity(),
            kind,
            fingerprint: String::new(),
            payload: "{}".into(),
        };
        command.fingerprint = host_command_fingerprint(&command).unwrap();
        command
    }

    #[test]
    fn validates_complete_identity_and_recomputes_fingerprint() {
        let command = command(HostCommandKind::Snapshot, "snapshot");
        validate_command(&config(), &command).unwrap();
        let mut forged = command.clone();
        forged.payload = "{\"other\":true}".into();
        assert!(validate_command(&config(), &forged).is_err());
        for incomplete in [
            ExecutionIdentity {
                config_digest: "fake-digest".into(),
                ..identity()
            },
            ExecutionIdentity {
                execution_epoch: 0,
                ..identity()
            },
            ExecutionIdentity {
                dispatch_id: Some(String::new()),
                ..identity()
            },
            ExecutionIdentity {
                host: Some(HostIdentity {
                    host_epoch: "stale".into(),
                    host_id: "host".into(),
                }),
                ..identity()
            },
        ] {
            assert!(validate_identity(&config(), &incomplete).is_err());
        }
    }

    #[test]
    fn journal_refuses_second_attempt_and_terminal_receipt_regression() {
        let directory = tempfile::tempdir().unwrap();
        let mut journal = Journal::open(
            directory.path().join("journal"),
            "host".into(),
            "epoch".into(),
        )
        .unwrap();
        let start = command(HostCommandKind::Start, "start");
        journal.accept(start.clone()).unwrap();
        journal
            .update_receipt(
                &start.command_id,
                HostCommandState::Completed,
                ControlEffectState::Delivered,
                None,
            )
            .unwrap();
        assert!(
            journal
                .update_receipt(
                    &start.command_id,
                    HostCommandState::Unknown,
                    ControlEffectState::Unknown,
                    None
                )
                .is_err()
        );
        let mut second = command(HostCommandKind::Start, "second");
        second.identity.attempt_id = "other-attempt".into();
        second.fingerprint = host_command_fingerprint(&second).unwrap();
        assert!(journal.accept(second).is_err());
        assert_eq!(
            journal.accept(start).unwrap().0.state,
            HostCommandState::Completed
        );
    }

    #[test]
    fn restart_preserves_offline_result_payload_and_received_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("journal");
        let mut journal = Journal::open(path.clone(), "host".into(), "epoch".into()).unwrap();
        let start = command(HostCommandKind::Start, "start");
        journal.accept(start.clone()).unwrap();
        journal
            .update_receipt(
                &start.command_id,
                HostCommandState::Completed,
                ControlEffectState::Delivered,
                None,
            )
            .unwrap();
        let result = command(HostCommandKind::Result, "result");
        journal.accept(result.clone()).unwrap();
        drop(journal);
        let mut reopened = Journal::open(path, "host".into(), "epoch".into()).unwrap();
        reopened.mark_restarted_attempts().unwrap();
        assert_eq!(
            reopened.commands[&result.command_id].command.payload,
            result.payload
        );
        assert_eq!(
            reopened.commands[&result.command_id].receipt.state,
            HostCommandState::Received
        );
        assert_eq!(reopened.active.len(), 1);
    }

    #[test]
    fn stop_generation_rejects_stale_commands_but_preserves_replays() {
        let directory = tempfile::tempdir().unwrap();
        let mut journal = Journal::open(
            directory.path().join("journal"),
            "host".into(),
            "epoch".into(),
        )
        .unwrap();
        let start = command(HostCommandKind::Start, "start");
        journal.accept(start.clone()).unwrap();
        journal
            .update_receipt(
                &start.command_id,
                HostCommandState::Completed,
                ControlEffectState::Delivered,
                None,
            )
            .unwrap();
        let mut stop = command(HostCommandKind::Stop, "stop");
        stop.payload = json!({"stopGeneration": 3}).to_string();
        stop.fingerprint = host_command_fingerprint(&stop).unwrap();
        journal.accept(stop.clone()).unwrap();
        assert!(!journal.accept(stop).unwrap().1);
        let mut stale = command(HostCommandKind::Stop, "stale");
        stale.payload = json!({"stopGeneration": 2}).to_string();
        stale.fingerprint = host_command_fingerprint(&stale).unwrap();
        assert!(journal.accept(stale).is_err());
        assert!(
            journal
                .accept(command(HostCommandKind::Stop, "legacy"))
                .is_err()
        );
    }

    #[test]
    fn stop_before_start_is_durable_and_fences_future_start() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("journal");
        let mut journal = Journal::open(path.clone(), "host".into(), "epoch".into()).unwrap();
        journal
            .accept(command(HostCommandKind::Stop, "stop"))
            .unwrap();
        assert!(
            journal
                .accept(command(HostCommandKind::Start, "start"))
                .is_err()
        );
        drop(journal);
        let mut journal = Journal::open(path, "host".into(), "epoch".into()).unwrap();
        assert!(
            journal
                .accept(command(HostCommandKind::Start, "start"))
                .is_err()
        );
    }

    async fn runtime_fixture(directory: &Path, journal: Journal) -> Runtime {
        let database = Database::open(directory.join("driver-state"))
            .await
            .unwrap();
        Runtime {
            config: config(),
            token: Arc::new(Vec::new()),
            agents: Agents::new(database.clone()),
            database,
            journal: Arc::new(Mutex::new(journal)),
            shutdown: tokio::sync::watch::channel(false).0,
            closing: Arc::new(AtomicBool::new(false)),
            execution: Arc::new(Mutex::new(())),
            owned: Arc::new(Mutex::new(HashSet::new())),
            storage_failed: Arc::new(AtomicBool::new(false)),
            inflight: Arc::new(AtomicUsize::new(0)),
            pump_sequence: Arc::new(AtomicU64::new(0)),
        }
    }

    #[tokio::test]
    async fn unknown_stop_query_does_not_take_restarted_or_mismatched_ownership() {
        let directory = tempfile::tempdir().unwrap();
        let mut journal = Journal::open(
            directory.path().join("journal"),
            "host".into(),
            "epoch".into(),
        )
        .unwrap();
        let start = command(HostCommandKind::Start, "start");
        journal.accept(start.clone()).unwrap();
        journal
            .update_receipt(
                &start.command_id,
                HostCommandState::Completed,
                ControlEffectState::Delivered,
                None,
            )
            .unwrap();
        let stop = command(HostCommandKind::Stop, "stop");
        journal.accept(stop.clone()).unwrap();
        journal
            .update_receipt(
                &stop.command_id,
                HostCommandState::Unknown,
                ControlEffectState::Unknown,
                None,
            )
            .unwrap();
        let runtime = runtime_fixture(directory.path(), journal).await;
        assert_eq!(
            runtime
                .command_detail(&stop.command_id)
                .await
                .unwrap()
                .receipt
                .state,
            HostCommandState::Unknown
        );
        runtime
            .owned
            .lock()
            .await
            .insert(stop.identity.attempt_id.clone());
        runtime
            .journal
            .lock()
            .await
            .commands
            .get_mut(&stop.command_id)
            .unwrap()
            .command
            .identity
            .config_digest = "b".repeat(64);
        assert_eq!(
            runtime
                .command_detail(&stop.command_id)
                .await
                .unwrap()
                .receipt
                .state,
            HostCommandState::Unknown
        );
        let journal = runtime.journal.lock().await;
        assert_eq!(journal.sequence, 0);
        assert_eq!(journal.commands.len(), 2);
        assert_eq!(runtime.inflight.load(Ordering::Acquire), 0);
        drop(journal);
        runtime.agents.shutdown().await.unwrap();
        runtime.database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn evicted_exit_event_reuses_durable_proof_for_a_different_stop() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("journal");
        let mut journal = Journal::open(path.clone(), "host".into(), "epoch".into()).unwrap();
        let start = command(HostCommandKind::Start, "start");
        journal.accept(start.clone()).unwrap();
        journal
            .update_receipt(
                &start.command_id,
                HostCommandState::Completed,
                ControlEffectState::Delivered,
                None,
            )
            .unwrap();
        let stop = command(HostCommandKind::Stop, "first-stop");
        journal.accept(stop.clone()).unwrap();
        let proof = VerifiedExitProof {
            proof_id: "proof-first-stop".into(),
            attempt_id: stop.identity.attempt_id.clone(),
            execution_epoch: 1,
            host: stop.identity.host.clone(),
            config_digest: stop.identity.config_digest.clone(),
            kind: ExitProofKind::DriverQuiescence,
            verifier: ExitProofVerifier::Driver,
            evidence_digest: "b".repeat(64),
            verified_at: 1,
        };
        let original = serde_json::to_string(&proof).unwrap();
        journal
            .append_event(
                &stop.identity,
                "exit_confirmed",
                json!({"proof":proof}).to_string(),
            )
            .unwrap();
        journal
            .update_receipt(
                &stop.command_id,
                HostCommandState::Completed,
                ControlEffectState::Delivered,
                Some(original.clone()),
            )
            .unwrap();
        drop(journal);
        let mut journal = Journal::open(path, "host".into(), "epoch".into()).unwrap();
        journal.events.clear();
        journal.event_bytes = 0;
        let next = command(HostCommandKind::Stop, "different-stop");
        journal.accept(next.clone()).unwrap();
        let mut conflicting = proof.clone();
        conflicting.proof_id = "different-proof".into();
        assert!(
            journal
                .update_receipt(
                    &next.command_id,
                    HostCommandState::Completed,
                    ControlEffectState::Delivered,
                    Some(serde_json::to_string(&conflicting).unwrap())
                )
                .is_err()
        );
        let runtime = runtime_fixture(directory.path(), journal).await;
        let (state, effect, receipt) = runtime.stop(&next).await.unwrap();
        assert_eq!(state, HostCommandState::Completed);
        assert_eq!(effect, ControlEffectState::Delivered);
        assert_eq!(receipt, Some(original));
        let journal = runtime.journal.lock().await;
        assert!(journal.events.is_empty());
        assert_eq!(journal.sequence, 1);
        assert_eq!(journal.commands.len(), 3);
        drop(journal);
        runtime.agents.shutdown().await.unwrap();
        runtime.database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn durable_exit_event_recovers_unknown_receipt_after_restart_without_signals() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("journal");
        let mut journal = Journal::open(path.clone(), "host".into(), "epoch".into()).unwrap();
        let start = command(HostCommandKind::Start, "start");
        journal.accept(start.clone()).unwrap();
        journal
            .update_receipt(
                &start.command_id,
                HostCommandState::Completed,
                ControlEffectState::Delivered,
                None,
            )
            .unwrap();
        let stop = command(HostCommandKind::Stop, "unknown-stop");
        journal.accept(stop.clone()).unwrap();
        journal
            .update_receipt(
                &stop.command_id,
                HostCommandState::Unknown,
                ControlEffectState::Unknown,
                None,
            )
            .unwrap();
        let proof = VerifiedExitProof {
            proof_id: "proof-durable-exit".into(),
            attempt_id: stop.identity.attempt_id.clone(),
            execution_epoch: 1,
            host: stop.identity.host.clone(),
            config_digest: stop.identity.config_digest.clone(),
            kind: ExitProofKind::DriverQuiescence,
            verifier: ExitProofVerifier::Driver,
            evidence_digest: "b".repeat(64),
            verified_at: 1,
        };
        let original = serde_json::to_string(&proof).unwrap();
        journal
            .append_event(
                &stop.identity,
                "exit_confirmed",
                json!({"proof":proof}).to_string(),
            )
            .unwrap();
        drop(journal);
        let mut journal = Journal::open(path.clone(), "host".into(), "epoch".into()).unwrap();
        journal.events.clear();
        journal.event_bytes = 0;
        let runtime = runtime_fixture(directory.path(), journal).await;
        assert!(runtime.owned.lock().await.is_empty());
        let (first, second) = tokio::join!(
            runtime.command_detail(&stop.command_id),
            runtime.command_detail(&stop.command_id)
        );
        assert!(
            first.unwrap().receipt.state == HostCommandState::Completed
                || second.unwrap().receipt.state == HostCommandState::Completed
        );
        let detail = runtime.command_detail(&stop.command_id).await.unwrap();
        assert_eq!(detail.receipt.state, HostCommandState::Completed);
        assert_eq!(detail.receipt.receipt, Some(original.clone()));
        assert_eq!(runtime.agents.count(), 0);
        let journal = runtime.journal.lock().await;
        assert_eq!(journal.sequence, 1);
        assert!(journal.events.is_empty());
        assert_eq!(journal.commands.len(), 2);
        drop(journal);
        runtime.agents.shutdown().await.unwrap();
        runtime.database.shutdown().await.unwrap();
        drop(runtime);
        let mut reopened = Journal::open(path, "host".into(), "epoch".into()).unwrap();
        let duplicate = reopened.commands[&stop.command_id].receipt.clone();
        reopened
            .append(&JournalRecord::Receipt { receipt: duplicate })
            .unwrap();
        let path = reopened.path.clone();
        drop(reopened);
        let reopened = Journal::open(path, "host".into(), "epoch".into()).unwrap();
        assert_eq!(
            reopened.commands[&stop.command_id].receipt.receipt,
            Some(original)
        );
    }

    #[test]
    fn retained_event_gap_is_explicit() {
        let directory = tempfile::tempdir().unwrap();
        let mut journal = Journal::open(
            directory.path().join("journal"),
            "host".into(),
            "epoch".into(),
        )
        .unwrap();
        journal
            .append_event(&identity(), "first", "{}".into())
            .unwrap();
        journal
            .append_event(&identity(), "second", "{}".into())
            .unwrap();
        crate::database::validate_id(&journal.events[&1].event_id).unwrap();
        journal.events.remove(&1);
        assert!(journal.page(0, 10).gap);
        assert!(!journal.page(1, 10).gap);
    }
}
