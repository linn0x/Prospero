use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rusqlite::OptionalExtension;
use rusqlite::params;

use crate::database::{Store, now, validate_id};
use crate::error::{Error, Result};
use crate::execution_host::launcher::HostHandle;
use crate::orchestration::reliability::{
    CommandReceipt, ControlEffectState, ExecutionIdentity, ExecutionState, HostCommand,
    HostCommandKind, HostCommandState, HostIdentity, NewOperation, NewRecoveryJob,
    NewResultSubmission, OperationKind, OperationState, OperationView, WaitReason,
    accept_operation, enqueue_command, record_result_submission, result_submission_fingerprint,
    schedule_recovery, transition_execution, transition_operation, update_result_state,
};
use crate::worker::Database;

struct CommandTarget {
    command: HostCommand,
    runtime_digest: String,
    state: String,
}

pub fn hosted_workers_enabled() -> Result<bool> {
    match std::env::var("PROSPERO_EXECUTION_MODE").as_deref() {
        Ok("hosted") => {
            if !cfg!(unix) {
                return Err(Error::Invalid(
                    "execution Host is unsupported on this platform".into(),
                ));
            }
            Ok(true)
        }
        Ok("direct") | Err(std::env::VarError::NotPresent) => Ok(false),
        _ => Err(Error::Invalid(
            "PROSPERO_EXECUTION_MODE must be direct or hosted".into(),
        )),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn launch_hosted_worker(
    database: &Database,
    input: super::StartWorker,
    operation_id: &str,
    task: super::Task,
    workspace: String,
    asset: Option<super::WorktreeAsset>,
    prompt: String,
    auto_approve: bool,
) -> Result<super::WorkerStartOutcome> {
    let binary = host_binary()?;
    let runtime = runtime_digest(&binary)?;
    let session_id = super::start::worker_session_id(operation_id);
    let title = format!("worker {}", task.title)
        .chars()
        .take(200)
        .collect::<String>();
    let session = crate::agent::CreateAgentSession {
        agent: input.agent,
        title: title.clone(),
        workspace: workspace.clone(),
        auto_approve,
        mode: None,
        model: None,
        effort: None,
        agent_preset: None,
        account_id: None,
        resume: None,
    };
    let payload = serde_json::json!({"session":session,"prompt":prompt,"admission":{"runId":task.run_id,"pluginId":input.plugin_id,"profileId":input.profile_id}});
    let config = super::reliability::request_fingerprint(
        OperationKind::Start,
        1,
        &serde_json::json!({"payload":payload,"runtimeDigest":runtime}),
    );
    let plan = HostedWorkerPlan {
        operation_id: operation_id.to_owned(),
        task_id: task.id,
        payload,
        runtime_digest: runtime,
        config_digest: config,
        worktree_path: asset.as_ref().map(|asset| asset.path.clone()),
    };
    let session_text = session_id.clone();
    let settled = database
        .call_control("worker.hosted.accept", move |store| {
            let mut settled = None;
            store.create_session_with_id(
                crate::protocol::CreateSession {
                    agent: input.agent,
                    kind: crate::protocol::SessionKind::Structured,
                    title,
                    workspace,
                },
                Some(session_text),
                |tx, head| {
                    settled = Some(accept_hosted_worker_tx(tx, &head.id, &plan)?);
                    Ok(())
                },
            )?;
            settled.ok_or(Error::Closed)
        })
        .await?;
    Ok(super::WorkerStartOutcome {
        task: settled.task,
        dispatch: settled.dispatch,
        session_id,
        worktree: asset,
    })
}

struct HostedWorkerPlan {
    operation_id: String,
    task_id: String,
    payload: serde_json::Value,
    runtime_digest: String,
    config_digest: String,
    worktree_path: Option<String>,
}

fn accept_hosted_worker_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    plan: &HostedWorkerPlan,
) -> Result<super::SettleOutcome> {
    let id = &plan.operation_id;
    let changed=tx.execute("UPDATE orch_worker_starts SET session_id=?1,phase='session_created',updated_at=?2 WHERE operation_id=?3 AND task_id=?4 AND phase IN ('preparing','worktree_created')",params![session_id,now(),id,plan.task_id])?;
    if changed != 1 {
        return Err(Error::Conflict);
    }
    let settled = Store::commit_worker_start_dispatch_tx(
        tx,
        id,
        &plan.task_id,
        session_id,
        plan.worktree_path.as_deref(),
    )?;
    let epoch: i64 = tx.query_row(
        "SELECT COALESCE(MAX(execution_epoch),0)+1 FROM orch_executions WHERE task_id=?1",
        [&plan.task_id],
        |row| row.get(0),
    )?;
    let host = HostIdentity {
        host_id: stable_id("host", id),
        host_epoch: uuid::Uuid::new_v4().simple().to_string(),
    };
    tx.execute("INSERT INTO orch_host_registry(host_id,host_epoch,protocol_version,runtime_digest,capabilities,registered_at,state) VALUES(?1,?2,1,?3,'[]',?4,'active')",params![host.host_id,host.host_epoch,plan.runtime_digest,now()])?;
    let identity = ExecutionIdentity {
        task_id: plan.task_id.clone(),
        dispatch_id: Some(settled.dispatch.id.clone()),
        attempt_id: session_id.to_owned(),
        execution_epoch: epoch as u64,
        host: Some(host),
        config_digest: plan.config_digest.clone(),
    };
    super::reliability::insert_execution(
        tx,
        &super::reliability::NewExecution {
            identity: identity.clone(),
            state: ExecutionState::Planned,
            created_at: now(),
        },
    )?;
    let request = serde_json::json!({"identity":identity,"payload":plan.payload});
    let operation = NewOperation {
        operation: OperationView {
            operation_id: id.clone(),
            kind: OperationKind::Start,
            state: OperationState::Accepted,
            task_id: Some(identity.task_id.clone()),
            attempt_id: Some(identity.attempt_id.clone()),
            execution_epoch: Some(identity.execution_epoch),
            effect_state: ControlEffectState::None,
            wait_reason: None,
            retry_after_ms: Some(1000),
            next_reconcile_at: None,
            revision: 1,
        },
        request_version: 1,
        fingerprint: super::reliability::request_fingerprint(OperationKind::Start, 1, &request),
        request: request.to_string(),
        created_at: now(),
    };
    accept_operation(tx, &operation)?;
    let mut command = HostCommand {
        command_id: stable_id("command", id),
        operation_id: id.clone(),
        identity,
        kind: HostCommandKind::Start,
        fingerprint: String::new(),
        payload: plan.payload.to_string(),
    };
    command.fingerprint = super::reliability::host_command_fingerprint(&command)?;
    enqueue_command(tx, &command, now())?;
    schedule_recovery(
        tx,
        &NewRecoveryJob {
            job_id: stable_id("recovery", id),
            kind: "operation".into(),
            object_id: id.clone(),
            owner: "reliability-dispatcher".into(),
            next_check_at: now(),
            detail: None,
            created_at: now(),
        },
    )?;
    tx.execute(
        "UPDATE orch_worker_starts SET phase='delivering',updated_at=?2 WHERE operation_id=?1",
        params![id, now()],
    )?;
    Ok(settled)
}

pub async fn submit_operation(
    database: &Database,
    operation: NewOperation,
    mut command: HostCommand,
) -> Result<OperationView> {
    validate_id(&operation.operation.operation_id)?;
    validate_id(&command.command_id)?;
    let request_value: serde_json::Value = serde_json::from_str(&operation.request)?;
    let payload_value: serde_json::Value = serde_json::from_str(&command.payload)?;
    if request_value["identity"] != serde_json::to_value(&command.identity)?
        || request_value["payload"] != payload_value
    {
        return Err(Error::Conflict);
    }
    if command.fingerprint != super::reliability::host_command_fingerprint(&command)? {
        return Err(Error::Conflict);
    }
    if operation.operation.operation_id != command.operation_id
        || operation.operation.task_id.as_deref() != Some(command.identity.task_id.as_str())
        || operation.operation.attempt_id.as_deref() != Some(command.identity.attempt_id.as_str())
        || operation.operation.execution_epoch != Some(command.identity.execution_epoch)
        || operation.operation.kind != operation_kind_for_command(command.kind)
    {
        return Err(Error::Conflict);
    }
    let result_submission = if command.kind == HostCommandKind::Result {
        let request: serde_json::Value = serde_json::from_str(&command.payload)?;
        Some(NewResultSubmission {
            submission_id: operation.operation.operation_id.clone(),
            attempt_id: command.identity.attempt_id.clone(),
            execution_epoch: command.identity.execution_epoch,
            fingerprint: result_submission_fingerprint(&request)?,
            submission: command.payload.clone(),
            receipt: None,
            created_at: now(),
        })
    } else {
        None
    };
    let response = database
        .call_control("reliability.operation.accept", move |store| {
            store.reliability_transaction(|transaction| {
                let existed: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM orch_operations_v2 WHERE operation_id=?1)", [&operation.operation.operation_id], |row| row.get(0))?;
                let operation = accept_operation(transaction, &operation)?;
                if existed { return Ok(operation); }
                if matches!(command.kind,HostCommandKind::Stop|HostCommandKind::Send|HostCommandKind::Reconcile) {
                    let finalized:bool=transaction.query_row("SELECT e.state IN ('quiesced','exit_confirmed','finalized') OR COALESCE(h.state='retired',0) FROM orch_executions e LEFT JOIN orch_host_registry h ON h.host_id=e.host_id AND h.host_epoch=e.host_epoch WHERE e.attempt_id=?1",[&command.identity.attempt_id],|row|row.get(0))?;
                    if finalized {return Err(Error::Feature("execution_finalized".into(),"execution has finalized; use the existing operation ID to query or replay its receipt".into()));}
                }
                if let Some(submission) = &result_submission {
                    let rejected:i64=transaction.query_row("SELECT count(*) FROM orch_result_receipts WHERE attempt_id=?1 AND state='rejected'",[&submission.attempt_id],|row|row.get(0))?;
                    if rejected>=3{return Err(Error::Feature("result_validation_budget_exhausted".into(),"result corrections exhausted; stop the execution before retrying the task".into()));}
                    record_result_submission(transaction, submission)?;
                    transaction.execute("UPDATE orch_executions SET result_state='submitted',updated_at=?2 WHERE attempt_id=?1 AND result_state IN ('none','rejected')",params![submission.attempt_id,now()])?;
                }
                if command.kind==HostCommandKind::Stop {
                    let generation:i64=transaction.query_row("UPDATE orch_executions SET stop_generation=stop_generation+1,updated_at=?2 WHERE attempt_id=?1 RETURNING stop_generation",params![command.identity.attempt_id,now()],|row|row.get(0))?;
                    let mut payload:serde_json::Value=serde_json::from_str(&command.payload)?;
                    let object=payload.as_object_mut().ok_or_else(||Error::Invalid("stop payload must be an object".into()))?;
                    object.insert("stopGeneration".into(),generation.into());
                    command.payload=payload.to_string();
                    command.fingerprint=super::reliability::host_command_fingerprint(&command)?;
                    let closed:bool=transaction.query_row("SELECT state IN ('finalized','quiesced','exit_confirmed') FROM orch_executions WHERE attempt_id=?1",[&command.identity.attempt_id],|row|row.get(0))?;
                    if !closed {transition_execution(transaction,&command.identity,ExecutionState::StopRequested,None,now())?;}
                }
                if command.kind==HostCommandKind::Reconcile {
                    transaction.execute("UPDATE orch_recovery_jobs SET state='pending',next_check_at=?2,revision=revision+1,detail=CASE WHEN owner='execution-budget' AND json_valid(detail) THEN json_set(detail,'$.automaticAttempts',0) ELSE json_object('automaticAttempts',0) END,updated_at=?2 WHERE state='manual_required' AND (object_id=?1 OR (kind='operation' AND object_id IN (SELECT operation_id FROM orch_operations_v2 WHERE attempt_id=?1)))",params![command.identity.attempt_id,now()])?;
                    transaction.execute("UPDATE orch_operations_v2 SET wait_reason='owner_unreachable',retry_after_ms=1000,next_reconcile_at=?2,revision=revision+1,updated_at=?2 WHERE attempt_id=?1 AND state='outcome_unknown'",params![command.identity.attempt_id,now()])?;
                }
                let due = now().saturating_add(1_000);
                schedule_recovery(
                    transaction,
                    &NewRecoveryJob {
                        job_id: stable_id("recovery", &command.operation_id),
                        kind: "operation".into(),
                        object_id: command.operation_id.clone(),
                        owner: "reliability-dispatcher".into(),
                        next_check_at: due,
                        detail: None,
                        created_at: now(),
                    },
                )?;
                if command.kind!=HostCommandKind::Result {enqueue_command(transaction, &command, now())?;}
                if command.kind==HostCommandKind::Stop && cancel_planned_start_tx(transaction,&command)? {
                    return get_operation_tx(transaction,&command.operation_id);
                }
                Ok(operation)
            })
        })
        .await?;
    Ok(response)
}

