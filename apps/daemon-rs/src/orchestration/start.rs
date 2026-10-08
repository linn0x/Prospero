use std::sync::OnceLock;
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::*;
use crate::agent::Agents;
use crate::database::validate_id;
use crate::error::{Error, Result};
use crate::worker::Database;

pub(super) struct WorkerStartLimits {
    pub global: i64,
    pub agent: i64,
    pub account: i64,
    pub run: i64,
    pub plugin: i64,
    pub profile: i64,
    pub queue: i64,
}

fn configured_limit(name: &str, fallback: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

pub(super) fn worker_start_limits() -> &'static WorkerStartLimits {
    static LIMITS: OnceLock<WorkerStartLimits> = OnceLock::new();
    LIMITS.get_or_init(|| WorkerStartLimits {
        global: configured_limit("PROSPERO_WORKER_START_GLOBAL_LIMIT", 128).min(128),
        agent: configured_limit("PROSPERO_WORKER_START_AGENT_LIMIT", 128).min(128),
        account: configured_limit("PROSPERO_WORKER_START_ACCOUNT_LIMIT", 128).min(128),
        run: configured_limit("PROSPERO_WORKER_START_RUN_LIMIT", 32),
        plugin: configured_limit("PROSPERO_WORKER_START_PLUGIN_LIMIT", 32),
        profile: configured_limit("PROSPERO_WORKER_START_PROFILE_LIMIT", 16),
        queue: configured_limit("PROSPERO_WORKER_START_QUEUE_CAPACITY", 1024),
    })
}

pub(super) enum WorkerStartEnqueue {
    Fresh(WorkerStartOperation),
    Existing(WorkerStartOperation),
}

pub(super) struct WorkerStartClaim {
    pub operation_id: String,
    pub input: StartWorker,
}

