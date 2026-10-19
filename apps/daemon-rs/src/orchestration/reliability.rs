use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use ts_rs::TS;

use super::{WorkerStartOperation, WorkerStartPhase, WorkerStartSideEffectState};
use crate::database::Store;
use crate::error::{Error, Result};
pub use crate::protocol::ControlEffectState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Start,
    Stop,
    Message,
    Result,
    InteractionReply,
    Reconcile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OperationState {
    Accepted,
    Running,
    Waiting,
    Succeeded,
    Failed,
    Cancelled,
    OutcomeUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExecutionState {
    Planned,
    Starting,
    Running,
    WaitingInput,
    StopRequested,
    Stopping,
    StartUnknown,
    StopUnknown,
    OwnerUnreachable,
    ManualRequired,
    Quiesced,
    ExitConfirmed,
    Finalized,
}

impl ExecutionState {
    pub fn holds_task(&self) -> bool {
        !matches!(self, Self::Finalized)
    }

    pub fn requires_exit_proof(&self) -> bool {
        matches!(self, Self::Quiesced | Self::ExitConfirmed | Self::Finalized)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ResultState {
    None,
    Submitted,
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WaitReason {
    AccountThrottled,
    HostPressure,
    StartQueueFull,
    DependencyBlocked,
    WaitingInput,
    OwnerUnreachable,
    ConfigInvalid,
    HostIncompatible,
    StorageUnavailable,
    ManualRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HostCommandKind {
    Start,
    Stop,
    Send,
    Result,
    InteractionReply,
    Snapshot,
    Reconcile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HostCommandState {
    Pending,
    Sent,
    Received,
    Completed,
    Unknown,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExitProofKind {
    HostProcessExit,
    DriverQuiescence,
    StartupNotStarted,
    RegisteredResourceRelease,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExitProofVerifier {
    ExecutionHost,
    Driver,
    StartupCoordinator,
    ResourceHandler,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostIdentity {
    pub host_id: String,
    pub host_epoch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionIdentity {
    pub task_id: String,
    pub dispatch_id: Option<String>,
    pub attempt_id: String,
    #[ts(type = "number")]
    pub execution_epoch: u64,
    pub host: Option<HostIdentity>,
    pub config_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OperationView {
    pub operation_id: String,
    pub kind: OperationKind,
    pub state: OperationState,
    pub task_id: Option<String>,
    pub attempt_id: Option<String>,
    #[ts(type = "number | null")]
    pub execution_epoch: Option<u64>,
    pub effect_state: ControlEffectState,
    pub wait_reason: Option<WaitReason>,
    #[ts(type = "number | null")]
    pub retry_after_ms: Option<u64>,
    #[ts(type = "number | null")]
    pub next_reconcile_at: Option<i64>,
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostCommand {
    pub command_id: String,
    pub operation_id: String,
    pub identity: ExecutionIdentity,
    pub kind: HostCommandKind,
    pub fingerprint: String,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommandReceipt {
    pub command_id: String,
    pub identity: ExecutionIdentity,
    pub state: HostCommandState,
    pub effect_state: ControlEffectState,
    pub receipt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionReply {
    pub operation_id: String,
    pub command_id: String,
    pub identity: ExecutionIdentity,
    pub request_id: String,
    pub allow: Option<bool>,
    pub answers: Vec<crate::protocol::QuestionAnswer>,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NewOperation {
    pub operation: OperationView,
    pub request_version: u32,
    pub fingerprint: String,
    pub request: String,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NewExecution {
    pub identity: ExecutionIdentity,
    pub state: ExecutionState,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedExitProof {
    pub proof_id: String,
    pub attempt_id: String,
    #[ts(type = "number")]
    pub execution_epoch: u64,
    pub host: Option<HostIdentity>,
    pub config_digest: String,
    pub kind: ExitProofKind,
    pub verifier: ExitProofVerifier,
    pub evidence_digest: String,
    #[ts(type = "number")]
    pub verified_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NewResultSubmission {
    pub submission_id: String,
    pub attempt_id: String,
    #[ts(type = "number")]
    pub execution_epoch: u64,
    pub fingerprint: String,
    pub submission: String,
    pub receipt: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NewRecoveryJob {
    pub job_id: String,
    pub kind: String,
    pub object_id: String,
    pub owner: String,
    #[ts(type = "number")]
    pub next_check_at: i64,
    pub detail: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionRecord {
    pub identity: ExecutionIdentity,
    pub state: ExecutionState,
    pub result_state: ResultState,
    #[ts(type = "number")]
    pub stop_generation: u64,
    pub exit_proof_id: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

pub fn request_fingerprint(kind: OperationKind, request_version: u32, request: &Value) -> String {
    let normalized = serde_json::to_vec(request).unwrap_or_default();
    let mut digest = Sha256::new();
    digest.update(b"prospero-operation\0");
    digest.update(sql_label(kind).as_bytes());
    digest.update(request_version.to_be_bytes());
    digest.update(normalized);
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn host_command_fingerprint(command: &HostCommand) -> Result<String> {
    let payload = serde_json::to_vec(&(
        &command.command_id,
        &command.operation_id,
        &command.identity,
        command.kind,
        &command.payload,
    ))?;
    Ok(sha256_hex(b"prospero-host-command-v1\0", &payload))
}

pub fn result_submission_fingerprint(submission: &Value) -> Result<String> {
    Ok(sha256_hex(
        b"prospero-result-submission-v1\0",
        &serde_json::to_vec(submission)?,
    ))
}

fn sha256_hex(domain: &[u8], payload: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(domain);
    digest.update(payload);
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sqlite_integer(value: u64, field: &str) -> Result<i64> {
    if value > 9_007_199_254_740_991 {
        return Err(Error::Invalid(format!("{field} exceeds supported range")));
    }
    i64::try_from(value).map_err(|_| Error::Invalid(format!("{field} exceeds supported range")))
}

pub(crate) fn accept_operation(
    transaction: &Transaction<'_>,
    input: &NewOperation,
) -> Result<OperationView> {
    let request: Value = serde_json::from_str(&input.request)?;
    if request_fingerprint(input.operation.kind, input.request_version, &request)
        != input.fingerprint
    {
        return Err(Error::Conflict);
    }
    let existing = transaction
        .query_row(
            "SELECT kind,state,task_id,attempt_id,execution_epoch,effect_state,wait_reason,retry_after_ms,next_reconcile_at,revision,request_version FROM orch_operations_v2 WHERE operation_id=?1 AND fingerprint=?2",
            params![input.operation.operation_id, input.fingerprint],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?.map(|value| value as u64),
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<i64>>(7)?.map(|value| value as u64),
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, i64>(9)? as u64,
                    row.get::<_, i64>(10)? as u32,
                ))
            },
        )
        .optional()?;
    if let Some((
        kind,
        state,
        task_id,
        attempt_id,
        execution_epoch,
        effect,
        wait,
        retry,
        next,
        revision,
        version,
    )) = existing
    {
        if version != input.request_version || kind != sql_label(input.operation.kind) {
            return Err(Error::Conflict);
        }
        return Ok(OperationView {
            operation_id: input.operation.operation_id.clone(),
            kind: input.operation.kind,
            state: parse_operation_state(&state)?,
            task_id,
            attempt_id,
            execution_epoch,
            effect_state: parse_effect_state(&effect)?,
            wait_reason: wait.map(|value| parse_wait_reason(&value)).transpose()?,
            retry_after_ms: retry,
            next_reconcile_at: next,
            revision,
        });
    }
    let by_id: Option<(String, u32, String)> = transaction
        .query_row(
            "SELECT fingerprint,request_version,kind FROM orch_operations_v2 WHERE operation_id=?1",
            [&input.operation.operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if by_id.is_some() {
        return Err(Error::Conflict);
    }
    transaction.execute(
        "INSERT INTO orch_operations_v2(operation_id,kind,request_version,fingerprint,request,state,task_id,attempt_id,execution_epoch,effect_state,wait_reason,retry_after_ms,next_reconcile_at,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15)",
        params![
            input.operation.operation_id,
            sql_label(input.operation.kind),
            input.request_version as i64,
            input.fingerprint,
            input.request,
            sql_label(input.operation.state),
            input.operation.task_id,
            input.operation.attempt_id,
            input.operation.execution_epoch.map(|value| sqlite_integer(value, "execution epoch")).transpose()?,
            sql_label(input.operation.effect_state),
            input.operation.wait_reason.map(sql_label),
            input.operation.retry_after_ms.map(|value| sqlite_integer(value, "retry-after")).transpose()?,
            input.operation.next_reconcile_at,
            sqlite_integer(input.operation.revision, "operation revision")?,
            input.created_at,
        ],
    )?;
    Ok(input.operation.clone())
}

pub(crate) fn insert_execution(transaction: &Transaction<'_>, input: &NewExecution) -> Result<()> {
    transaction.execute(
        "INSERT INTO orch_executions(attempt_id,task_id,dispatch_id,execution_epoch,host_id,host_epoch,config_digest,state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
        params![
            input.identity.attempt_id,
            input.identity.task_id,
            input.identity.dispatch_id,
            sqlite_integer(input.identity.execution_epoch, "execution epoch")?,
            input.identity.host.as_ref().map(|host| host.host_id.as_str()),
            input.identity.host.as_ref().map(|host| host.host_epoch.as_str()),
            input.identity.config_digest,
            sql_label(input.state),
            input.created_at,
        ],
    )?;
    Ok(())
}

pub(crate) fn enqueue_command(
    transaction: &Transaction<'_>,
    command: &HostCommand,
    created_at: i64,
) -> Result<()> {
    if command.fingerprint != host_command_fingerprint(command)? {
        return Err(Error::Conflict);
    }
    let identity = &command.identity;
    let duplicate = transaction.query_row(
        "SELECT operation_id,fingerprint,attempt_id,task_id,execution_epoch,host_id,host_epoch,config_digest,command_kind,payload FROM orch_host_commands WHERE command_id=?1",
        [&command.command_id],
        |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, String>(3)?, row.get::<_, i64>(4)? as u64, row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?, row.get::<_, String>(7)?,
            row.get::<_, String>(8)?, row.get::<_, String>(9)?,
        )),
    ).optional()?;
    if let Some(existing) = duplicate {
        let host_id = identity.host.as_ref().map(|host| host.host_id.clone());
        let host_epoch = identity.host.as_ref().map(|host| host.host_epoch.clone());
        if existing
            == (
                command.operation_id.clone(),
                command.fingerprint.clone(),
                identity.attempt_id.clone(),
                identity.task_id.clone(),
                identity.execution_epoch,
                host_id,
                host_epoch,
                identity.config_digest.clone(),
                sql_label(command.kind),
                command.payload.clone(),
            )
        {
            return Ok(());
        }
        return Err(Error::Conflict);
    }
    transaction.execute(
        "INSERT INTO orch_host_commands(command_id,operation_id,attempt_id,task_id,execution_epoch,host_id,host_epoch,config_digest,command_kind,fingerprint,payload,state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'pending',?12,?12)",
        params![
            command.command_id,
            command.operation_id,
            command.identity.attempt_id,
            command.identity.task_id,
            sqlite_integer(command.identity.execution_epoch, "execution epoch")?,
            command.identity.host.as_ref().map(|host| host.host_id.as_str()),
            command.identity.host.as_ref().map(|host| host.host_epoch.as_str()),
            command.identity.config_digest,
            sql_label(command.kind),
            command.fingerprint,
            command.payload,
            created_at,
        ],
    )?;
    Ok(())
}

pub(crate) fn record_command_receipt(
    transaction: &Transaction<'_>,
    receipt: &CommandReceipt,
    updated_at: i64,
) -> Result<()> {
    let serialized = serde_json::to_string(receipt)?;
    let existing = transaction.query_row(
        "SELECT state,effect_state,receipt,attempt_id,task_id,execution_epoch,host_id,host_epoch,config_digest FROM orch_host_commands WHERE command_id=?1",
        [&receipt.command_id],
        |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?, row.get::<_, String>(4)?,
            row.get::<_, i64>(5)? as u64, row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?, row.get::<_, String>(8)?,
        )),
    ).optional()?.ok_or(Error::NotFound)?;
    let host_id = receipt
        .identity
        .host
        .as_ref()
        .map(|host| host.host_id.clone());
    let host_epoch = receipt
        .identity
        .host
        .as_ref()
        .map(|host| host.host_epoch.clone());
    if existing.3 != receipt.identity.attempt_id
        || existing.4 != receipt.identity.task_id
        || existing.5 != receipt.identity.execution_epoch
        || existing.6 != host_id
        || existing.7 != host_epoch
        || existing.8 != receipt.identity.config_digest
    {
        return Err(Error::Conflict);
    }
    let next_state = sql_label(receipt.state);
    let next_effect = sql_label(receipt.effect_state);
    if existing.0 == next_state
        && existing.1 == next_effect
        && existing.2.as_deref() == Some(serialized.as_str())
    {
        return Ok(());
    }
    if !valid_command_receipt_transition(&existing.0, &next_state) {
        return Err(Error::Conflict);
    }
    let effect_matches = match receipt.state {
        HostCommandState::Pending => receipt.effect_state == ControlEffectState::None,
        HostCommandState::Sent => matches!(
            receipt.effect_state,
            ControlEffectState::None | ControlEffectState::Unknown
        ),
        HostCommandState::Received => receipt.effect_state == ControlEffectState::Received,
        HostCommandState::Completed => receipt.effect_state == ControlEffectState::Delivered,
        HostCommandState::Unknown => receipt.effect_state == ControlEffectState::Unknown,
        HostCommandState::Rejected => receipt.effect_state == ControlEffectState::Failed,
    };
    if !effect_matches {
        return Err(Error::Conflict);
    }
    let changed = transaction.execute(
        "UPDATE orch_host_commands SET state=?2,effect_state=?3,receipt=?4,updated_at=?5 WHERE command_id=?1 AND attempt_id=?6 AND task_id=?7 AND execution_epoch=?8 AND host_id IS ?9 AND host_epoch IS ?10 AND config_digest=?11 AND EXISTS(SELECT 1 FROM orch_executions WHERE attempt_id=?6 AND task_id=?7 AND execution_epoch=?8 AND host_id IS ?9 AND host_epoch IS ?10 AND config_digest=?11)",
        params![
            receipt.command_id,
            next_state,
            next_effect,
            serialized,
            updated_at,
            receipt.identity.attempt_id,
            receipt.identity.task_id,
            sqlite_integer(receipt.identity.execution_epoch, "execution epoch")?,
            receipt.identity.host.as_ref().map(|host| host.host_id.as_str()),
            receipt.identity.host.as_ref().map(|host| host.host_epoch.as_str()),
            receipt.identity.config_digest,
        ],
    )?;
    if changed == 0 {
        return Err(Error::Conflict);
    }
    Ok(())
}

pub(crate) fn record_result_submission(
    transaction: &Transaction<'_>,
    submission: &NewResultSubmission,
) -> Result<()> {
    let payload: Value = serde_json::from_str(&submission.submission)?;
    let computed = result_submission_fingerprint(&payload)?;
    if computed != submission.fingerprint {
        return Err(Error::Conflict);
    }
    let changed = transaction.execute(
        "INSERT INTO orch_result_receipts(submission_id,attempt_id,execution_epoch,fingerprint,submission,state,receipt,created_at,updated_at) SELECT ?1,attempt_id,execution_epoch,?4,?5,'received',?6,?7,?7 FROM orch_executions WHERE attempt_id=?2 AND execution_epoch=?3 ON CONFLICT(submission_id) DO NOTHING",
        params![submission.submission_id, submission.attempt_id, sqlite_integer(submission.execution_epoch, "execution epoch")?, submission.fingerprint, submission.submission, submission.receipt, submission.created_at],
    )?;
    if changed == 0 {
        let existing: (String, u64, String, String) = transaction.query_row(
            "SELECT attempt_id,execution_epoch,fingerprint,submission FROM orch_result_receipts WHERE submission_id=?1",
            [&submission.submission_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
        )?;
        if existing
            != (
                submission.attempt_id.clone(),
                submission.execution_epoch,
                submission.fingerprint.clone(),
                submission.submission.clone(),
            )
        {
            return Err(Error::Conflict);
        }
    }
    Ok(())
}

type ExitProofExecutionRow = (i64, Option<String>, Option<String>, String, String);
type StoredExitProofRow = (
    String,
    i64,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    String,
);

pub(crate) fn record_verified_exit_proof(
    transaction: &Transaction<'_>,
    proof: &VerifiedExitProof,
) -> Result<()> {
    if !valid_digest(&proof.config_digest) || !valid_digest(&proof.evidence_digest) {
        return Err(Error::Invalid("invalid exit proof digest".into()));
    }
    let identity: Option<ExitProofExecutionRow> = transaction
        .query_row(
            "SELECT execution_epoch,host_id,host_epoch,config_digest,state FROM orch_executions WHERE attempt_id=?1",
            [&proof.attempt_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    let Some((epoch, host_id, host_epoch, digest, state)) = identity else {
        return Err(Error::NotFound);
    };
    if epoch as u64 != proof.execution_epoch
        || host_id.as_deref() != proof.host.as_ref().map(|host| host.host_id.as_str())
        || host_epoch.as_deref() != proof.host.as_ref().map(|host| host.host_epoch.as_str())
        || digest != proof.config_digest
    {
        return Err(Error::Conflict);
    }
    let valid_pair = match (proof.kind, proof.verifier) {
        (ExitProofKind::HostProcessExit, ExitProofVerifier::ExecutionHost)
        | (ExitProofKind::DriverQuiescence, ExitProofVerifier::Driver)
        | (ExitProofKind::RegisteredResourceRelease, ExitProofVerifier::ResourceHandler) => true,
        (ExitProofKind::StartupNotStarted, ExitProofVerifier::StartupCoordinator) => {
            matches!(state.as_str(), "planned" | "starting")
                || transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM orch_exit_proofs WHERE id=?1)",
                    [&proof.proof_id],
                    |row| row.get::<_, bool>(0),
                )?
        }
        _ => false,
    };
    if !valid_pair {
        return Err(Error::Conflict);
    }
    let existing: Option<StoredExitProofRow> = transaction
        .query_row(
            "SELECT attempt_id,execution_epoch,host_id,host_epoch,config_digest,proof_kind,verifier,evidence_digest FROM orch_exit_proofs WHERE id=?1",
            [&proof.proof_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
        )
        .optional()?;
    let host_id = proof.host.as_ref().map(|host| host.host_id.clone());
    let host_epoch = proof.host.as_ref().map(|host| host.host_epoch.clone());
    if let Some(existing) = existing {
        if existing
            == (
                proof.attempt_id.clone(),
                sqlite_integer(proof.execution_epoch, "execution epoch")?,
                host_id,
                host_epoch,
                proof.config_digest.clone(),
                sql_label(proof.kind),
                sql_label(proof.verifier),
                proof.evidence_digest.clone(),
            )
        {
            return Ok(());
        }
        return Err(Error::Conflict);
    }
    transaction.execute(
        "INSERT INTO orch_exit_proofs(id,attempt_id,execution_epoch,host_id,host_epoch,config_digest,proof_kind,verifier,evidence_digest,verified_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![proof.proof_id, proof.attempt_id, sqlite_integer(proof.execution_epoch, "execution epoch")?, proof.host.as_ref().map(|host| host.host_id.as_str()), proof.host.as_ref().map(|host| host.host_epoch.as_str()), proof.config_digest, sql_label(proof.kind), sql_label(proof.verifier), proof.evidence_digest, proof.verified_at],
    )?;
    Ok(())
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn schedule_recovery(transaction: &Transaction<'_>, job: &NewRecoveryJob) -> Result<()> {
    transaction.execute(
        "INSERT INTO orch_recovery_jobs(job_id,kind,object_id,state,owner,next_check_at,revision,detail,created_at,updated_at) VALUES(?1,?2,?3,'pending',?4,?5,1,?6,?7,?7) ON CONFLICT(kind,object_id) DO UPDATE SET state='pending',next_check_at=excluded.next_check_at,revision=orch_recovery_jobs.revision+1,detail=excluded.detail,updated_at=excluded.updated_at",
        params![job.job_id, job.kind, job.object_id, job.owner, job.next_check_at, job.detail, job.created_at],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn transition_operation(
    transaction: &Transaction<'_>,
    operation_id: &str,
    expected_revision: u64,
    state: OperationState,
    effect_state: ControlEffectState,
    wait_reason: Option<WaitReason>,
    retry_after_ms: Option<u64>,
    next_reconcile_at: Option<i64>,
    result: Option<&str>,
    updated_at: i64,
) -> Result<u64> {
    let revision = sqlite_integer(expected_revision, "operation revision")?;
    let changed = transaction.execute(
        "UPDATE orch_operations_v2 SET state=?3,effect_state=?4,wait_reason=?5,retry_after_ms=?6,next_reconcile_at=?7,result=?8,revision=revision+1,updated_at=?9 WHERE operation_id=?1 AND revision=?2",
        params![
            operation_id,
            revision,
            sql_label(state),
            sql_label(effect_state),
            wait_reason.map(sql_label),
            retry_after_ms.map(|value| sqlite_integer(value, "retry-after")).transpose()?,
            next_reconcile_at,
            result,
            updated_at,
        ],
    )?;
    if changed == 0 {
        return Err(Error::Conflict);
    }
    Ok(expected_revision.saturating_add(1))
}

pub(crate) fn transition_execution(
    transaction: &Transaction<'_>,
    identity: &ExecutionIdentity,
    state: ExecutionState,
    proof: Option<&VerifiedExitProof>,
    updated_at: i64,
) -> Result<()> {
    if state.requires_exit_proof() {
        let proof = proof.ok_or(Error::Conflict)?;
        if proof.kind == ExitProofKind::RegisteredResourceRelease {
            return Err(Error::Conflict);
        }
        if proof.attempt_id != identity.attempt_id
            || proof.execution_epoch != identity.execution_epoch
            || proof.host != identity.host
            || proof.config_digest != identity.config_digest
        {
            return Err(Error::Conflict);
        }
        record_verified_exit_proof(transaction, proof)?;
    }
    let changed = transaction.execute(
        "UPDATE orch_executions SET state=?8,exit_proof_id=COALESCE(?9,exit_proof_id),updated_at=?10 WHERE attempt_id=?1 AND task_id=?2 AND dispatch_id IS ?3 AND execution_epoch=?4 AND host_id IS ?5 AND host_epoch IS ?6 AND config_digest=?7",
        params![
            identity.attempt_id,
            identity.task_id,
            identity.dispatch_id,
            sqlite_integer(identity.execution_epoch, "execution epoch")?,
            identity.host.as_ref().map(|host| host.host_id.as_str()),
            identity.host.as_ref().map(|host| host.host_epoch.as_str()),
            identity.config_digest,
            sql_label(state),
            proof.map(|proof| proof.proof_id.as_str()),
            updated_at,
        ],
    )?;
    if changed == 0 {
        return Err(Error::Conflict);
    }
    Ok(())
}

pub(crate) fn update_result_state(
    transaction: &Transaction<'_>,
    attempt_id: &str,
    execution_epoch: u64,
    result_state: ResultState,
    updated_at: i64,
) -> Result<()> {
    let changed = transaction.execute(
        "UPDATE orch_executions SET result_state=?3,updated_at=?4 WHERE attempt_id=?1 AND execution_epoch=?2",
        params![attempt_id, sqlite_integer(execution_epoch, "execution epoch")?, sql_label(result_state), updated_at],
    )?;
    if changed == 0 {
        return Err(Error::Conflict);
    }
    Ok(())
}

pub(crate) fn release_reservation(
    transaction: &Transaction<'_>,
    reservation_id: &str,
    proof_id: &str,
    updated_at: i64,
) -> Result<()> {
    let changed = transaction.execute(
        "UPDATE orch_resource_reservations SET state='released',release_proof_id=?2,updated_at=?3 WHERE reservation_id=?1 AND EXISTS(SELECT 1 FROM orch_exit_proofs p WHERE p.id=?2 AND p.attempt_id=orch_resource_reservations.attempt_id)",
        params![reservation_id, proof_id, updated_at],
    )?;
    if changed == 0 {
        return Err(Error::Conflict);
    }
    Ok(())
}

fn sql_label(value: impl Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(|label| label.to_ascii_lowercase()))
        .unwrap_or_default()
}

fn parse_operation_state(value: &str) -> Result<OperationState> {
    match value {
        "accepted" => Ok(OperationState::Accepted),
        "running" => Ok(OperationState::Running),
        "waiting" => Ok(OperationState::Waiting),
        "succeeded" => Ok(OperationState::Succeeded),
        "failed" => Ok(OperationState::Failed),
        "cancelled" => Ok(OperationState::Cancelled),
        "outcome_unknown" => Ok(OperationState::OutcomeUnknown),
        _ => Err(Error::Schema),
    }
}

fn valid_command_receipt_transition(current: &str, next: &str) -> bool {
    if current == next {
        return true;
    }
    match current {
        "pending" => matches!(next, "sent" | "received" | "unknown" | "rejected"),
        "sent" => matches!(next, "received" | "completed" | "unknown" | "rejected"),
        "received" => matches!(next, "completed" | "unknown" | "rejected"),
        "unknown" => matches!(next, "received" | "completed" | "rejected"),
        _ => false,
    }
}

fn parse_effect_state(value: &str) -> Result<ControlEffectState> {
    match value {
        "none" => Ok(ControlEffectState::None),
        "received" => Ok(ControlEffectState::Received),
        "delivered" => Ok(ControlEffectState::Delivered),
        "unknown" => Ok(ControlEffectState::Unknown),
        "failed" => Ok(ControlEffectState::Failed),
        _ => Err(Error::Schema),
    }
}

fn parse_wait_reason(value: &str) -> Result<WaitReason> {
    match value {
        "account_throttled" => Ok(WaitReason::AccountThrottled),
        "host_pressure" => Ok(WaitReason::HostPressure),
        "start_queue_full" => Ok(WaitReason::StartQueueFull),
        "dependency_blocked" => Ok(WaitReason::DependencyBlocked),
        "waiting_input" => Ok(WaitReason::WaitingInput),
        "owner_unreachable" => Ok(WaitReason::OwnerUnreachable),
        "config_invalid" => Ok(WaitReason::ConfigInvalid),
        "host_incompatible" => Ok(WaitReason::HostIncompatible),
        "storage_unavailable" => Ok(WaitReason::StorageUnavailable),
        "manual_required" => Ok(WaitReason::ManualRequired),
        _ => Err(Error::Schema),
    }
}

fn parse_execution_state(value: &str) -> Result<ExecutionState> {
    match value {
        "planned" => Ok(ExecutionState::Planned),
        "starting" => Ok(ExecutionState::Starting),
        "running" => Ok(ExecutionState::Running),
        "waiting_input" => Ok(ExecutionState::WaitingInput),
        "stop_requested" => Ok(ExecutionState::StopRequested),
        "stopping" => Ok(ExecutionState::Stopping),
        "start_unknown" => Ok(ExecutionState::StartUnknown),
        "stop_unknown" => Ok(ExecutionState::StopUnknown),
        "owner_unreachable" => Ok(ExecutionState::OwnerUnreachable),
        "manual_required" => Ok(ExecutionState::ManualRequired),
        "quiesced" => Ok(ExecutionState::Quiesced),
        "exit_confirmed" => Ok(ExecutionState::ExitConfirmed),
        "finalized" => Ok(ExecutionState::Finalized),
        _ => Err(Error::Schema),
    }
}

fn parse_result_state(value: &str) -> Result<ResultState> {
    match value {
        "none" => Ok(ResultState::None),
        "submitted" => Ok(ResultState::Submitted),
        "accepted" => Ok(ResultState::Accepted),
        "rejected" => Ok(ResultState::Rejected),
        _ => Err(Error::Schema),
    }
}

pub fn worker_start_operation_view(operation: &WorkerStartOperation) -> OperationView {
    let (state, wait_reason, effect_state) = match operation.phase {
        WorkerStartPhase::Queued => (
            OperationState::Waiting,
            Some(WaitReason::StartQueueFull),
            ControlEffectState::None,
        ),
        WorkerStartPhase::Preparing
        | WorkerStartPhase::WorktreeCreated
        | WorkerStartPhase::SessionCreated
        | WorkerStartPhase::DispatchCommitted
        | WorkerStartPhase::Delivering => (
            OperationState::Running,
            None,
            legacy_effect_state(operation.side_effect_state),
        ),
        WorkerStartPhase::DeliveryUnknown => (
            OperationState::OutcomeUnknown,
            Some(WaitReason::ManualRequired),
            ControlEffectState::Unknown,
        ),
        WorkerStartPhase::Running => (
            OperationState::Succeeded,
            None,
            ControlEffectState::Delivered,
        ),
        WorkerStartPhase::Failed => (
            OperationState::Failed,
            None,
            legacy_effect_state(operation.side_effect_state),
        ),
        WorkerStartPhase::Cancelled => (
            OperationState::Cancelled,
            None,
            legacy_effect_state(operation.side_effect_state),
        ),
    };
    OperationView {
        operation_id: operation.operation_id.clone(),
        kind: OperationKind::Start,
        state,
        task_id: Some(operation.task_id.clone()),
        attempt_id: None,
        execution_epoch: None,
        effect_state,
        wait_reason,
        retry_after_ms: operation.retry_after_ms,
        next_reconcile_at: None,
        revision: 1,
    }
}

fn legacy_effect_state(value: WorkerStartSideEffectState) -> ControlEffectState {
    match value {
        WorkerStartSideEffectState::None => ControlEffectState::None,
        WorkerStartSideEffectState::Committed => ControlEffectState::Delivered,
        WorkerStartSideEffectState::Unknown => ControlEffectState::Unknown,
    }
}

impl Store {
    pub(crate) fn reliability_transaction<T>(
        &mut self,
        operation: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T>,
    ) -> Result<T> {
        let transaction = self.connection.transaction()?;
        let result = operation(&transaction)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn get_reliability_operation(&self, operation_id: &str) -> Result<OperationView> {
        let operation = self.connection.query_row(
            "SELECT kind,state,task_id,attempt_id,execution_epoch,effect_state,wait_reason,retry_after_ms,next_reconcile_at,revision FROM orch_operations_v2 WHERE operation_id=?1",
            [operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            },
        ).optional()?.ok_or(Error::NotFound)?;
        build_operation_view(operation_id, operation)
    }

    pub(crate) fn get_operation_in_transaction(
        transaction: &Transaction<'_>,
        operation_id: &str,
    ) -> Result<OperationView> {
        let operation = transaction.query_row(
            "SELECT kind,state,task_id,attempt_id,execution_epoch,effect_state,wait_reason,retry_after_ms,next_reconcile_at,revision FROM orch_operations_v2 WHERE operation_id=?1",
            [operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            },
        ).optional()?.ok_or(Error::NotFound)?;
        build_operation_view(operation_id, operation)
    }

    pub fn get_reliability_execution(&self, attempt_id: &str) -> Result<ExecutionRecord> {
        read_execution(&self.connection, attempt_id)
    }
    pub(crate) fn get_execution_in_transaction(
        transaction: &Transaction<'_>,
        attempt_id: &str,
    ) -> Result<ExecutionRecord> {
        read_execution(transaction, attempt_id)
    }
}

fn read_execution(connection: &rusqlite::Connection, attempt_id: &str) -> Result<ExecutionRecord> {
    let row = connection.query_row(
            "SELECT task_id,dispatch_id,execution_epoch,host_id,host_epoch,config_digest,state,result_state,stop_generation,exit_proof_id,created_at,updated_at FROM orch_executions WHERE attempt_id=?1",
            [attempt_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                ))
            },
        ).optional()?.ok_or(Error::NotFound)?;
    let (
        task_id,
        dispatch_id,
        execution_epoch,
        host_id,
        host_epoch,
        config_digest,
        state,
        result_state,
        stop_generation,
        exit_proof_id,
        created_at,
        updated_at,
    ) = row;
    let host = match (host_id, host_epoch) {
        (Some(host_id), Some(host_epoch)) => Some(HostIdentity {
            host_id,
            host_epoch,
        }),
        (None, None) => None,
        _ => return Err(Error::Schema),
    };
    Ok(ExecutionRecord {
        identity: ExecutionIdentity {
            task_id,
            dispatch_id,
            attempt_id: attempt_id.to_owned(),
            execution_epoch: execution_epoch as u64,
            host,
            config_digest,
        },
        state: parse_execution_state(&state)?,
        result_state: parse_result_state(&result_state)?,
        stop_generation: stop_generation as u64,
        exit_proof_id,
        created_at,
        updated_at,
    })
}

type OperationViewRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    String,
    Option<String>,
    Option<i64>,
    Option<i64>,
    i64,
);

fn build_operation_view(operation_id: &str, operation: OperationViewRow) -> Result<OperationView> {
    Ok(OperationView {
        operation_id: operation_id.to_owned(),
        kind: parse_operation_kind(&operation.0)?,
        state: parse_operation_state(&operation.1)?,
        task_id: operation.2,
        attempt_id: operation.3,
        execution_epoch: operation.4.map(|value| value as u64),
        effect_state: parse_effect_state(&operation.5)?,
        wait_reason: operation
            .6
            .map(|value| parse_wait_reason(&value))
            .transpose()?,
        retry_after_ms: operation.7.map(|value| value as u64),
        next_reconcile_at: operation.8,
        revision: operation.9 as u64,
    })
}

fn parse_operation_kind(value: &str) -> Result<OperationKind> {
    match value {
        "start" => Ok(OperationKind::Start),
        "stop" => Ok(OperationKind::Stop),
        "message" => Ok(OperationKind::Message),
        "result" => Ok(OperationKind::Result),
        "interaction_reply" => Ok(OperationKind::InteractionReply),
        "reconcile" => Ok(OperationKind::Reconcile),
        _ => Err(Error::Schema),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::WorkerStartSideEffectState;
    use crate::protocol::AgentKind;
    use serde_json::json;

    #[test]
    fn operation_fingerprint_is_canonical_and_versioned() {
        let left = json!({"first": 1, "second": {"a": true, "b": false}});
        let right = json!({"second": {"b": false, "a": true}, "first": 1});
        assert_eq!(
            request_fingerprint(OperationKind::Stop, 1, &left),
            request_fingerprint(OperationKind::Stop, 1, &right)
        );
        assert_ne!(
            request_fingerprint(OperationKind::Stop, 1, &left),
            request_fingerprint(OperationKind::Stop, 2, &left)
        );
        assert_ne!(
            request_fingerprint(OperationKind::Stop, 1, &left),
            request_fingerprint(OperationKind::Message, 1, &left)
        );
    }

    #[test]
    fn operation_protocol_uses_stable_wire_enum_spelling() {
        assert_eq!(
            serde_json::to_string(&OperationKind::Stop).unwrap(),
            "\"stop\""
        );
        assert_eq!(
            serde_json::to_string(&OperationState::OutcomeUnknown).unwrap(),
            "\"OUTCOME_UNKNOWN\""
        );
        assert_eq!(
            serde_json::to_string(&ExecutionState::OwnerUnreachable).unwrap(),
            "\"OWNER_UNREACHABLE\""
        );
    }

    #[test]
    fn legacy_start_unknown_mapping_does_not_invent_reconcile_schedule() {
        let legacy = WorkerStartOperation {
            operation_id: "legacy-op".into(),
            phase: WorkerStartPhase::DeliveryUnknown,
            task_id: "task".into(),
            run_id: "run".into(),
            agent: AgentKind::Claude,
            account_id: None,
            worktree_path: None,
            asset_id: None,
            session_id: None,
            dispatch_id: None,
            outcome: None,
            error: None,
            error_code: None,
            side_effect_state: WorkerStartSideEffectState::Unknown,
            side_effect_committed: None,
            retry_after_ms: None,
            created_at: 1,
            updated_at: 2,
        };
        let view = worker_start_operation_view(&legacy);
        assert_eq!(view.state, OperationState::OutcomeUnknown);
        assert_eq!(view.effect_state, ControlEffectState::Unknown);
        assert_eq!(view.wait_reason, Some(WaitReason::ManualRequired));
        assert_eq!(view.next_reconcile_at, None);
    }

    #[test]
    fn invalid_database_integer_does_not_saturate() {
        assert_eq!(
            sqlite_integer(9_007_199_254_740_991, "value").unwrap(),
            9_007_199_254_740_991
        );
        assert!(sqlite_integer(9_007_199_254_740_992, "value").is_err());
    }

    #[test]
    fn operation_and_command_receipts_are_idempotent_and_monotonic() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let run = store
            .create_run_graph(crate::orchestration::CreateRunGraph {
                objective: "reliability contract".into(),
                nodes: vec![crate::orchestration::GraphNodeInput {
                    client_id: "task".into(),
                    title: "task".into(),
                    spec: "test".into(),
                    skills: vec![],
                    deps: vec![],
                    parent_id: None,
                }],
                coordinator_session_id: None,
                operation_id: "contract-run".into(),
            })
            .unwrap();
        let task_id = run.id_map["task"].clone();
        let host = HostIdentity {
            host_id: "host-one".into(),
            host_epoch: "host-epoch-one".into(),
        };
        let digest = "a".repeat(64);
        store
            .connection
            .execute(
                "INSERT INTO orch_host_registry(host_id,host_epoch,protocol_version,runtime_digest,capabilities,registered_at,state) VALUES(?1,?2,1,?3,'[]',1,'active')",
                params![host.host_id, host.host_epoch, digest],
            )
            .unwrap();
        let request = json!({"attemptId":"attempt-one"});
        let operation = OperationView {
            operation_id: "operation-one".into(),
            kind: OperationKind::Stop,
            state: OperationState::Accepted,
            task_id: Some(task_id.clone()),
            attempt_id: Some("attempt-one".into()),
            execution_epoch: Some(1),
            effect_state: ControlEffectState::None,
            wait_reason: None,
            retry_after_ms: None,
            next_reconcile_at: None,
            revision: 1,
        };
        let input = NewOperation {
            operation: operation.clone(),
            request_version: 1,
            fingerprint: request_fingerprint(OperationKind::Stop, 1, &request),
            request: request.to_string(),
            created_at: 1,
        };
        let identity = ExecutionIdentity {
            task_id: task_id.clone(),
            dispatch_id: None,
            attempt_id: "attempt-one".into(),
            execution_epoch: 1,
            host: Some(host),
            config_digest: digest,
        };
        store
            .reliability_transaction(|transaction| {
                insert_execution(
                    transaction,
                    &NewExecution {
                        identity: identity.clone(),
                        state: ExecutionState::Running,
                        created_at: 2,
                    },
                )?;
                assert_eq!(accept_operation(transaction, &input)?, operation);
                assert_eq!(accept_operation(transaction, &input)?, operation);
                let mut command = HostCommand {
                    command_id: "command-one".into(),
                    operation_id: operation.operation_id.clone(),
                    identity: identity.clone(),
                    kind: HostCommandKind::Stop,
                    fingerprint: String::new(),
                    payload: "{\"request\":\"stop\"}".into(),
                };
                command.fingerprint = host_command_fingerprint(&command)?;
                enqueue_command(transaction, &command, 3)?;
                enqueue_command(transaction, &command, 4)?;
                let received = CommandReceipt {
                    command_id: command.command_id.clone(),
                    identity: identity.clone(),
                    state: HostCommandState::Received,
                    effect_state: ControlEffectState::Received,
                    receipt: Some("received".into()),
                };
                record_command_receipt(transaction, &received, 5)?;
                record_command_receipt(transaction, &received, 6)?;
                let completed = CommandReceipt {
                    state: HostCommandState::Completed,
                    effect_state: ControlEffectState::Delivered,
                    receipt: Some("completed".into()),
                    ..received.clone()
                };
                record_command_receipt(transaction, &completed, 7)?;
                record_command_receipt(transaction, &completed, 8)?;
                assert!(matches!(
                    record_command_receipt(transaction, &received, 9),
                    Err(Error::Conflict)
                ));
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store
                .get_reliability_execution("attempt-one")
                .unwrap()
                .state,
            ExecutionState::Running
        );
    }
}