pub(super) async fn quarantine_legacy_start(
    database: &Database,
    operation_id: &str,
    message: &str,
) -> Result<()> {
    let id = operation_id.to_owned();
    let message = message.chars().take(2048).collect::<String>();
    database.call_control("worker.start.quarantine",move|store|{
        let start=store.worker_start(&id)?;
        store.reliability_transaction(|tx|{
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orch_operations_v2 WHERE operation_id=?1)",[&id],|row|row.get(0))?;
            if exists{return Ok(());}
            let epoch:i64=tx.query_row("SELECT COALESCE(MAX(execution_epoch),0)+1 FROM orch_executions WHERE task_id=?1",[&start.task_id],|row|row.get(0))?;
            let attempt=super::start::worker_session_id(&id);
            let request=serde_json::json!({"legacyStartId":id,"taskId":start.task_id});
            let identity=ExecutionIdentity{task_id:start.task_id.clone(),dispatch_id:start.dispatch_id.clone(),attempt_id:attempt.clone(),execution_epoch:epoch as u64,host:None,config_digest:super::reliability::request_fingerprint(OperationKind::Start,1,&request)};
            schedule_recovery(tx,&NewRecoveryJob{job_id:stable_id("execution-recovery",&attempt),kind:"execution".into(),object_id:attempt.clone(),owner:"manual-legacy-cleanup".into(),next_check_at:now()+60_000,detail:Some(message.clone()),created_at:now()})?;
            super::reliability::insert_execution(tx,&super::reliability::NewExecution{identity:identity.clone(),state:ExecutionState::StartUnknown,created_at:now()})?;
            schedule_recovery(tx,&NewRecoveryJob{job_id:stable_id("recovery",&id),kind:"operation".into(),object_id:id.clone(),owner:"manual-legacy-cleanup".into(),next_check_at:now()+60_000,detail:Some(message.clone()),created_at:now()})?;
            let input=NewOperation{operation:OperationView{operation_id:id.clone(),kind:OperationKind::Start,state:OperationState::OutcomeUnknown,task_id:Some(start.task_id),attempt_id:Some(attempt.clone()),execution_epoch:Some(epoch as u64),effect_state:ControlEffectState::Unknown,wait_reason:Some(WaitReason::ManualRequired),retry_after_ms:None,next_reconcile_at:Some(now()+60_000),revision:1},request_version:1,fingerprint:super::reliability::request_fingerprint(OperationKind::Start,1,&request),request:request.to_string(),created_at:now()};
            accept_operation(tx,&input)?;
            tx.execute("INSERT INTO orch_resource_reservations(reservation_id,attempt_id,resource_kind,resource_scope,state,created_at,updated_at) VALUES(?1,?2,'execution','daemon','quarantined',?3,?3)",params![stable_id("legacy-capacity",&attempt),attempt,now()])?;
            tx.execute("UPDATE orch_recovery_jobs SET state='manual_required' WHERE owner='manual-legacy-cleanup' AND object_id IN (?1,?2)",params![id,identity.attempt_id])?;
            tx.execute("UPDATE orch_worker_starts SET phase='delivery_unknown',error_code='driver_exit_unknown',error=?2,updated_at=?3 WHERE operation_id=?1",params![id,message,now()])?;
            Ok(())
        })
    }).await
}

pub async fn get_execution(
    database: &Database,
    attempt_id: &str,
) -> Result<super::reliability::ExecutionRecord> {
    validate_id(attempt_id)?;
    let id = attempt_id.to_owned();
    database
        .read("reliability.execution.get", move |store| {
            store.get_reliability_execution(&id)
        })
        .await
}

pub async fn submit_execution_operation(
    database: &Database,
    attempt_id: &str,
    operation_id: &str,
    kind: OperationKind,
    payload: serde_json::Value,
) -> Result<OperationView> {
    validate_id(operation_id)?;
    validate_id(attempt_id)?;
    let attempt = attempt_id.to_owned();
    let execution = database
        .call_control("reliability.operation.execution", move |store| {
            store.get_reliability_execution(&attempt)
        })
        .await?;
    let command_kind = match kind {
        OperationKind::Stop => HostCommandKind::Stop,
        OperationKind::Message => HostCommandKind::Send,
        OperationKind::Result => HostCommandKind::Result,
        OperationKind::Reconcile => HostCommandKind::Reconcile,
        _ => return Err(Error::Invalid("unsupported execution operation".into())),
    };
    if kind == OperationKind::Reconcile
        && (!payload.is_object()
            || payload
                .as_object()
                .is_some_and(|object| object.keys().any(|key| key != "reason")))
    {
        return Err(Error::Invalid(
            "reconcile accepts only a reason and never accepts caller exit proofs".into(),
        ));
    }
    if execution.identity.host.is_none() {
        return Err(Error::Invalid(
            "legacy execution has no authenticated Host".into(),
        ));
    }
    let request = serde_json::json!({"identity":execution.identity,"payload":payload});
    let mut command = HostCommand {
        command_id: stable_id("command", operation_id),
        operation_id: operation_id.to_owned(),
        identity: execution.identity.clone(),
        kind: command_kind,
        fingerprint: String::new(),
        payload: serde_json::to_string(&payload)?,
    };
    command.fingerprint = super::reliability::host_command_fingerprint(&command)?;
    let operation = NewOperation {
        operation: OperationView {
            operation_id: operation_id.to_owned(),
            kind,
            state: OperationState::Accepted,
            task_id: Some(execution.identity.task_id),
            attempt_id: Some(attempt_id.to_owned()),
            execution_epoch: Some(execution.identity.execution_epoch),
            effect_state: ControlEffectState::None,
            wait_reason: None,
            retry_after_ms: Some(1000),
            next_reconcile_at: None,
            revision: 1,
        },
        request_version: 1,
        fingerprint: super::reliability::request_fingerprint(kind, 1, &request),
        request: serde_json::to_string(&request)?,
        created_at: now(),
    };
    submit_operation(database, operation, command).await
}

fn stable_id(prefix: &str, value: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}-{digest}")
}

pub async fn get_operation(database: &Database, operation_id: &str) -> Result<OperationView> {
    validate_id(operation_id)?;
    let id = operation_id.to_owned();
    match database
        .read("reliability.operation.get", move |store| {
            store.get_reliability_operation(&id)
        })
        .await
    {
        Ok(operation) => Ok(operation),
        Err(Error::NotFound) => {
            let id = operation_id.to_owned();
            let legacy = database
                .read("reliability.operation.get_legacy", move |store| {
                    store.worker_start(&id)
                })
                .await?;
            Ok(super::reliability::worker_start_operation_view(&legacy))
        }
        Err(error) => Err(error),
    }
}