pub(super) fn worker_start_fingerprint(input: &StartWorker) -> String {
    let payload = serde_json::json!({
        "taskId": input.task_id,
        "agent": input.agent,
        "cwd": input.cwd,
        "worktree": input.worktree,
        "kind": input.kind,
        "skills": input.skills,
        "approvalPolicy": input.approval_policy,
        "accountId": input.account_id,
        "pluginId": input.plugin_id,
        "profileId": input.profile_id,
    });
    let digest = Sha256::digest(serde_json::to_vec(&payload).unwrap_or_default());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn worker_session_id(operation_id: &str) -> String {
    let digest = Sha256::digest(operation_id.as_bytes());
    let suffix: String = digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("worker-{suffix}")
}

fn submission(operation: WorkerStartOperation) -> WorkerStartSubmission {
    let status = match operation.phase {
        WorkerStartPhase::Running => WorkerStartSubmissionStatus::Started,
        WorkerStartPhase::Queued => WorkerStartSubmissionStatus::Queued,
        WorkerStartPhase::Failed => WorkerStartSubmissionStatus::Failed,
        WorkerStartPhase::Cancelled => WorkerStartSubmissionStatus::Cancelled,
        WorkerStartPhase::DeliveryUnknown => WorkerStartSubmissionStatus::DeliveryUnknown,
        _ => WorkerStartSubmissionStatus::InProgress,
    };
    WorkerStartSubmission { status, operation }
}

fn persistable_error_message(error: &Error) -> String {
    let raw = super::workers::error_message(error);
    let mut message = String::new();
    for character in raw.chars() {
        let character = if character.is_control() {
            ' '
        } else {
            character
        };
        if message.len() + character.len_utf8() > 8192 {
            break;
        }
        message.push(character);
    }
    if message.trim().is_empty() {
        "worker start failed".into()
    } else {
        message
    }
}

fn persistable_error_code(error: &Error) -> String {
    let code = error.public().code;
    if crate::database::validate_id(&code).is_ok() {
        code
    } else {
        "worker_start_failed".into()
    }
}

async fn finalize_failed_worker_start(
    database: &Database,
    agents: &Agents,
    operation_id: &str,
    error_code: &str,
    message: &str,
) {
    let session_id = worker_session_id(operation_id);
    loop {
        match agents.close(&session_id).await {
            Ok(()) | Err(Error::NotFound) => break,
            Err(
                Error::Backpressure(_)
                | Error::Busy
                | Error::Timeout
                | Error::DatabaseUnavailable(_)
                | Error::DatabaseOperationFailed(_),
            ) if database.health().alive && !agents.worker_starts_closed() => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(_) => return,
        }
    }
    loop {
        let result = database
            .call_control("worker.start.fail", {
                let operation_id = operation_id.to_owned();
                let error_code = error_code.to_owned();
                let message = message.to_owned();
                move |store| store.fail_worker_start(&operation_id, &error_code, &message)
            })
            .await;
        match result {
            Ok(_) => return,
            Err(
                Error::Backpressure(_)
                | Error::Busy
                | Error::Timeout
                | Error::Closed
                | Error::DatabaseUnavailable(_)
                | Error::DatabaseOperationFailed(_),
            ) if database.health().alive && !agents.worker_starts_closed() => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(_) => return,
        }
    }
}

async fn drive_claim(database: Database, agents: Agents, claim: WorkerStartClaim) {
    let operation_id = claim.operation_id.clone();
    if let Err(error) =
        super::workers::launch_worker_start(&database, &agents, claim.input, &operation_id).await
    {
        finalize_failed_worker_start(
            &database,
            &agents,
            &operation_id,
            &persistable_error_code(&error),
            &persistable_error_message(&error),
        )
        .await;
    }
}

struct WorkerStartSchedulerGuard(Agents);

impl Drop for WorkerStartSchedulerGuard {
    fn drop(&mut self) {
        self.0.release_worker_start_scheduler();
    }
}

async fn supervise_worker_starts(database: Database, agents: Agents) {
    let _guard = WorkerStartSchedulerGuard(agents.clone());
    loop {
        if !database.health().alive || agents.worker_starts_closed() {
            return;
        }
        let claim = database
            .call_control("worker.start.claim", |store| {
                store.claim_next_worker_start()
            })
            .await;
        match claim {
            Ok(Some(claim)) => {
                let database = database.clone();
                let agents = agents.clone();
                tokio::spawn(async move { drive_claim(database, agents, claim).await });
            }
            Ok(None) => {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

fn ensure_worker_start_scheduler(database: Database, agents: Agents) {
    if agents.claim_worker_start_scheduler() {
        tokio::spawn(supervise_worker_starts(database, agents));
    }
}

pub async fn submit_worker_start(
    database: &Database,
    agents: &Agents,
    mut input: StartWorker,
) -> Result<WorkerStartSubmission> {
    let operation_id = match input.operation_id.as_deref() {
        Some(id) => {
            validate_id(id)?;
            id.to_owned()
        }
        None => format!("worker-start-{}", uuid::Uuid::new_v4()),
    };
    input.operation_id = Some(operation_id.clone());
    let task_id = input.task_id.clone();
    let run_id = database
        .call_control("worker.start.task", move |store| {
            Ok(store.task(&task_id)?.run_id)
        })
        .await?;
    let request_fingerprint = worker_start_fingerprint(&input);
    ensure_worker_start_scheduler(database.clone(), agents.clone());
    let queued_result = {
        let request = input.clone();
        let id = operation_id.clone();
        database
            .call_control("worker.start.enqueue", move |store| {
                store.enqueue_worker_start(&id, &request_fingerprint, &run_id, &request)
            })
            .await
    };
    if matches!(
        &queued_result,
        Err(Error::Backpressure(pressure)) if pressure.resource == "worker_start_admission"
    ) {
        database.record_rejection("worker.start", "worker_start_admission");
    }
    let queued = queued_result?;
    let operation = match queued {
        WorkerStartEnqueue::Fresh(operation) => operation,
        WorkerStartEnqueue::Existing(operation) => operation,
    };
    Ok(submission(operation))
}

pub async fn start_worker(
    database: &Database,
    agents: &Agents,
    input: StartWorker,
) -> Result<WorkerStartOutcome> {
    let submitted = submit_worker_start(database, agents, input).await?;
    let operation_id = submitted.operation.operation_id;
    loop {
        let operation = get_worker_start(database, &operation_id).await?;
        match operation.phase {
            WorkerStartPhase::Running => return operation.outcome.ok_or(Error::Closed),
            WorkerStartPhase::Failed
            | WorkerStartPhase::Cancelled
            | WorkerStartPhase::DeliveryUnknown => {
                return Err(Error::Invalid(
                    operation
                        .error
                        .unwrap_or_else(|| "worker start did not complete".into()),
                ));
            }
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

pub async fn get_worker_start(
    database: &Database,
    operation_id: &str,
) -> Result<WorkerStartOperation> {
    validate_id(operation_id)?;
    let id = operation_id.to_owned();
    database
        .read("worker.start.get", move |store| store.worker_start(&id))
        .await
}

pub async fn cancel_worker_start(
    database: &Database,
    operation_id: &str,
) -> Result<WorkerStartOperation> {
    validate_id(operation_id)?;
    let id = operation_id.to_owned();
    database
        .call_control("worker.start.cancel", move |store| {
            store.cancel_queued_worker_start(&id)
        })
        .await
}

pub async fn recover_worker_starts(database: &Database, agents: &Agents) -> Result<()> {
    database
        .call_control("worker.start.recover", |store| {
            store.recover_worker_start_operations()
        })
        .await?;
    ensure_worker_start_scheduler(database.clone(), agents.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tempfile::TempDir;

    use super::*;
    use crate::agent::CreateAgentSession;
    use crate::protocol::{AgentKind, SessionLifecycle};
    use crate::worker::DatabaseOptions;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failed_start_retries_session_cleanup_before_terminalizing_operation() {
        let directory = TempDir::new().unwrap();
        let database = Database::open_with_options(
            directory.path().join("data"),
            None,
            DatabaseOptions {
                control_queue_capacity: 1,
                control_waiter_capacity: 1,
                control_enqueue_timeout: Duration::from_millis(20),
                degraded_queue_depth: 2,
                recovered_queue_depth: 0,
                overload_duration: Duration::ZERO,
                ..DatabaseOptions::default()
            },
        )
        .await
        .unwrap();
        let agents = Agents::new(database.clone());
        let operation_id = "worker-start-cleanup-pressure";
        let session_id = worker_session_id(operation_id);
        let workspace = directory.path().to_string_lossy().into_owned();
        let run_id = database
            .call_control("test.worker.start.setup", {
                let operation_id = operation_id.to_owned();
                let session_id = session_id.clone();
                let workspace = workspace.clone();
                move |store| {
                    let run = store.create_run(CreateRun {
                        objective: "cleanup pressure".into(),
                        coordinator_session_id: None,
                    })?;
                    let task = store.create_task(CreateTask {
                        run_id: run.id.clone(),
                        title: "cleanup pressure".into(),
                        spec: "cleanup pressure".into(),
                        skills: Vec::new(),
                        deps: Vec::new(),
                        parent_id: None,
                    })?;
                    let request = StartWorker {
                        task_id: task.id.clone(),
                        agent: AgentKind::Claude,
                        cwd: workspace,
                        worktree: "none".into(),
                        kind: Some("structured".into()),
                        skills: Vec::new(),
                        approval_policy: Some("standard".into()),
                        account_id: None,
                        plugin_id: None,
                        profile_id: None,
                        operation_id: Some(operation_id.clone()),
                    };
                    store.enqueue_worker_start(
                        &operation_id,
                        &worker_start_fingerprint(&request),
                        &run.id,
                        &request,
                    )?;
                    store.claim_next_worker_start()?.ok_or(Error::Closed)?;
                    store.plan_worker_start_session(&operation_id, &session_id)?;
                    Ok(run.id)
                }
            })
            .await
            .unwrap();
        agents
            .create_with_id(
                CreateAgentSession {
                    agent: AgentKind::Claude,
                    title: "cleanup pressure".into(),
                    workspace,
                    auto_approve: false,
                    mode: None,
                    model: None,
                    effort: None,
                    agent_preset: None,
                    account_id: None,
                    resume: None,
                },
                session_id.clone(),
            )
            .await
            .unwrap();
        assert_eq!(agents.count(), 1);
        let (release, blocked) = std::sync::mpsc::channel();
        let (entered, waiting) = tokio::sync::oneshot::channel();
        let blocker_database = database.clone();
        let blocker = tokio::spawn(async move {
            blocker_database
                .call_control("test.worker.start.blocker", move |_| {
                    let _ = entered.send(());
                    blocked.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(())
                })
                .await
        });
        waiting.await.unwrap();
        let queued_database = database.clone();
        let queued = tokio::spawn(async move {
            queued_database
                .call_control("test.worker.start.queued", |_| Ok(()))
                .await
        });
        while database.health().queued == 0 {
            tokio::task::yield_now().await;
        }
        let rejected = database
            .call_control("worker.start.record_session", {
                let operation_id = operation_id.to_owned();
                let session_id = session_id.clone();
                move |store| store.record_worker_start_session(&operation_id, &session_id)
            })
            .await;
        assert!(matches!(rejected, Err(Error::Backpressure(_))));
        let cleanup_database = database.clone();
        let cleanup_agents = agents.clone();
        let cleanup = tokio::spawn(async move {
            finalize_failed_worker_start(
                &cleanup_database,
                &cleanup_agents,
                operation_id,
                "injected_failure",
                "injected failure",
            )
            .await;
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while database.recent_rejections("agent.close") == 0 {
            assert!(std::time::Instant::now() < deadline);
            tokio::task::yield_now().await;
        }
        let raw = rusqlite::Connection::open(directory.path().join("data").join("prospero.sqlite"))
            .unwrap();
        let phase: String = raw
            .query_row(
                "SELECT phase FROM orch_worker_starts WHERE operation_id=?1",
                [operation_id],
                |row| row.get(0),
            )
            .unwrap();
        let active: i64 = raw
            .query_row(
                "SELECT active FROM agent_runs WHERE session_id=?1",
                [&session_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(phase, "preparing");
        assert_eq!(active, 1);
        release.send(()).unwrap();
        blocker.await.unwrap().unwrap();
        queued.await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(5), cleanup)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(agents.count(), 0);
        let (operation, session, dispatches) = database
            .call_control("test.worker.start.verify", {
                let operation_id = operation_id.to_owned();
                let session_id = session_id.clone();
                move |store| {
                    Ok((
                        store.worker_start(&operation_id)?,
                        store.session(&session_id)?,
                        store.list_dispatches(Some(&run_id))?,
                    ))
                }
            })
            .await
            .unwrap();
        assert_eq!(operation.phase, WorkerStartPhase::Failed);
        assert_eq!(operation.error_code.as_deref(), Some("injected_failure"));
        assert!(operation.dispatch_id.is_none());
        assert_eq!(session.lifecycle, SessionLifecycle::Archived);
        assert!(dispatches.is_empty());
    }
}