pub async fn dispatch_outbox_once(
    database: &Database,
    data_dir: &Path,
    limit: usize,
) -> Result<usize> {
    let limit = limit.clamp(1, 4) as i64;
    settle_pending_results(database, limit as usize).await?;
    let commands = database
        .call_control("reliability.operation.outbox", move |store| {
            store.read_snapshot(|| {
                let mut statement = store.connection.prepare(
                "SELECT c.command_id,c.operation_id,c.command_kind,c.fingerprint,c.payload,e.task_id,e.dispatch_id,e.attempt_id,e.execution_epoch,e.host_id,e.host_epoch,e.config_digest,h.runtime_digest,c.state FROM orch_host_commands c JOIN orch_executions e ON e.attempt_id=c.attempt_id JOIN orch_host_registry h ON h.host_id=e.host_id AND h.host_epoch=e.host_epoch WHERE h.state IN ('active','unreachable') AND c.state IN ('pending','sent','received','unknown') AND EXISTS(SELECT 1 FROM orch_recovery_jobs j WHERE j.kind='operation' AND j.object_id=c.operation_id AND j.state='pending' AND j.next_check_at<=?2) ORDER BY CASE c.command_kind WHEN 'stop' THEN 0 WHEN 'result' THEN 1 ELSE 2 END,c.created_at LIMIT ?1",
                )?;
                let rows = statement.query_map(params![limit, now()], |row| {
                    let host_id: Option<String> = row.get(9)?;
                    let host_epoch: Option<String> = row.get(10)?;
                    let host = match (host_id, host_epoch) {
                        (Some(host_id), Some(host_epoch)) => Some(HostIdentity { host_id, host_epoch }),
                        _ => return Err(rusqlite::Error::InvalidQuery),
                    };
                    Ok(CommandTarget {
                        command: HostCommand {
                            command_id: row.get(0)?,
                            operation_id: row.get(1)?,
                            kind: parse_host_command_kind(&row.get::<_, String>(2)?)
                                .map_err(|_| rusqlite::Error::InvalidQuery)?,
                            fingerprint: row.get(3)?,
                            payload: row.get(4)?,
                            identity: ExecutionIdentity {
                                task_id: row.get(5)?,
                                dispatch_id: row.get(6)?,
                                attempt_id: row.get(7)?,
                                execution_epoch: row.get::<_, i64>(8)? as u64,
                                host,
                                config_digest: row.get(11)?,
                            },
                        },
                        runtime_digest: row.get(12)?,
                        state: row.get(13)?,
                    })
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(Error::from)
            })
        })
        .await?;
    use futures_util::{StreamExt, stream};
    let count = commands.len();
    let outcomes = stream::iter(commands)
        .map(|target| async move {
            let command = target.command.clone();
            let may_have_sent = AtomicBool::new(target.state != "pending");
            let receipt = tokio::time::timeout(
                Duration::from_secs(5),
                deliver_command(database, data_dir, target, &may_have_sent),
            )
            .await
            .unwrap_or(Err(Error::Timeout));
            let receipt = classify_delivery_result(
                command.kind,
                may_have_sent.load(Ordering::Acquire),
                receipt,
            );
            match persist_host_result(database, command.clone(), receipt).await {
                Ok(()) => Ok(()),
                Err(error) => {
                    defer_reconciliation_failure(database, &command, &error).await?;
                    Err(error)
                }
            }
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
    for outcome in outcomes {
        if let Err(error) = outcome {
            eprintln!("Host command reconciliation failed: {error}");
        }
    }
    settle_pending_results(database, limit as usize).await?;
    release_pending_budgets(database, 1).await?;
    archive_finalized_sessions(database).await?;
    Ok(count)
}

async fn defer_reconciliation_failure(
    database: &Database,
    command: &HostCommand,
    error: &Error,
) -> Result<()> {
    let id = command.operation_id.clone();
    let public = error.public();
    let diagnostic = serde_json::json!({"code":public.code,"message":public.message.chars().take(2048).collect::<String>()});
    database.call_control("reliability.receipt.defer",move|store|store.reliability_transaction(|tx|{
        let operation=get_operation_tx(tx,&id)?;
        if matches!(operation.state,OperationState::Succeeded|OperationState::Failed|OperationState::Cancelled){return Ok(());}
        let checks:i64=tx.query_row("SELECT CASE WHEN json_valid(detail) THEN COALESCE(json_extract(detail,'$.automaticAttempts'),0) ELSE revision-1 END FROM orch_recovery_jobs WHERE kind='operation' AND object_id=?1",[&id],|row|row.get(0))?;
        let attempts=checks.saturating_add(1);
        let next=now().saturating_add(1000_i64.saturating_mul(1_i64<<attempts.clamp(0,6)));
        tx.execute("UPDATE orch_recovery_jobs SET state=?2,next_check_at=?3,revision=revision+1,detail=?4,updated_at=?5 WHERE kind='operation' AND object_id=?1",params![id,if attempts>=8{"manual_required"}else{"pending"},next,serde_json::json!({"automaticAttempts":attempts,"error":diagnostic}).to_string(),now()])?;
        transition_operation(tx,&id,operation.revision,OperationState::OutcomeUnknown,ControlEffectState::Unknown,Some(if attempts>=8{WaitReason::ManualRequired}else{WaitReason::OwnerUnreachable}),Some((next-now()).max(0) as u64),Some(next),None,now())?;
        Ok(())
    })).await
}

async fn deliver_command(
    database: &Database,
    data_dir: &Path,
    target: CommandTarget,
    may_have_sent: &AtomicBool,
) -> Result<CommandReceipt> {
    if target.state != "pending" {
        let host = target
            .command
            .identity
            .host
            .as_ref()
            .ok_or(Error::Conflict)?;
        if let Ok(handle) = HostHandle::open(data_dir, host) {
            if handle.manifest.runtime_digest != target.runtime_digest {
                return Err(Error::Conflict);
            }
            let client = handle.client()?;
            match client.command_detail(&target.command.command_id).await {
                Ok(detail) => {
                    if serde_json::to_string(&detail.command)?
                        != serde_json::to_string(&target.command)?
                    {
                        return Err(Error::Conflict);
                    }
                    validate_receipt_identity(&target.command, &detail.receipt)?;
                    return Ok(detail.receipt);
                }
                Err(error) if error.to_string().starts_with("NOT_FOUND:") => {
                    may_have_sent.store(false, Ordering::Release);
                }
                Err(error) => return Err(Error::Invalid(error.to_string())),
            }
        }
    }
    if target.command.kind == HostCommandKind::Start {
        let command = target.command.clone();
        database
            .call_control("reliability.start.admit", move |store| {
                store.reliability_transaction(|tx| reserve_start_tx(tx, &command))
            })
            .await?;
    }
    if target.command.kind == HostCommandKind::Start {
        let budget = tokio::time::timeout(Duration::from_secs(2), shared_budget())
            .await
            .map_err(|_| {
                Error::Feature(
                    "execution_capacity".into(),
                    "shared execution budget handshake timed out".into(),
                )
            })?
            .map_err(|error| {
                Error::Feature(
                    "execution_capacity".into(),
                    format!("shared execution budget unavailable: {error}"),
                )
            })?;
        let daemon_id = stable_id("daemon", &data_dir.to_string_lossy());
        let decision = tokio::time::timeout(
            Duration::from_secs(1),
            budget.reserve(target.command.identity.clone(), daemon_id),
        )
        .await
        .map_err(|_| {
            Error::Feature(
                "execution_capacity".into(),
                "shared execution budget reservation is pending".into(),
            )
        })?
        .map_err(|error| Error::Feature("execution_capacity".into(), error.to_string()))?;
        if !matches!(
            decision,
            crate::execution_budget::BudgetDecision::Granted(_)
        ) {
            return Err(Error::Feature(
                "execution_capacity".into(),
                "shared execution budget is full".into(),
            ));
        }
    }
    let host = target
        .command
        .identity
        .host
        .as_ref()
        .ok_or(Error::Conflict)?;
    let handle = match HostHandle::open(data_dir, host) {
        Ok(handle) => handle,
        Err(Error::Io(error))
            if error.kind() == std::io::ErrorKind::NotFound
                && matches!(
                    target.command.kind,
                    HostCommandKind::Start | HostCommandKind::Stop
                ) =>
        {
            let binary = host_binary()?;
            if runtime_digest(&binary)? != target.runtime_digest {
                return Err(Error::Conflict);
            }
            crate::execution_host::launcher::ensure_host(data_dir, &binary, host.clone()).await?
        }
        Err(error) => return Err(error),
    };
    if handle.manifest.runtime_digest != target.runtime_digest {
        return Err(Error::Conflict);
    }
    let client = handle.client()?;
    if target.state != "pending" {
        match client.command_detail(&target.command.command_id).await {
            Ok(detail) => {
                if serde_json::to_string(&detail.command)?
                    != serde_json::to_string(&target.command)?
                {
                    return Err(Error::Conflict);
                }
                validate_receipt_identity(&target.command, &detail.receipt)?;
                return Ok(detail.receipt);
            }
            Err(error) if error.to_string().starts_with("NOT_FOUND:") => {
                may_have_sent.store(false, Ordering::Release);
            }
            Err(error) => return Err(Error::Invalid(error.to_string())),
        }
    }
    let command = target.command.clone();
    database.call_control("reliability.command.sent", move |store| {
        let valid:bool=store.connection.query_row("SELECT EXISTS(SELECT 1 FROM orch_host_commands c JOIN orch_operations_v2 o ON o.operation_id=c.operation_id JOIN orch_executions e ON e.attempt_id=c.attempt_id WHERE c.command_id=?1 AND o.state NOT IN ('succeeded','failed','cancelled') AND (c.command_kind!='start' OR e.state NOT IN ('finalized','quiesced','exit_confirmed','stop_requested','stopping','stop_unknown')))",[&command.command_id],|row|row.get(0))?;
        if !valid{return Err(Error::Feature("start_fenced".into(),"command superseded before Host delivery".into()));}
        store.connection.execute("UPDATE orch_host_commands SET state='sent',updated_at=?2 WHERE command_id=?1 AND state='pending'",params![command.command_id,now()])?;
        Ok(())
    }).await?;
    may_have_sent.store(true, Ordering::Release);
    let receipt = client
        .command(target.command.clone())
        .await
        .map_err(|error| Error::Invalid(error.to_string()))?;
    validate_receipt_identity(&target.command, &receipt)?;
    Ok(receipt)
}

fn classify_delivery_result(
    kind: HostCommandKind,
    may_have_sent: bool,
    receipt: Result<CommandReceipt>,
) -> Result<CommandReceipt> {
    match receipt {
        Err(error) if kind == HostCommandKind::Start && !may_have_sent => {
            if matches!(&error,Error::Feature(code,_) if code=="execution_capacity") {
                return Err(error);
            }
            let public = error.public();
            Err(Error::Feature(
                "host_preparation_wait".into(),
                format!("{}: {}", public.code, public.message),
            ))
        }
        receipt => receipt,
    }
}

fn reserve_start_tx(tx: &rusqlite::Transaction<'_>, command: &HostCommand) -> Result<()> {
    use super::reliability_admission::{
        AdmissionDecision, ResourceClaim, reserve_execution_resources_tx,
    };
    let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orch_executions e JOIN orch_tasks t ON t.id=e.task_id JOIN orch_runs r ON r.id=t.run_id JOIN orch_dispatches d ON d.id=e.dispatch_id WHERE e.attempt_id=?1 AND r.status='active' AND t.status='dispatched' AND d.state IN ('starting','running') AND e.state NOT IN ('finalized','quiesced','exit_confirmed','stop_requested','stopping','stop_unknown') AND NOT EXISTS(SELECT 1 FROM orch_task_deps deps JOIN orch_tasks upstream ON upstream.id=deps.dep_id WHERE deps.task_id=t.id AND (upstream.status!='done' OR EXISTS(SELECT 1 FROM orch_executions conflict WHERE conflict.task_id=upstream.id AND conflict.state!='finalized'))))",[&command.identity.attempt_id],|row|row.get(0))?;
    if !valid {
        return Err(Error::Feature(
            "start_fenced".into(),
            "task or dependency changed before Host dispatch".into(),
        ));
    }
    let payload: serde_json::Value = serde_json::from_str(&command.payload)?;
    let limits = super::start::worker_start_limits();
    let mut claims = vec![
        ResourceClaim {
            kind: "execution".into(),
            scope: "daemon".into(),
            limit: limits.global as u32,
        },
        ResourceClaim {
            kind: "backend".into(),
            scope: payload["session"]["agent"]
                .as_str()
                .unwrap_or("unknown")
                .into(),
            limit: limits.agent as u32,
        },
        ResourceClaim {
            kind: "account".into(),
            scope: format!(
                "native-{}",
                payload["session"]["agent"].as_str().unwrap_or("unknown")
            ),
            limit: limits.account as u32,
        },
        ResourceClaim {
            kind: "run".into(),
            scope: payload["admission"]["runId"]
                .as_str()
                .unwrap_or("unknown")
                .into(),
            limit: limits.run as u32,
        },
    ];
    for (key, kind, limit) in [
        ("pluginId", "plugin", limits.plugin),
        ("profileId", "profile", limits.profile),
    ] {
        if let Some(scope) = payload["admission"][key].as_str() {
            claims.push(ResourceClaim {
                kind: kind.into(),
                scope: scope.into(),
                limit: limit as u32,
            });
        }
    }
    match reserve_execution_resources_tx(tx, &command.identity.attempt_id, &claims)? {
        AdmissionDecision::Reserved => {
            let state: String = tx.query_row(
                "SELECT state FROM orch_executions WHERE attempt_id=?1",
                [&command.identity.attempt_id],
                |row| row.get(0),
            )?;
            if matches!(
                state.as_str(),
                "finalized" | "stop_requested" | "stopping" | "stop_unknown"
            ) {
                return Err(Error::Feature(
                    "start_fenced".into(),
                    "start superseded by stop".into(),
                ));
            }
            if state == "planned" {
                transition_execution(tx, &command.identity, ExecutionState::Starting, None, now())?;
            }
            Ok(())
        }
        AdmissionDecision::Waiting { .. } => Err(Error::Feature(
            "execution_capacity".into(),
            "waiting for execution capacity".into(),
        )),
    }
}

async fn archive_finalized_sessions(database: &Database) -> Result<()> {
    database.call_control("reliability.execution.archive",|store|{
        let sessions={let mut statement=store.connection.prepare("SELECT d.session_id,t.status FROM orch_executions e JOIN orch_dispatches d ON d.id=e.dispatch_id JOIN orch_tasks t ON t.id=e.task_id JOIN session_heads h ON h.id=d.session_id WHERE e.host_id IS NOT NULL AND e.state='finalized' AND h.lifecycle='active' LIMIT 4")?;statement.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?};
        for (id,task_status) in sessions {
            let session=store.session(&id)?;
            store.update_session(&id,crate::protocol::UpdateSession{revision:session.revision,title:None,lifecycle:Some(crate::protocol::SessionLifecycle::Archived),status:Some(if task_status=="done"{crate::protocol::SessionStatus::Completed}else{crate::protocol::SessionStatus::Failed})})?;
        }
        Ok(())
    }).await
}

async fn shared_budget() -> std::io::Result<crate::execution_budget::BudgetClient> {
    let directory = crate::execution_budget::default_directory()?;
    let binary = std::env::var_os("PROSPERO_EXECUTION_BUDGET_BINARY")
        .map(std::path::PathBuf::from)
        .unwrap_or(std::env::current_exe()?.with_file_name("prospero-budget-host"));
    let capacity = std::env::var("PROSPERO_EXECUTION_BUDGET_CAPACITY")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(128);
    crate::execution_budget::ensure_budget(&directory, &binary, capacity).await
}

async fn release_pending_budgets(database: &Database, limit: usize) -> Result<()> {
    let pending=database.call_control("reliability.budget.recovery",move|store|{
        let mut statement=store.connection.prepare("SELECT object_id,detail,COALESCE(json_extract(detail,'$.automaticAttempts'),0) FROM orch_recovery_jobs WHERE kind='reservation' AND owner='execution-budget' AND state='pending' AND next_check_at<=?1 ORDER BY next_check_at LIMIT ?2")?;
        Ok(statement.query_map(params![now(),limit as i64],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }).await?;
    for (attempt, detail, revision) in pending {
        let payload: serde_json::Value = serde_json::from_str(&detail)?;
        let identity: ExecutionIdentity = serde_json::from_value(payload["identity"].clone())?;
        let proof: super::reliability::VerifiedExitProof =
            serde_json::from_value(payload["proof"].clone())?;
        let released = tokio::time::timeout(Duration::from_secs(1), async {
            let budget = crate::execution_budget::BudgetClient::from_environment()?;
            budget.release(identity, proof).await
        })
        .await
        .is_ok_and(|outcome| outcome.is_ok());
        database.call_control("reliability.budget.release",move|store|{
            let next=now().saturating_add(1000_i64.saturating_mul(1_i64<<revision.min(6)));
            store.connection.execute("UPDATE orch_recovery_jobs SET state=?2,next_check_at=?3,revision=revision+1,updated_at=?4,detail=json_set(detail,'$.automaticAttempts',?5) WHERE kind='reservation' AND object_id=?1 AND owner='execution-budget'",params![attempt,if released{"complete"}else if revision>=8{"manual_required"}else{"pending"},next,now(),revision+1])?;
            Ok(())
        }).await?;
    }
    Ok(())
}

fn host_binary() -> Result<std::path::PathBuf> {
    match std::env::var_os("PROSPERO_EXECUTION_HOST_BINARY") {
        Some(path) => Ok(path.into()),
        None => Ok(std::env::current_exe()?.with_file_name("prospero-execution-host")),
    }
}

fn runtime_digest(binary: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let metadata = std::fs::metadata(binary)?;
    if !metadata.is_file() || metadata.len() > 512 * 1024 * 1024 {
        return Err(Error::Invalid("invalid execution Host binary".into()));
    }
    Ok(Sha256::digest(std::fs::read(binary)?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub async fn run_outbox_dispatcher(
    database: Database,
    data_dir: std::path::PathBuf,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    let mut interval = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(1),
        Duration::from_millis(100),
    );
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return Ok(());
                }
            }
            _ = interval.tick() => {
                if let Err(error) = dispatch_outbox_once(&database, &data_dir, 32).await {
                    eprintln!("reliability outbox dispatch failed: {error}");
                }
            }
        }
    }
}

async fn persist_host_result(
    database: &Database,
    command: HostCommand,
    receipt: std::result::Result<CommandReceipt, Error>,
) -> Result<()> {
    let start_complete = command.kind == HostCommandKind::Start
        && receipt
            .as_ref()
            .is_ok_and(|receipt| receipt.state == HostCommandState::Completed);
    let start_operation = command.operation_id.clone();
    database.call_control("reliability.operation.reconcile", move |store| {
        store.reliability_transaction(|tx| {
            let operation = get_operation_tx(tx,&command.operation_id)?;
            if let Ok(receipt) = &receipt { super::reliability::record_command_receipt(tx,receipt,now())?; }
            if matches!(operation.state,OperationState::Succeeded|OperationState::Failed|OperationState::Cancelled) { return Ok(()); }
            let checks: i64 = tx.query_row("SELECT CASE WHEN json_valid(detail) THEN COALESCE(json_extract(detail,'$.automaticAttempts'),0) ELSE revision-1 END FROM orch_recovery_jobs WHERE kind='operation' AND object_id=?1",[&command.operation_id],|row|row.get(0)).optional()?.unwrap_or(0);
            let next = now().saturating_add((1000_i64.saturating_mul(1_i64 << checks.min(6))).min(60_000));
            let mut state = OperationState::Running;
            let mut effect = ControlEffectState::Unknown;
            let mut execution_state = None;
            let mut result = None;
            let capacity_wait=matches!(&receipt,Err(Error::Feature(code,_)) if code=="execution_capacity");
            let preparation_wait=matches!(&receipt,Err(Error::Feature(code,_)) if code=="host_preparation_wait");
            let known_wait=capacity_wait||preparation_wait;
            let error_detail=receipt.as_ref().err().map(|error|{let public=error.public();serde_json::json!({"code":public.code,"message":public.message.chars().take(2048).collect::<String>()})});
            match &receipt {
                Err(Error::Feature(code,_)) if matches!(code.as_str(),"execution_capacity"|"host_preparation_wait") => {state=OperationState::Waiting;effect=ControlEffectState::None;}
                Ok(receipt) => {
                    effect = receipt.effect_state;
                    result = receipt.receipt.as_deref();
                    match receipt.state {
                        HostCommandState::Completed if command.kind != HostCommandKind::Result => {
                            state = OperationState::Succeeded;
                            match command.kind {
                                HostCommandKind::Start => execution_state=Some(ExecutionState::Running),
                                HostCommandKind::Stop => {
                                    let proof: super::reliability::VerifiedExitProof = serde_json::from_str(receipt.receipt.as_deref().ok_or(Error::Conflict)?)?;
                                    confirm_exit_tx(tx,&command.identity,&proof,Some(&command.operation_id))?;
                                }
                                _=>{}
                            }
                        }
                        HostCommandState::Received if command.kind==HostCommandKind::Send => {state=OperationState::Succeeded;}
                        HostCommandState::Rejected => { state=OperationState::Failed; }
                        HostCommandState::Unknown => { state=OperationState::OutcomeUnknown; }
                        _=>{}
                    }
                }
                Err(_) => {
                    tx.execute("UPDATE orch_host_commands SET state='unknown',effect_state='unknown',updated_at=?2 WHERE command_id=?1 AND state NOT IN ('completed','rejected')",params![command.command_id,now()])?;
                    state=OperationState::OutcomeUnknown;
                }
            }
            let pending = !matches!(state,OperationState::Succeeded|OperationState::Failed|OperationState::Cancelled);
            if pending {
                schedule_recovery(tx,&NewRecoveryJob { job_id:stable_id("recovery",&command.operation_id),kind:"operation".into(),object_id:command.operation_id.clone(),owner:"reliability-dispatcher".into(),next_check_at:next,detail:None,created_at:now() })?;
                tx.execute("UPDATE orch_recovery_jobs SET detail=?2 WHERE kind='operation' AND object_id=?1",params![command.operation_id,serde_json::json!({"automaticAttempts":checks+1,"error":error_detail}).to_string()])?;
            } else {
                tx.execute("UPDATE orch_recovery_jobs SET state='complete',revision=revision+1,updated_at=?2 WHERE kind='operation' AND object_id=?1",params![command.operation_id,now()])?;
            }
            if state == OperationState::OutcomeUnknown || (state == OperationState::Failed && matches!(command.kind,HostCommandKind::Start|HostCommandKind::Stop)) {
                schedule_recovery(tx,&NewRecoveryJob { job_id:stable_id("execution-recovery",&command.identity.attempt_id),kind:"execution".into(),object_id:command.identity.attempt_id.clone(),owner:"reliability-dispatcher".into(),next_check_at:next,detail:None,created_at:now() })?;
                execution_state=match command.kind { HostCommandKind::Start=>Some(ExecutionState::StartUnknown),HostCommandKind::Stop=>Some(ExecutionState::StopUnknown),_=>None };
                if state==OperationState::Failed {tx.execute("UPDATE orch_recovery_jobs SET state='manual_required',detail='Host rejected command; process state requires explicit reconciliation',updated_at=?2 WHERE kind='execution' AND object_id=?1",params![command.identity.attempt_id,now()])?;}
                tx.execute("UPDATE orch_resource_reservations SET state='quarantined',updated_at=?2 WHERE attempt_id=?1 AND state='held'",params![command.identity.attempt_id,now()])?;
            }
            if let Some(execution_state)=execution_state {
                let previous:String=tx.query_row("SELECT state FROM orch_executions WHERE attempt_id=?1",[&command.identity.attempt_id],|row|row.get(0))?;
                let closed=matches!(previous.as_str(),"quiesced"|"exit_confirmed"|"finalized");
                let late_start=matches!(execution_state,ExecutionState::Running|ExecutionState::Starting|ExecutionState::StartUnknown) && matches!(previous.as_str(),"stop_requested"|"stopping"|"stop_unknown");
                if !closed && !late_start { transition_execution(tx,&command.identity,execution_state,None,now())?; }
            }
            if checks>=8 && pending && !known_wait {state=OperationState::OutcomeUnknown;}
            let wait = if known_wait {Some(if preparation_wait && checks>=8 {WaitReason::ManualRequired}else{WaitReason::HostPressure})}else if state == OperationState::OutcomeUnknown { Some(if checks >= 8 {WaitReason::ManualRequired}else{WaitReason::OwnerUnreachable}) }else{None};
            if checks >= 8 && pending && !capacity_wait {
                tx.execute("UPDATE orch_recovery_jobs SET state='manual_required',detail=json_set(detail,'$.reason','automatic command reconciliation budget exhausted'),updated_at=?2 WHERE kind='operation' AND object_id=?1",params![command.operation_id,now()])?;
                tx.execute("UPDATE orch_recovery_jobs SET state='manual_required',detail='automatic execution reconciliation budget exhausted',updated_at=?2 WHERE kind='execution' AND object_id=?1",params![command.identity.attempt_id,now()])?;
            }
            transition_operation(tx,&command.operation_id,operation.revision,state,effect,wait,pending.then_some((next-now()).max(0) as u64),pending.then_some(next),result,now())?;
            Store::append_event(tx,"orchestration","execution.operation_updated",&command.operation_id,serde_json::json!({"attemptId":command.identity.attempt_id,"state":state,"effectState":effect}))?;
            Ok(())
        })
    }).await?;
    if start_complete {
        database
            .call_control("reliability.start.compat", move |store| {
                let operation = store.worker_start(&start_operation)?;
                if operation.phase == super::WorkerStartPhase::Delivering {
                    store.complete_worker_start(&start_operation)?;
                }
                Ok(())
            })
            .await?;
    }
    Ok(())
}

pub async fn confirm_execution_exit(
    database: &Database,
    identity: ExecutionIdentity,
    proof: super::reliability::VerifiedExitProof,
) -> Result<String> {
    database
        .call_control("reliability.execution.exit", move |store| {
            store.reliability_transaction(|tx| {
                confirm_exit_tx(tx, &identity, &proof, None)?;
                tx.query_row(
                    "SELECT run_id FROM orch_tasks WHERE id=?1",
                    [&identity.task_id],
                    |row| row.get(0),
                )
                .map_err(Error::from)
            })
        })
        .await
}

fn confirm_exit_tx(
    tx: &rusqlite::Transaction<'_>,
    identity: &ExecutionIdentity,
    proof: &super::reliability::VerifiedExitProof,
    exclude_operation: Option<&str>,
) -> Result<()> {
    let results = {
        let mut statement=tx.prepare("SELECT submission_id FROM orch_result_receipts WHERE attempt_id=?1 AND state IN ('received','submitted') ORDER BY created_at LIMIT 32")?;
        statement
            .query_map([&identity.attempt_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for id in results {
        settle_result_tx(tx, &id)?;
    }
    if let Some(dispatch_id) = &identity.dispatch_id {
        let active: bool = tx.query_row(
            "SELECT state IN ('starting','running') FROM orch_dispatches WHERE id=?1",
            [dispatch_id],
            |row| row.get(0),
        )?;
        if active {
            let stop:Option<String>=tx.query_row("SELECT payload FROM orch_host_commands WHERE attempt_id=?1 AND command_kind='stop' ORDER BY created_at DESC LIMIT 1",[&identity.attempt_id],|row|row.get(0)).optional()?;
            if let Some(stop) = stop {
                let stop: serde_json::Value = serde_json::from_str(&stop)?;
                let status = if stop["finalStatus"].as_str() == Some("cancelled") {
                    super::TaskStatus::Cancelled
                } else {
                    super::TaskStatus::Failed
                };
                Store::abandon_dispatch_tx(
                    tx,
                    dispatch_id,
                    stop["reason"]
                        .as_str()
                        .unwrap_or("execution stopped without explicit delivery"),
                    status,
                )?;
            }
        }
    }
    transition_execution(tx, identity, ExecutionState::Finalized, Some(proof), now())?;
    if identity.host.is_some() {
        schedule_recovery(
            tx,
            &NewRecoveryJob {
                job_id: stable_id("budget-release", &identity.attempt_id),
                kind: "reservation".into(),
                object_id: identity.attempt_id.clone(),
                owner: "execution-budget".into(),
                next_check_at: now(),
                detail: Some(serde_json::json!({"identity":identity,"proof":proof}).to_string()),
                created_at: now(),
            },
        )?;
    }
    let reservations = {
        let mut statement=tx.prepare("SELECT reservation_id FROM orch_resource_reservations WHERE attempt_id=?1 AND state IN ('held','quarantined')")?;
        statement
            .query_map([&identity.attempt_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for reservation in reservations {
        super::reliability::release_reservation(tx, &reservation, &proof.proof_id, now())?;
    }
    let stops = {
        let mut statement=tx.prepare("SELECT operation_id FROM orch_operations_v2 WHERE attempt_id=?1 AND kind='stop' AND state NOT IN ('succeeded','failed','cancelled') AND (?2 IS NULL OR operation_id!=?2)")?;
        statement
            .query_map(params![identity.attempt_id, exclude_operation], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for id in stops {
        let operation = get_operation_tx(tx, &id)?;
        transition_operation(
            tx,
            &id,
            operation.revision,
            OperationState::Succeeded,
            ControlEffectState::Delivered,
            None,
            None,
            None,
            Some(&serde_json::to_string(proof)?),
            now(),
        )?;
        tx.execute("UPDATE orch_recovery_jobs SET state='complete',revision=revision+1,updated_at=?2 WHERE kind='operation' AND object_id=?1",params![id,now()])?;
    }
    tx.execute("UPDATE orch_recovery_jobs SET state='complete',revision=revision+1,updated_at=?2 WHERE kind='execution' AND object_id=?1",params![identity.attempt_id,now()])?;
    Ok(())
}

pub async fn import_host_result(
    database: &Database,
    command: HostCommand,
) -> Result<OperationView> {
    if command.kind != HostCommandKind::Result {
        return Err(Error::Conflict);
    }
    let attempt = command.identity.attempt_id.clone();
    let execution = database
        .call_control("reliability.result.identity", move |store| {
            store.get_reliability_execution(&attempt)
        })
        .await?;
    if execution.identity != command.identity {
        return Err(Error::Conflict);
    }
    let payload: serde_json::Value = serde_json::from_str(&command.payload)?;
    let request_value = serde_json::json!({"identity":command.identity,"payload":payload});
    let request = serde_json::to_string(&request_value)?;
    let operation = NewOperation {
        operation: OperationView {
            operation_id: command.operation_id.clone(),
            kind: OperationKind::Result,
            state: OperationState::Accepted,
            task_id: Some(command.identity.task_id.clone()),
            attempt_id: Some(command.identity.attempt_id.clone()),
            execution_epoch: Some(command.identity.execution_epoch),
            effect_state: ControlEffectState::Received,
            wait_reason: None,
            retry_after_ms: Some(1000),
            next_reconcile_at: None,
            revision: 1,
        },
        request_version: 1,
        fingerprint: super::reliability::request_fingerprint(
            OperationKind::Result,
            1,
            &request_value,
        ),
        request,
        created_at: now(),
    };
    submit_operation(database, operation, command).await
}

async fn settle_pending_results(database: &Database, limit: usize) -> Result<()> {
    let ids=database.call_control("reliability.result.pending",move|store|{
        let mut statement=store.connection.prepare("SELECT submission_id FROM orch_result_receipts WHERE state IN ('received','submitted') ORDER BY created_at LIMIT ?1")?;
        Ok(statement.query_map([limit as i64],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }).await?;
    for id in ids {
        let outcome = database
            .call_control("reliability.result.validate", move |store| {
                store.reliability_transaction(|tx| settle_result_tx(tx, &id))
            })
            .await;
        if let Err(error) = outcome {
            eprintln!("result validation could not commit: {error}");
        }
    }
    Ok(())
}

fn settle_result_tx(tx: &rusqlite::Transaction<'_>, id: &str) -> Result<()> {
    let (attempt,epoch,submission):(String,u64,String)=tx.query_row("SELECT attempt_id,execution_epoch,submission FROM orch_result_receipts WHERE submission_id=?1 AND state IN ('received','submitted')",[id],|row|Ok((row.get(0)?,row.get::<_,i64>(1)? as u64,row.get(2)?)))?;
    let operation = get_operation_tx(tx, id)?;
    let dispatch: Option<String> = tx.query_row(
        "SELECT dispatch_id FROM orch_executions WHERE attempt_id=?1 AND execution_epoch=?2",
        params![attempt, epoch as i64],
        |row| row.get(0),
    )?;
    let parsed = serde_json::from_str::<super::SettleDispatch>(&submission);
    let settled = match (dispatch, parsed) {
        (Some(dispatch), Ok(payload)) => {
            Store::settle_dispatch_tx(tx, &dispatch, payload.success, &payload.outcome)
        }
        _ => Err(Error::Invalid(
            "result must bind a dispatch and contain success/outcome".into(),
        )),
    };
    let (state, result_state, receipt, effect) = match settled {
        Ok(settled) => (
            OperationState::Succeeded,
            super::reliability::ResultState::Accepted,
            serde_json::to_string(
                &serde_json::json!({"state":"ACCEPTED","task":settled.task,"dispatch":settled.dispatch}),
            )?,
            ControlEffectState::Delivered,
        ),
        Err(Error::Invalid(message)) => (
            OperationState::Failed,
            super::reliability::ResultState::Rejected,
            serde_json::json!({"state":"REJECTED","reason":message}).to_string(),
            ControlEffectState::Failed,
        ),
        Err(error) => return Err(error),
    };
    tx.execute(
        "UPDATE orch_result_receipts SET state=?2,receipt=?3,updated_at=?4 WHERE submission_id=?1",
        params![
            id,
            if result_state == super::reliability::ResultState::Accepted {
                "accepted"
            } else {
                "rejected"
            },
            receipt,
            now()
        ],
    )?;
    let existing: String = tx.query_row(
        "SELECT result_state FROM orch_executions WHERE attempt_id=?1",
        [&attempt],
        |row| row.get(0),
    )?;
    if !matches!(existing.as_str(), "accepted" | "rejected") {
        update_result_state(tx, &attempt, epoch, result_state, now())?;
    }
    transition_operation(
        tx,
        id,
        operation.revision,
        state,
        effect,
        None,
        None,
        None,
        Some(&receipt),
        now(),
    )?;
    tx.execute("UPDATE orch_recovery_jobs SET state='complete',revision=revision+1,updated_at=?2 WHERE kind='operation' AND object_id=?1",params![id,now()])?;
    if result_state == super::reliability::ResultState::Accepted {
        let request: String = tx.query_row(
            "SELECT request FROM orch_operations_v2 WHERE operation_id=?1",
            [id],
            |row| row.get(0),
        )?;
        let request: serde_json::Value = serde_json::from_str(&request)?;
        let identity: ExecutionIdentity = serde_json::from_value(request["identity"].clone())?;
        let closed:bool=tx.query_row("SELECT state IN ('quiesced','exit_confirmed','finalized') FROM orch_executions WHERE attempt_id=?1",[&attempt],|row|row.get(0))?;
        if !closed {
            enqueue_cleanup_stop(tx, &identity, id)?;
        }
    }
    Store::append_event(
        tx,
        "orchestration",
        "execution.result_receipt",
        id,
        serde_json::from_str(&receipt)?,
    )?;
    Ok(())
}

fn cancel_planned_start_tx(tx: &rusqlite::Transaction<'_>, stop: &HostCommand) -> Result<bool> {
    let start:Option<(String,String)>=tx.query_row("SELECT command_id,operation_id FROM orch_host_commands WHERE attempt_id=?1 AND command_kind='start' AND state='pending'",[&stop.identity.attempt_id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
    let Some((command_id, operation_id)) = start else {
        return Ok(false);
    };
    let proof = super::reliability::VerifiedExitProof {
        proof_id: stable_id("never-started", &stop.identity.attempt_id),
        attempt_id: stop.identity.attempt_id.clone(),
        execution_epoch: stop.identity.execution_epoch,
        host: stop.identity.host.clone(),
        config_digest: stop.identity.config_digest.clone(),
        kind: super::reliability::ExitProofKind::StartupNotStarted,
        verifier: super::reliability::ExitProofVerifier::StartupCoordinator,
        evidence_digest: super::reliability::request_fingerprint(
            OperationKind::Stop,
            1,
            &serde_json::json!({"startCommandId":command_id,"state":"pending"}),
        ),
        verified_at: now(),
    };
    tx.execute("UPDATE orch_executions SET state='planned',updated_at=?2 WHERE attempt_id=?1 AND state='stop_requested'",params![stop.identity.attempt_id,now()])?;
    confirm_exit_tx(tx, &stop.identity, &proof, Some(&stop.operation_id))?;
    tx.execute("UPDATE orch_host_commands SET state='rejected',effect_state='failed',receipt=?2,updated_at=?3 WHERE command_id=?1",params![command_id,"cancelled before start dispatch",now()])?;
    let original = get_operation_tx(tx, &operation_id)?;
    transition_operation(
        tx,
        &operation_id,
        original.revision,
        OperationState::Cancelled,
        ControlEffectState::None,
        None,
        None,
        None,
        None,
        now(),
    )?;
    tx.execute(
        "UPDATE orch_worker_starts SET phase='cancelled',updated_at=?2 WHERE operation_id=?1",
        params![operation_id, now()],
    )?;
    let receipt = CommandReceipt {
        command_id: stop.command_id.clone(),
        identity: stop.identity.clone(),
        state: HostCommandState::Rejected,
        effect_state: ControlEffectState::Failed,
        receipt: Some(serde_json::to_string(&proof)?),
    };
    super::reliability::record_command_receipt(tx, &receipt, now())?;
    let operation = get_operation_tx(tx, &stop.operation_id)?;
    transition_operation(
        tx,
        &stop.operation_id,
        operation.revision,
        OperationState::Succeeded,
        ControlEffectState::None,
        None,
        None,
        None,
        receipt.receipt.as_deref(),
        now(),
    )?;
    tx.execute("UPDATE orch_recovery_jobs SET state='complete',revision=revision+1,updated_at=?2 WHERE kind='operation' AND object_id IN (?1,?3)",params![stop.operation_id,now(),operation_id])?;
    Ok(true)
}

fn enqueue_cleanup_stop(
    tx: &rusqlite::Transaction<'_>,
    identity: &ExecutionIdentity,
    result_id: &str,
) -> Result<()> {
    let id = stable_id("result-stop", result_id);
    let generation:i64=tx.query_row("UPDATE orch_executions SET stop_generation=stop_generation+1,updated_at=?2 WHERE attempt_id=?1 RETURNING stop_generation",params![identity.attempt_id,now()],|row|row.get(0))?;
    let payload = serde_json::json!({"reason":"result accepted; execution cleanup","stopGeneration":generation});
    let request = serde_json::json!({"identity":identity,"payload":payload});
    let operation = NewOperation {
        operation: OperationView {
            operation_id: id.clone(),
            kind: OperationKind::Stop,
            state: OperationState::Accepted,
            task_id: Some(identity.task_id.clone()),
            attempt_id: Some(identity.attempt_id.clone()),
            execution_epoch: Some(identity.execution_epoch),
            effect_state: ControlEffectState::None,
            wait_reason: None,
            retry_after_ms: Some(1000),
            next_reconcile_at: None,
            revision: 1,
        },
        request_version: 1,
        fingerprint: super::reliability::request_fingerprint(OperationKind::Stop, 1, &request),
        request: serde_json::to_string(&request)?,
        created_at: now(),
    };
    accept_operation(tx, &operation)?;
    let mut command = HostCommand {
        command_id: stable_id("command", &id),
        operation_id: id.clone(),
        identity: identity.clone(),
        kind: HostCommandKind::Stop,
        fingerprint: String::new(),
        payload: payload.to_string(),
    };
    command.fingerprint = super::reliability::host_command_fingerprint(&command)?;
    enqueue_command(tx, &command, now())?;
    transition_execution(tx, identity, ExecutionState::StopRequested, None, now())?;
    schedule_recovery(
        tx,
        &NewRecoveryJob {
            job_id: stable_id("recovery", &id),
            kind: "operation".into(),
            object_id: id,
            owner: "reliability-dispatcher".into(),
            next_check_at: now(),
            detail: None,
            created_at: now(),
        },
    )?;
    Ok(())
}

fn get_operation_tx(
    transaction: &rusqlite::Transaction<'_>,
    operation_id: &str,
) -> Result<OperationView> {
    Store::get_operation_in_transaction(transaction, operation_id)
}

fn validate_receipt_identity(command: &HostCommand, receipt: &CommandReceipt) -> Result<()> {
    if receipt.command_id != command.command_id || receipt.identity != command.identity {
        return Err(Error::Conflict);
    }
    Ok(())
}

fn operation_kind_for_command(kind: HostCommandKind) -> OperationKind {
    match kind {
        HostCommandKind::Start => OperationKind::Start,
        HostCommandKind::Stop => OperationKind::Stop,
        HostCommandKind::Send => OperationKind::Message,
        HostCommandKind::Result => OperationKind::Result,
        HostCommandKind::InteractionReply => OperationKind::InteractionReply,
        HostCommandKind::Snapshot | HostCommandKind::Reconcile => OperationKind::Reconcile,
    }
}

fn parse_host_command_kind(value: &str) -> Result<HostCommandKind> {
    match value {
        "start" => Ok(HostCommandKind::Start),
        "stop" => Ok(HostCommandKind::Stop),
        "send" => Ok(HostCommandKind::Send),
        "result" => Ok(HostCommandKind::Result),
        "interaction_reply" => Ok(HostCommandKind::InteractionReply),
        "snapshot" => Ok(HostCommandKind::Snapshot),
        "reconcile" => Ok(HostCommandKind::Reconcile),
        _ => Err(Error::Schema),
    }
}

#[cfg(test)]
mod tests {
    use super::super::reliability::{
        ExitProofKind, ExitProofVerifier, NewExecution, VerifiedExitProof,
    };
    use super::*;
    use crate::orchestration::{CreateRun, CreateTask, TaskStatus};
    use serde_json::json;

    async fn fixture() -> (tempfile::TempDir, Database, ExecutionIdentity) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("data")).await.unwrap();
        let identity=database.call_control("test.reliability.fixture",|store|{
            let run=store.create_run(CreateRun{objective:"control contract".into(),coordinator_session_id:None})?;
            let task=store.create_task(CreateTask{run_id:run.id,title:"task".into(),spec:"explicit delivery".into(),skills:vec![],deps:vec![],parent_id:None})?;
            let session=store.create_session(crate::protocol::CreateSession{agent:crate::protocol::AgentKind::Claude,kind:crate::protocol::SessionKind::Structured,title:"fake worker".into(),workspace:"/tmp".into()})?;
            let dispatch=store.dispatch_task(&task.id,&session.id,None,None)?;
            let identity=ExecutionIdentity{task_id:task.id,dispatch_id:Some(dispatch.dispatch.id),attempt_id:"attempt-contract".into(),execution_epoch:1,host:Some(HostIdentity{host_id:"host-contract".into(),host_epoch:"epoch-contract".into()}),config_digest:"a".repeat(64)};
            store.connection.execute("INSERT INTO orch_host_registry(host_id,host_epoch,protocol_version,runtime_digest,capabilities,registered_at,state) VALUES('host-contract','epoch-contract',1,?1,'[]',0,'active')",["b".repeat(64)])?;
            store.reliability_transaction(|tx|super::super::reliability::insert_execution(tx,&NewExecution{identity:identity.clone(),state:ExecutionState::Running,created_at:now()}))?;
            store.reserve_execution_resources(&identity.attempt_id,&[super::super::reliability_admission::ResourceClaim{kind:"execution".into(),scope:"daemon".into(),limit:1}])?;
            Ok(identity)
        }).await.unwrap();
        (directory, database, identity)
    }

    async fn stored_command(database: &Database, operation_id: &str) -> HostCommand {
        let id = operation_id.to_owned();
        database.read("test.command",move|store|{
            let operation=store.get_reliability_operation(&id)?;
            let identity=store.get_reliability_execution(operation.attempt_id.as_deref().unwrap())?.identity;
            store.connection.query_row("SELECT command_id,command_kind,fingerprint,payload FROM orch_host_commands WHERE operation_id=?1",[id.clone()],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?)))
                .map_err(Error::from).and_then(|(command_id,kind,fingerprint,payload)|Ok(HostCommand{command_id,operation_id:id,identity,kind:parse_host_command_kind(&kind)?,fingerprint,payload}))
        }).await.unwrap()
    }

    #[tokio::test]
    async fn received_result_is_not_business_acceptance_and_retries_preserve_receipt() {
        let (_directory, database, identity) = fixture().await;
        let payload = json!({"success":true,"outcome":"verified deliverable"});
        let operation = submit_execution_operation(
            &database,
            &identity.attempt_id,
            "result-contract",
            OperationKind::Result,
            payload.clone(),
        )
        .await
        .unwrap();
        assert_eq!(operation.state, OperationState::Accepted);
        let task = identity.task_id.clone();
        assert_eq!(
            database
                .call_control("test.task", move |store| Ok(store.task(&task)?.status))
                .await
                .unwrap(),
            TaskStatus::Dispatched
        );
        let mut command = HostCommand {
            command_id: "result-command".into(),
            operation_id: "result-contract".into(),
            identity: identity.clone(),
            kind: HostCommandKind::Result,
            fingerprint: String::new(),
            payload: payload.to_string(),
        };
        command.fingerprint =
            super::super::reliability::host_command_fingerprint(&command).unwrap();
        let stored = command.clone();
        database
            .call_control("test.host.received", move |store| {
                store.reliability_transaction(|tx| enqueue_command(tx, &stored, now()))
            })
            .await
            .unwrap();
        persist_host_result(
            &database,
            command.clone(),
            Ok(CommandReceipt {
                command_id: command.command_id.clone(),
                identity: identity.clone(),
                state: HostCommandState::Received,
                effect_state: ControlEffectState::Received,
                receipt: Some("RECEIVED".into()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            get_execution(&database, &identity.attempt_id)
                .await
                .unwrap()
                .result_state,
            super::super::reliability::ResultState::Submitted
        );
        assert_eq!(
            get_operation(&database, "result-contract")
                .await
                .unwrap()
                .state,
            OperationState::Running
        );
        settle_pending_results(&database, 16).await.unwrap();
        let accepted = get_operation(&database, "result-contract").await.unwrap();
        assert_eq!(accepted.state, OperationState::Succeeded);
        let execution = get_execution(&database, &identity.attempt_id)
            .await
            .unwrap();
        assert_eq!(
            execution.result_state,
            super::super::reliability::ResultState::Accepted
        );
        assert_eq!(execution.state, ExecutionState::StopRequested);
        assert_eq!(
            submit_execution_operation(
                &database,
                &identity.attempt_id,
                "result-contract",
                OperationKind::Result,
                payload
            )
            .await
            .unwrap(),
            accepted
        );
        assert!(matches!(
            submit_execution_operation(
                &database,
                &identity.attempt_id,
                "result-contract",
                OperationKind::Result,
                json!({"success":false,"outcome":"changed"})
            )
            .await,
            Err(Error::Conflict)
        ));
        submit_execution_operation(
            &database,
            &identity.attempt_id,
            "result-late",
            OperationKind::Result,
            json!({"success":false,"outcome":"late failure"}),
        )
        .await
        .unwrap();
        settle_pending_results(&database, 16).await.unwrap();
        assert_eq!(
            get_operation(&database, "result-late").await.unwrap().state,
            OperationState::Failed
        );
        assert_eq!(
            get_execution(&database, &identity.attempt_id)
                .await
                .unwrap()
                .result_state,
            super::super::reliability::ResultState::Accepted
        );
        database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn stop_unknown_keeps_capacity_until_verified_exit_and_exit_is_idempotent() {
        let (_directory, database, identity) = fixture().await;
        submit_execution_operation(
            &database,
            &identity.attempt_id,
            "stop-contract",
            OperationKind::Stop,
            json!({}),
        )
        .await
        .unwrap();
        let command = stored_command(&database, "stop-contract").await;
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&command.payload).unwrap()["stopGeneration"],
            1
        );
        persist_host_result(&database, command, Err(Error::Timeout))
            .await
            .unwrap();
        assert_eq!(
            get_operation(&database, "stop-contract")
                .await
                .unwrap()
                .state,
            OperationState::OutcomeUnknown
        );
        assert_eq!(
            get_execution(&database, &identity.attempt_id)
                .await
                .unwrap()
                .state,
            ExecutionState::StopUnknown
        );
        assert_eq!(
            database
                .read("test.capacity", |store| Ok(store.connection.query_row(
                    "SELECT count(*) FROM orch_resource_reservations WHERE state='quarantined'",
                    [],
                    |row| row.get::<_, i64>(0)
                )?))
                .await
                .unwrap(),
            1
        );
        let proof = VerifiedExitProof {
            proof_id: "proof-contract".into(),
            attempt_id: identity.attempt_id.clone(),
            execution_epoch: 1,
            host: identity.host.clone(),
            config_digest: identity.config_digest.clone(),
            kind: ExitProofKind::DriverQuiescence,
            verifier: ExitProofVerifier::Driver,
            evidence_digest: "c".repeat(64),
            verified_at: now(),
        };
        confirm_execution_exit(&database, identity.clone(), proof.clone())
            .await
            .unwrap();
        confirm_execution_exit(&database, identity.clone(), proof)
            .await
            .unwrap();
        assert_eq!(
            get_execution(&database, &identity.attempt_id)
                .await
                .unwrap()
                .state,
            ExecutionState::Finalized
        );
        assert_eq!(
            database
                .read("test.capacity.released", |store| Ok(store
                    .connection
                    .query_row(
                        "SELECT count(*) FROM orch_resource_reservations WHERE state='released'",
                        [],
                        |row| row.get::<_, i64>(0)
                    )?))
                .await
                .unwrap(),
            1
        );
        database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn pending_start_is_cancelled_atomically_without_contacting_host() {
        let (_directory, database, identity) = fixture().await;
        let attempt = identity.attempt_id.clone();
        database
            .call_control("test.planned", move |store| {
                store.connection.execute(
                    "UPDATE orch_executions SET state='planned' WHERE attempt_id=?1",
                    [attempt],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let request = json!({"identity":identity,"payload":{}});
        let operation = NewOperation {
            operation: OperationView {
                operation_id: "start-contract".into(),
                kind: OperationKind::Start,
                state: OperationState::Accepted,
                task_id: Some(identity.task_id.clone()),
                attempt_id: Some(identity.attempt_id.clone()),
                execution_epoch: Some(1),
                effect_state: ControlEffectState::None,
                wait_reason: None,
                retry_after_ms: None,
                next_reconcile_at: None,
                revision: 1,
            },
            request_version: 1,
            fingerprint: super::super::reliability::request_fingerprint(
                OperationKind::Start,
                1,
                &request,
            ),
            request: request.to_string(),
            created_at: now(),
        };
        let mut command = HostCommand {
            command_id: "start-command".into(),
            operation_id: "start-contract".into(),
            identity: identity.clone(),
            kind: HostCommandKind::Start,
            fingerprint: String::new(),
            payload: "{}".into(),
        };
        command.fingerprint =
            super::super::reliability::host_command_fingerprint(&command).unwrap();
        submit_operation(&database, operation, command)
            .await
            .unwrap();
        let stopped = submit_execution_operation(
            &database,
            &identity.attempt_id,
            "stop-before-start",
            OperationKind::Stop,
            json!({}),
        )
        .await
        .unwrap();
        assert_eq!(stopped.state, OperationState::Succeeded);
        assert_eq!(
            get_operation(&database, "start-contract")
                .await
                .unwrap()
                .state,
            OperationState::Cancelled
        );
        assert_eq!(
            get_execution(&database, &identity.attempt_id)
                .await
                .unwrap()
                .state,
            ExecutionState::Finalized
        );
        database.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn offline_result_is_validated_before_exit_even_without_dispatcher_tick() {
        let (_directory, database, identity) = fixture().await;
        let mut command = HostCommand {
            command_id: "offline-result-command".into(),
            operation_id: "offline-result".into(),
            identity: identity.clone(),
            kind: HostCommandKind::Result,
            fingerprint: String::new(),
            payload: json!({"success":true,"outcome":"offline delivery"}).to_string(),
        };
        command.fingerprint =
            super::super::reliability::host_command_fingerprint(&command).unwrap();
        let received = import_host_result(&database, command.clone())
            .await
            .unwrap();
        assert_eq!(received.state, OperationState::Accepted);
        let proof = VerifiedExitProof {
            proof_id: "offline-proof".into(),
            attempt_id: identity.attempt_id.clone(),
            execution_epoch: 1,
            host: identity.host.clone(),
            config_digest: identity.config_digest.clone(),
            kind: ExitProofKind::DriverQuiescence,
            verifier: ExitProofVerifier::Driver,
            evidence_digest: "e".repeat(64),
            verified_at: now(),
        };
        confirm_execution_exit(&database, identity.clone(), proof)
            .await
            .unwrap();
        let execution = get_execution(&database, &identity.attempt_id)
            .await
            .unwrap();
        assert_eq!(execution.state, ExecutionState::Finalized);
        assert_eq!(
            execution.result_state,
            super::super::reliability::ResultState::Accepted
        );
        assert_eq!(
            get_operation(&database, "offline-result")
                .await
                .unwrap()
                .state,
            OperationState::Succeeded
        );
        assert_eq!(
            import_host_result(&database, command).await.unwrap().state,
            OperationState::Succeeded
        );
        database.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn explicit_reconcile_rearms_original_commands_without_accepting_exit_proofs() {
        let (_directory, database, identity) = fixture().await;
        submit_execution_operation(
            &database,
            &identity.attempt_id,
            "stop-reconcile",
            OperationKind::Stop,
            json!({}),
        )
        .await
        .unwrap();
        let command = stored_command(&database, "stop-reconcile").await;
        persist_host_result(&database, command.clone(), Err(Error::Timeout))
            .await
            .unwrap();
        database.call_control("test.manual",|store|{
            store.connection.execute("UPDATE orch_recovery_jobs SET state='manual_required',revision=100 WHERE kind='operation' AND object_id='stop-reconcile'",[])?;
            Ok(())
        }).await.unwrap();
        assert!(matches!(
            submit_execution_operation(
                &database,
                &identity.attempt_id,
                "unsafe-reconcile",
                OperationKind::Reconcile,
                json!({"proof":{}})
            )
            .await,
            Err(Error::Invalid(_))
        ));
        let accepted = submit_execution_operation(
            &database,
            &identity.attempt_id,
            "repair-reconcile",
            OperationKind::Reconcile,
            json!({"reason":"Host connection repaired"}),
        )
        .await
        .unwrap();
        assert_eq!(accepted.state, OperationState::Accepted);
        let same = stored_command(&database, "stop-reconcile").await;
        assert_eq!(same.command_id, command.command_id);
        assert_eq!(same.fingerprint, command.fingerprint);
        let (state,revision,attempts)=database.call_control("test.rearmed",|store|{
            Ok(store.connection.query_row("SELECT state,revision,json_extract(detail,'$.automaticAttempts') FROM orch_recovery_jobs WHERE kind='operation' AND object_id='stop-reconcile'",[],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?)))?)
        }).await.unwrap();
        assert_eq!(state, "pending");
        assert!(revision > 100);
        assert_eq!(attempts, 0);
        assert_eq!(
            get_execution(&database, &identity.attempt_id)
                .await
                .unwrap()
                .identity
                .execution_epoch,
            1
        );
        database.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn rejected_submission_can_be_corrected_without_rewriting_its_receipt() {
        let (_directory, database, identity) = fixture().await;
        submit_execution_operation(
            &database,
            &identity.attempt_id,
            "invalid-submission",
            OperationKind::Result,
            json!({"success":true}),
        )
        .await
        .unwrap();
        settle_pending_results(&database, 4).await.unwrap();
        assert_eq!(
            get_operation(&database, "invalid-submission")
                .await
                .unwrap()
                .state,
            OperationState::Failed
        );
        assert_eq!(
            get_execution(&database, &identity.attempt_id)
                .await
                .unwrap()
                .result_state,
            super::super::reliability::ResultState::Rejected
        );
        submit_execution_operation(
            &database,
            &identity.attempt_id,
            "corrected-submission",
            OperationKind::Result,
            json!({"success":true,"outcome":"verified corrected delivery"}),
        )
        .await
        .unwrap();
        settle_pending_results(&database, 4).await.unwrap();
        assert_eq!(
            get_execution(&database, &identity.attempt_id)
                .await
                .unwrap()
                .result_state,
            super::super::reliability::ResultState::Accepted
        );
        assert_eq!(
            get_operation(&database, "invalid-submission")
                .await
                .unwrap()
                .state,
            OperationState::Failed
        );
        assert_eq!(
            get_operation(&database, "corrected-submission")
                .await
                .unwrap()
                .state,
            OperationState::Succeeded
        );
        database.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn message_operation_completes_on_durable_receipt_without_claiming_delivery() {
        let (_directory, database, identity) = fixture().await;
        submit_execution_operation(
            &database,
            &identity.attempt_id,
            "message-received",
            OperationKind::Message,
            json!({"text":"follow up"}),
        )
        .await
        .unwrap();
        let command = stored_command(&database, "message-received").await;
        persist_host_result(
            &database,
            command.clone(),
            Ok(CommandReceipt {
                command_id: command.command_id,
                identity: identity.clone(),
                state: HostCommandState::Received,
                effect_state: ControlEffectState::Received,
                receipt: Some("provider processing unconfirmed".into()),
            }),
        )
        .await
        .unwrap();
        let operation = get_operation(&database, "message-received").await.unwrap();
        assert_eq!(operation.state, OperationState::Succeeded);
        assert_eq!(operation.effect_state, ControlEffectState::Received);
        let execution = get_execution(&database, &identity.attempt_id)
            .await
            .unwrap();
        assert_eq!(execution.state, ExecutionState::Running);
        assert_eq!(
            execution.result_state,
            super::super::reliability::ResultState::None
        );
        database.shutdown().await.unwrap();
    }
    fn hosted_registration_fixture() -> (tempfile::TempDir, Store, HostedWorkerPlan, String) {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let run = store
            .create_run(CreateRun {
                objective: "atomic hosted registration".into(),
                coordinator_session_id: None,
            })
            .unwrap();
        let task = store
            .create_task(CreateTask {
                run_id: run.id.clone(),
                title: "fixture".into(),
                spec: "explicit delivery".into(),
                skills: vec![],
                deps: vec![],
                parent_id: None,
            })
            .unwrap();
        let input:super::super::StartWorker=serde_json::from_value(json!({"taskId":task.id,"agent":"claude","cwd":directory.path(),"worktree":"none","operationId":"atomic-hosted"})).unwrap();
        store
            .enqueue_worker_start(
                "atomic-hosted",
                &super::super::start::worker_start_fingerprint(&input),
                &run.id,
                &input,
            )
            .unwrap();
        assert!(store.claim_next_worker_start().unwrap().is_some());
        let plan = HostedWorkerPlan {
            operation_id: "atomic-hosted".into(),
            task_id: task.id,
            payload: json!({"session":{"agent":"claude"},"prompt":"fixture","admission":{"runId":run.id}}),
            runtime_digest: "b".repeat(64),
            config_digest: "a".repeat(64),
            worktree_path: None,
        };
        (
            directory,
            store,
            plan,
            super::super::start::worker_session_id("atomic-hosted"),
        )
    }

    #[test]
    fn hosted_session_dispatch_execution_and_command_become_visible_atomically() {
        let (directory, mut store, plan, session_id) = hosted_registration_fixture();
        let observer = rusqlite::Connection::open_with_flags(
            directory.path().join("prospero.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        store
            .create_session_with_id(
                crate::protocol::CreateSession {
                    agent: crate::protocol::AgentKind::Claude,
                    kind: crate::protocol::SessionKind::Structured,
                    title: "placeholder".into(),
                    workspace: "/tmp".into(),
                },
                Some(session_id.clone()),
                |tx, head| {
                    accept_hosted_worker_tx(tx, &head.id, &plan)?;
                    for table in [
                        "session_heads",
                        "orch_dispatches",
                        "orch_executions",
                        "orch_operations_v2",
                        "orch_host_commands",
                    ] {
                        assert_eq!(
                            observer
                                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                                    .get::<_, i64>(
                                    0
                                ))
                                .unwrap(),
                            0
                        );
                    }
                    Ok(())
                },
            )
            .unwrap();
        assert!(
            store
                .reconcile_dispatch_session(&session_id)
                .unwrap()
                .settled
                .is_empty()
        );
        assert_eq!(
            store.task(&plan.task_id).unwrap().status,
            TaskStatus::Dispatched
        );
        assert_eq!(
            store.get_reliability_execution(&session_id).unwrap().state,
            ExecutionState::Planned
        );
        assert_eq!(
            store
                .get_reliability_operation(&plan.operation_id)
                .unwrap()
                .state,
            OperationState::Accepted
        );
    }

    #[test]
    fn hosted_registration_failure_rolls_back_placeholder_and_all_ownership_rows() {
        let (_directory, mut store, plan, session_id) = hosted_registration_fixture();
        let failed = store.create_session_with_id(
            crate::protocol::CreateSession {
                agent: crate::protocol::AgentKind::Claude,
                kind: crate::protocol::SessionKind::Structured,
                title: "placeholder".into(),
                workspace: "/tmp".into(),
            },
            Some(session_id),
            |tx, head| {
                accept_hosted_worker_tx(tx, &head.id, &plan)?;
                Err(Error::Timeout)
            },
        );
        assert!(matches!(failed, Err(Error::Timeout)));
        for table in [
            "session_heads",
            "orch_dispatches",
            "orch_executions",
            "orch_operations_v2",
            "orch_host_commands",
            "orch_host_registry",
            "orch_recovery_jobs",
        ] {
            assert_eq!(
                store
                    .connection
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            store.task(&plan.task_id).unwrap().status,
            TaskStatus::Pending
        );
        let start = store.worker_start(&plan.operation_id).unwrap();
        assert_eq!(start.phase, super::super::WorkerStartPhase::Preparing);
        assert!(start.session_id.is_none());
    }

    #[tokio::test]
    async fn before_send_timeout_waits_but_possible_delivery_preserves_unknown_ownership() {
        let (_directory, database, identity) = fixture().await;
        let attempt = identity.attempt_id.clone();
        database
            .call_control("test.planned", move |store| {
                store.connection.execute(
                    "UPDATE orch_executions SET state='planned' WHERE attempt_id=?1",
                    [attempt],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let payload = json!({});
        let request = json!({"identity":identity,"payload":payload});
        let operation = NewOperation {
            operation: OperationView {
                operation_id: "boundary-start".into(),
                kind: OperationKind::Start,
                state: OperationState::Accepted,
                task_id: Some(identity.task_id.clone()),
                attempt_id: Some(identity.attempt_id.clone()),
                execution_epoch: Some(1),
                effect_state: ControlEffectState::None,
                wait_reason: None,
                retry_after_ms: None,
                next_reconcile_at: None,
                revision: 1,
            },
            request_version: 1,
            fingerprint: super::super::reliability::request_fingerprint(
                OperationKind::Start,
                1,
                &request,
            ),
            request: request.to_string(),
            created_at: now(),
        };
        let mut command = HostCommand {
            command_id: "boundary-command".into(),
            operation_id: "boundary-start".into(),
            identity: identity.clone(),
            kind: HostCommandKind::Start,
            fingerprint: String::new(),
            payload: payload.to_string(),
        };
        command.fingerprint =
            super::super::reliability::host_command_fingerprint(&command).unwrap();
        submit_operation(&database, operation, command.clone())
            .await
            .unwrap();
        persist_host_result(
            &database,
            command.clone(),
            classify_delivery_result(HostCommandKind::Start, false, Err(Error::Timeout)),
        )
        .await
        .unwrap();
        let waiting = get_operation(&database, "boundary-start").await.unwrap();
        assert_eq!(waiting.state, OperationState::Waiting);
        assert_eq!(waiting.effect_state, ControlEffectState::None);
        assert_eq!(
            get_execution(&database, &identity.attempt_id)
                .await
                .unwrap()
                .state,
            ExecutionState::Planned
        );
        let pending = stored_command(&database, "boundary-start").await;
        assert_eq!(pending.command_id, command.command_id);
        database.call_control("test.wait.diagnostic",|store|{
            let (state,detail):(String,String)=store.connection.query_row("SELECT state,detail FROM orch_recovery_jobs WHERE kind='operation' AND object_id='boundary-start'",[],|row|Ok((row.get(0)?,row.get(1)?)))?;
            assert_eq!(state,"pending");
            assert_eq!(serde_json::from_str::<serde_json::Value>(&detail)?["error"]["code"],"host_preparation_wait");
            Ok(())
        }).await.unwrap();
        persist_host_result(
            &database,
            command,
            classify_delivery_result(HostCommandKind::Start, true, Err(Error::Timeout)),
        )
        .await
        .unwrap();
        assert_eq!(
            get_operation(&database, "boundary-start")
                .await
                .unwrap()
                .state,
            OperationState::OutcomeUnknown
        );
        assert_eq!(
            get_execution(&database, &identity.attempt_id)
                .await
                .unwrap()
                .state,
            ExecutionState::StartUnknown
        );
        database.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn retired_execution_rejects_new_host_commands_but_replays_existing_receipts() {
        let (_directory, database, identity) = fixture().await;
        submit_execution_operation(
            &database,
            &identity.attempt_id,
            "original-stop",
            OperationKind::Stop,
            json!({}),
        )
        .await
        .unwrap();
        let payload = json!({"success":true,"outcome":"accepted before retirement"});
        submit_execution_operation(
            &database,
            &identity.attempt_id,
            "original-result",
            OperationKind::Result,
            payload.clone(),
        )
        .await
        .unwrap();
        settle_pending_results(&database, 4).await.unwrap();
        let proof = VerifiedExitProof {
            proof_id: "retirement-proof".into(),
            attempt_id: identity.attempt_id.clone(),
            execution_epoch: 1,
            host: identity.host.clone(),
            config_digest: identity.config_digest.clone(),
            kind: ExitProofKind::DriverQuiescence,
            verifier: ExitProofVerifier::Driver,
            evidence_digest: "c".repeat(64),
            verified_at: now(),
        };
        confirm_execution_exit(&database, identity.clone(), proof)
            .await
            .unwrap();
        database
            .call_control("test.retired", |store| {
                store.connection.execute(
                    "UPDATE orch_host_registry SET state='retired' WHERE host_id='host-contract'",
                    [],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let stop = get_operation(&database, "original-stop").await.unwrap();
        let result = get_operation(&database, "original-result").await.unwrap();
        for (id, kind, payload) in [
            ("late-stop", OperationKind::Stop, json!({})),
            (
                "late-message",
                OperationKind::Message,
                json!({"text":"late"}),
            ),
            (
                "late-reconcile",
                OperationKind::Reconcile,
                json!({"reason":"retry"}),
            ),
        ] {
            assert!(
                matches!(submit_execution_operation(&database,&identity.attempt_id,id,kind,payload).await,Err(Error::Feature(code,_)) if code=="execution_finalized")
            );
            assert!(matches!(
                get_operation(&database, id).await,
                Err(Error::NotFound)
            ));
        }
        assert_eq!(
            submit_execution_operation(
                &database,
                &identity.attempt_id,
                "original-stop",
                OperationKind::Stop,
                json!({})
            )
            .await
            .unwrap(),
            stop
        );
        assert_eq!(
            submit_execution_operation(
                &database,
                &identity.attempt_id,
                "original-result",
                OperationKind::Result,
                payload
            )
            .await
            .unwrap(),
            result
        );
        submit_execution_operation(
            &database,
            &identity.attempt_id,
            "late-result",
            OperationKind::Result,
            json!({"success":false,"outcome":"late result cannot overwrite accepted delivery"}),
        )
        .await
        .unwrap();
        settle_pending_results(&database, 4).await.unwrap();
        assert_eq!(
            get_operation(&database, "late-result").await.unwrap().state,
            OperationState::Failed
        );
        assert_eq!(
            get_execution(&database, &identity.attempt_id)
                .await
                .unwrap()
                .result_state,
            super::super::reliability::ResultState::Accepted
        );
        let task = identity.task_id;
        assert_eq!(
            database
                .call_control("test.business.monotonic", move |store| Ok(store
                    .task(&task)?
                    .status))
                .await
                .unwrap(),
            TaskStatus::Done
        );
        database.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn lost_message_receipt_recovers_to_durable_received_without_claiming_delivery() {
        let (_directory, database, identity) = fixture().await;
        submit_execution_operation(
            &database,
            &identity.attempt_id,
            "lost-message",
            OperationKind::Message,
            json!({"text":"durable follow up"}),
        )
        .await
        .unwrap();
        let command = stored_command(&database, "lost-message").await;
        persist_host_result(&database, command.clone(), Err(Error::Timeout))
            .await
            .unwrap();
        assert_eq!(
            get_operation(&database, "lost-message")
                .await
                .unwrap()
                .state,
            OperationState::OutcomeUnknown
        );
        persist_host_result(
            &database,
            command.clone(),
            Ok(CommandReceipt {
                command_id: command.command_id.clone(),
                identity: identity.clone(),
                state: HostCommandState::Received,
                effect_state: ControlEffectState::Received,
                receipt: Some("Host persisted message; provider processing unconfirmed".into()),
            }),
        )
        .await
        .unwrap();
        let recovered = get_operation(&database, "lost-message").await.unwrap();
        assert_eq!(recovered.state, OperationState::Succeeded);
        assert_eq!(recovered.effect_state, ControlEffectState::Received);
        assert_eq!(
            get_execution(&database, &identity.attempt_id)
                .await
                .unwrap()
                .result_state,
            super::super::reliability::ResultState::None
        );
        database
            .call_control("test.receipt.monotonic", move |store| {
                store.reliability_transaction(|tx| {
                    let completed = CommandReceipt {
                        command_id: command.command_id.clone(),
                        identity: identity.clone(),
                        state: HostCommandState::Completed,
                        effect_state: ControlEffectState::Delivered,
                        receipt: Some("verified delivery".into()),
                    };
                    super::super::reliability::record_command_receipt(tx, &completed, now())?;
                    let received = CommandReceipt {
                        command_id: command.command_id,
                        identity,
                        state: HostCommandState::Received,
                        effect_state: ControlEffectState::Received,
                        receipt: Some("stale received".into()),
                    };
                    assert!(matches!(
                        super::super::reliability::record_command_receipt(tx, &received, now()),
                        Err(Error::Conflict)
                    ));
                    Ok(())
                })
            })
            .await
            .unwrap();
        database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn rejected_receipt_persistence_has_bounded_reconciliation_responsibility() {
        let (_directory, database, identity) = fixture().await;
        submit_execution_operation(
            &database,
            &identity.attempt_id,
            "receipt-failure",
            OperationKind::Message,
            json!({"text":"fixture"}),
        )
        .await
        .unwrap();
        let command = stored_command(&database, "receipt-failure").await;
        let mut wrong_identity = identity.clone();
        wrong_identity.config_digest = "f".repeat(64);
        let wrong = CommandReceipt {
            command_id: command.command_id.clone(),
            identity: wrong_identity,
            state: HostCommandState::Received,
            effect_state: ControlEffectState::Received,
            receipt: Some("wrong identity must never be applied".into()),
        };
        for _ in 0..8 {
            let error = persist_host_result(&database, command.clone(), Ok(wrong.clone()))
                .await
                .unwrap_err();
            assert!(matches!(error, Error::Conflict));
            defer_reconciliation_failure(&database, &command, &error)
                .await
                .unwrap();
        }
        let operation = get_operation(&database, "receipt-failure").await.unwrap();
        assert_eq!(operation.state, OperationState::OutcomeUnknown);
        assert_eq!(operation.wait_reason, Some(WaitReason::ManualRequired));
        database.call_control("test.receipt.budget",|store|{
            let (state,next,attempts):(String,i64,i64)=store.connection.query_row("SELECT state,next_check_at,json_extract(detail,'$.automaticAttempts') FROM orch_recovery_jobs WHERE kind='operation' AND object_id='receipt-failure'",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
            assert_eq!(state,"manual_required");
            assert!(next>now());
            assert_eq!(attempts,8);
            let received:i64=store.connection.query_row("SELECT count(*) FROM orch_host_commands WHERE operation_id='receipt-failure' AND state='received'",[],|row|row.get(0))?;
            assert_eq!(received,0);
            Ok(())
        }).await.unwrap();
        database.shutdown().await.unwrap();
    }
}
