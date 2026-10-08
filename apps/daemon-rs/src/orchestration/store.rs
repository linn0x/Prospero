//! SQLite-backed orchestration storage.
//!
//! All writes run on the single database worker thread, so the methods never
//! race in process; the database still enforces the cross-process invariants
//! (one live dispatch per task, foreign keys, revision optimistic concurrency).
//! Readiness is computed by an indexed anti-join, never by scanning the graph.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::Hasher;
use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::*;
use crate::database::{Store, label, now, validate_id, validate_text};
use crate::error::{Error, Result};

const MAX_GRAPH_NODES: usize = 200;
const MAX_SKILLS: usize = 5;
const OPERATIONS_RETENTION: i64 = 1_000;
const MAX_RUN_OBJECTIVE_BYTES: usize = 4096;
const MAX_TASK_TITLE_BYTES: usize = 1024;
const MAX_TASK_SPEC_BYTES: usize = 8192;
const MAX_TASK_RESULT_BYTES: usize = 8192;
const MAX_AUTOMATION_BYTES: usize = 32768;
const MAX_WORKTREE_PATH_BYTES: usize = 4096;
const MAX_BRANCH_BYTES: usize = 256;
const MAX_MESSAGE_PART_BYTES: usize = 8192;

/// Deterministic fingerprint for the idempotency ledger. It only has to detect
/// "same operation id, different request" across daemon restarts; it is not a
/// security boundary, so FNV-1a (stable across processes) suffices.
pub(super) fn fingerprint(method: &str, payload: &impl Serialize) -> String {
    let mut hasher = DefaultHasher::new();
    hasher.write(method.as_bytes());
    hasher.write(b"\0");
    hasher.write(serde_json::to_vec(payload).unwrap_or_default().as_slice());
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod worker_start_tests {
    use super::*;
    use crate::protocol::AgentKind;
    use tempfile::TempDir;

    fn input(task_id: String, operation_id: &str, account: &str, plugin: &str) -> StartWorker {
        StartWorker {
            task_id,
            agent: AgentKind::Codex,
            cwd: "/tmp".into(),
            worktree: "none".into(),
            kind: Some("structured".into()),
            skills: Vec::new(),
            approval_policy: Some("standard".into()),
            account_id: Some(account.into()),
            plugin_id: Some(plugin.into()),
            profile_id: Some(account.into()),
            operation_id: Some(operation_id.into()),
        }
    }

    fn setup(count: usize) -> (TempDir, Store, String, Vec<String>) {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let nodes = (0..count)
            .map(|index| GraphNodeInput {
                client_id: format!("n{index}"),
                title: format!("task {index}"),
                spec: format!("work {index}"),
                skills: Vec::new(),
                deps: Vec::new(),
                parent_id: None,
            })
            .collect();
        let graph = store
            .create_run_graph(CreateRunGraph {
                objective: "worker starts".into(),
                nodes,
                coordinator_session_id: None,
                operation_id: "worker-start-test-graph".into(),
            })
            .unwrap();
        let ids = (0..count)
            .map(|index| graph.id_map[&format!("n{index}")].clone())
            .collect();
        (directory, store, graph.run.id, ids)
    }

    fn enqueue(store: &mut Store, run_id: &str, input: &StartWorker, fingerprint: &str) {
        store
            .enqueue_worker_start(
                input.operation_id.as_deref().unwrap(),
                fingerprint,
                run_id,
                input,
            )
            .unwrap();
    }

    #[test]
    fn worker_start_claim_is_durable_and_rejects_conflicting_reuse() {
        let (_directory, mut store, run_id, ids) = setup(1);
        let request = input(ids[0].clone(), "worker-op-one", "account-a", "plugin-a");
        enqueue(&mut store, &run_id, &request, "fingerprint-a");
        let replay = store
            .enqueue_worker_start("worker-op-one", "fingerprint-a", &run_id, &request)
            .unwrap();
        assert!(matches!(
            replay,
            super::super::start::WorkerStartEnqueue::Existing(_)
        ));
        assert!(
            store
                .enqueue_worker_start("worker-op-one", "fingerprint-b", &run_id, &request)
                .is_err()
        );
        let second = input(ids[0].clone(), "worker-op-two", "account-b", "plugin-b");
        assert!(matches!(
            store.enqueue_worker_start(
                "worker-op-two",
                "fingerprint-two",
                &run_id,
                &second
            ),
            Err(Error::Feature(code, _)) if code == "task_not_editable"
        ));
        let claim = store.claim_next_worker_start().unwrap().unwrap();
        assert_eq!(claim.operation_id, "worker-op-one");
        drop(store);
        let mut reopened = Store::open(_directory.path()).unwrap();
        assert_eq!(
            reopened.worker_start("worker-op-one").unwrap().phase,
            WorkerStartPhase::Preparing
        );
    }

    #[test]
    fn legacy_worker_start_receipt_is_imported_without_launching_again() {
        let (_directory, mut store, run_id, ids) = setup(1);
        let settled = store
            .dispatch_task(&ids[0], "legacy-worker-session", None, None)
            .unwrap();
        let outcome = WorkerStartOutcome {
            task: settled.task,
            dispatch: settled.dispatch,
            session_id: "legacy-worker-session".into(),
            worktree: None,
        };
        let request = input(
            ids[0].clone(),
            "legacy-worker-operation",
            "account-a",
            "plugin-a",
        );
        let legacy_fingerprint = fingerprint(
            "worker.start",
            &serde_json::json!({
                "taskId": request.task_id,
                "cwd": request.cwd,
                "worktree": request.worktree,
            }),
        );
        store
            .remember_operation("legacy-worker-operation", &legacy_fingerprint, &outcome)
            .unwrap();
        let imported = store
            .enqueue_worker_start(
                "legacy-worker-operation",
                &super::super::start::worker_start_fingerprint(&request),
                &run_id,
                &request,
            )
            .unwrap();
        assert!(matches!(
            imported,
            super::super::start::WorkerStartEnqueue::Existing(_)
        ));
        let operation = store.worker_start("legacy-worker-operation").unwrap();
        assert_eq!(operation.phase, WorkerStartPhase::Running);
        assert_eq!(operation.outcome.unwrap().dispatch.id, outcome.dispatch.id);
        let mut conflict = request;
        conflict.cwd = "/var/tmp".into();
        assert!(
            store
                .enqueue_worker_start(
                    "legacy-worker-operation",
                    &super::super::start::worker_start_fingerprint(&conflict),
                    &run_id,
                    &conflict,
                )
                .is_err()
        );
    }

    #[test]
    fn existing_native_controllers_do_not_exhaust_worker_account_admission() {
        let (_directory, mut store, run_id, ids) = setup(1);
        for index in 0..20 {
            store
                .create_agent_session(
                    crate::agent::CreateAgentSession {
                        agent: AgentKind::Codex,
                        title: format!("controller {index}"),
                        workspace: "/tmp".into(),
                        auto_approve: false,
                        mode: None,
                        model: None,
                        effort: None,
                        agent_preset: None,
                        account_id: None,
                        resume: None,
                    },
                    crate::agent::ApprovalPolicy::Manual,
                )
                .unwrap();
        }
        let mut request = input(
            ids[0].clone(),
            "worker-with-controllers",
            "unused",
            "crawler",
        );
        request.account_id = None;
        request.profile_id = None;
        enqueue(&mut store, &run_id, &request, "controller-admission");
        assert_eq!(
            store
                .claim_next_worker_start()
                .unwrap()
                .unwrap()
                .operation_id,
            "worker-with-controllers"
        );
    }

    #[test]
    fn admission_skips_a_blocked_scope_without_head_of_line_blocking() {
        let (_directory, mut store, run_id, ids) = setup(18);
        for (index, task_id) in ids.iter().enumerate().take(17) {
            let request = input(
                task_id.clone(),
                &format!("worker-op-{index}"),
                "account-a",
                &format!("plugin-{index}"),
            );
            enqueue(
                &mut store,
                &run_id,
                &request,
                &format!("fingerprint-{index}"),
            );
        }
        let request = input(ids[17].clone(), "worker-op-17", "account-b", "plugin-b");
        enqueue(&mut store, &run_id, &request, "fingerprint-17");
        for index in 0..16 {
            assert_eq!(
                store
                    .claim_next_worker_start()
                    .unwrap()
                    .unwrap()
                    .operation_id,
                format!("worker-op-{index}")
            );
        }
        assert_eq!(
            store
                .claim_next_worker_start()
                .unwrap()
                .unwrap()
                .operation_id,
            "worker-op-17"
        );
        assert_eq!(
            store
                .cancel_queued_worker_start("worker-op-16")
                .unwrap()
                .phase,
            WorkerStartPhase::Cancelled
        );
    }

    #[test]
    fn capped_1024_row_queue_uses_a_fixed_statement_budget() {
        let (_directory, mut store, run_id, ids) = setup(1);
        let tx = store.connection.transaction().unwrap();
        let mut task_ids = vec![ids[0].clone()];
        for index in 1..1024 {
            let task_id = format!("task-bulk-{index}");
            tx.execute(
                "INSERT INTO orch_tasks(id,run_id,title,spec,skills,parent_id,status,result,created_at,updated_at) \
                 VALUES(?1,?2,?3,'work','[]',NULL,'pending',NULL,?4,?4)",
                params![task_id, run_id, format!("task {index}"), index as i64 + 1],
            )
            .unwrap();
            task_ids.push(task_id);
        }
        for (index, task_id) in task_ids.iter().enumerate() {
            let operation_id = format!("worker-bulk-{index}");
            let request = input(
                task_id.clone(),
                &operation_id,
                "account-cap",
                &format!("plugin-{index}"),
            );
            tx.execute(
                "INSERT INTO orch_worker_starts(operation_id,fingerprint,request,phase,task_id,run_id,agent,account_scope,plugin_scope,profile_scope,ticket,created_at,updated_at) \
                 VALUES(?1,?2,?3,'queued',?4,?5,'codex','account-cap',?6,'account-cap',?7,?8,?8)",
                params![
                    operation_id,
                    format!("fingerprint-{index}"),
                    serde_json::to_string(&request).unwrap(),
                    task_id,
                    run_id,
                    format!("plugin-{index}"),
                    index as i64,
                    index as i64 + 1,
                ],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        let limits = super::super::start::worker_start_limits();
        let cap = limits
            .global
            .min(limits.agent)
            .min(limits.account)
            .min(limits.run)
            .min(limits.profile)
            .min(1023);
        for _ in 0..cap {
            assert!(store.claim_next_worker_start().unwrap().is_some());
        }
        let (claim, statements) = store.claim_next_worker_start_statement_count().unwrap();
        assert!(claim.is_none());
        assert!(statements <= 9, "statement count was {statements}");
        let queued: i64 = store
            .connection
            .query_row(
                "SELECT count(*) FROM orch_worker_starts WHERE phase='queued'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued, 1024 - cap);
    }

    #[test]
    fn admission_terminalizes_task_state_drift_before_side_effects() {
        let (_directory, mut store, run_id, ids) = setup(2);
        let changed = input(ids[0].clone(), "worker-op-changed", "account-a", "plugin-a");
        let blocked = input(ids[1].clone(), "worker-op-blocked", "account-b", "plugin-b");
        enqueue(&mut store, &run_id, &changed, "fingerprint-changed");
        enqueue(&mut store, &run_id, &blocked, "fingerprint-blocked");
        store
            .connection
            .execute(
                "UPDATE orch_tasks SET status='cancelled' WHERE id=?1",
                [&ids[0]],
            )
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO orch_task_deps(run_id,task_id,dep_id,position) VALUES(?1,?2,?3,0)",
                params![run_id, ids[1], ids[0]],
            )
            .unwrap();
        assert!(store.claim_next_worker_start().unwrap().is_none());
        let changed = store.worker_start("worker-op-changed").unwrap();
        assert_eq!(changed.phase, WorkerStartPhase::Failed);
        assert_eq!(changed.error_code.as_deref(), Some("task_not_editable"));
        let blocked = store.worker_start("worker-op-blocked").unwrap();
        assert_eq!(blocked.phase, WorkerStartPhase::Failed);
        assert_eq!(blocked.error_code.as_deref(), Some("task_not_ready"));
        assert!(changed.asset_id.is_none());
        assert!(changed.session_id.is_none());
        assert!(blocked.asset_id.is_none());
        assert!(blocked.session_id.is_none());
    }

    #[test]
    fn recovery_requeues_only_operations_with_no_possible_side_effect() {
        let (directory, mut store, run_id, ids) = setup(3);
        let safe = input(ids[0].clone(), "worker-op-safe", "account-a", "plugin-a");
        let uncertain = input(
            ids[1].clone(),
            "worker-op-uncertain",
            "account-b",
            "plugin-b",
        );
        enqueue(&mut store, &run_id, &safe, "fingerprint-safe");
        enqueue(&mut store, &run_id, &uncertain, "fingerprint-uncertain");
        let worktree = input(
            ids[2].clone(),
            "worker-op-worktree",
            "account-c",
            "plugin-c",
        );
        enqueue(&mut store, &run_id, &worktree, "fingerprint-worktree");
        assert_eq!(
            store
                .claim_next_worker_start()
                .unwrap()
                .unwrap()
                .operation_id,
            "worker-op-safe"
        );
        assert_eq!(
            store
                .claim_next_worker_start()
                .unwrap()
                .unwrap()
                .operation_id,
            "worker-op-uncertain"
        );
        assert_eq!(
            store
                .claim_next_worker_start()
                .unwrap()
                .unwrap()
                .operation_id,
            "worker-op-worktree"
        );
        store
            .plan_worker_start_session("worker-op-uncertain", "worker-session-uncertain")
            .unwrap();
        let planned = directory.path().join("planned-worktree");
        std::fs::create_dir(&planned).unwrap();
        store
            .plan_worker_start_worktree(
                "worker-op-worktree",
                directory.path().to_str().unwrap(),
                planned.to_str().unwrap(),
                "prospero/test/worktree",
            )
            .unwrap();
        store.recover_worker_start_operations().unwrap();
        assert_eq!(
            store.worker_start("worker-op-safe").unwrap().phase,
            WorkerStartPhase::Queued
        );
        assert_eq!(
            store.worker_start("worker-op-uncertain").unwrap().phase,
            WorkerStartPhase::Failed
        );
        let uncertain = store.worker_start("worker-op-uncertain").unwrap();
        assert_eq!(
            uncertain.side_effect_state,
            WorkerStartSideEffectState::Unknown
        );
        assert_eq!(
            uncertain.error_code.as_deref(),
            Some("recovery_interrupted")
        );
        let worktree = store.worker_start("worker-op-worktree").unwrap();
        assert_eq!(worktree.phase, WorkerStartPhase::Failed);
        let asset = store
            .worktree_asset(worktree.asset_id.as_deref().unwrap())
            .unwrap();
        assert_eq!(asset.state, WorktreeAssetState::Preserved);
    }

    #[tokio::test]
    async fn concurrent_duplicate_enqueue_has_one_durable_claim() {
        let (directory, store, run_id, ids) = setup(1);
        drop(store);
        let database = crate::worker::Database::open(directory.path().to_path_buf())
            .await
            .unwrap();
        let request = input(ids[0].clone(), "worker-op-race", "account-a", "plugin-a");
        let first_database = database.clone();
        let second_database = database.clone();
        let first_request = request.clone();
        let second_request = request.clone();
        let first_run = run_id.clone();
        let second_run = run_id.clone();
        let (first, second) = tokio::join!(
            first_database.call_control("test.worker.start.first", move |store| {
                store.enqueue_worker_start(
                    "worker-op-race",
                    "fingerprint-race",
                    &first_run,
                    &first_request,
                )
            }),
            second_database.call_control("test.worker.start.second", move |store| {
                store.enqueue_worker_start(
                    "worker-op-race",
                    "fingerprint-race",
                    &second_run,
                    &second_request,
                )
            })
        );
        let results = [first.unwrap(), second.unwrap()];
        assert_eq!(
            results
                .iter()
                .filter(|value| matches!(value, super::super::start::WorkerStartEnqueue::Fresh(_)))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|value| matches!(
                    value,
                    super::super::start::WorkerStartEnqueue::Existing(_)
                ))
                .count(),
            1
        );
    }

    #[test]
    fn recovery_never_replays_a_delivery_that_may_have_started() {
        let (_directory, mut store, run_id, ids) = setup(1);
        let request = input(
            ids[0].clone(),
            "worker-op-delivery",
            "account-a",
            "plugin-a",
        );
        enqueue(&mut store, &run_id, &request, "fingerprint-delivery");
        store.claim_next_worker_start().unwrap().unwrap();
        let session_id = "worker-session-delivery";
        store
            .plan_worker_start_session("worker-op-delivery", session_id)
            .unwrap();
        store
            .create_agent_session_with_id(
                crate::agent::CreateAgentSession {
                    agent: AgentKind::Codex,
                    title: "worker delivery".into(),
                    workspace: "/tmp".into(),
                    auto_approve: false,
                    mode: None,
                    model: None,
                    effort: None,
                    agent_preset: None,
                    account_id: None,
                    resume: None,
                },
                crate::agent::ApprovalPolicy::Manual,
                Some(session_id.into()),
            )
            .unwrap();
        store
            .record_worker_start_session("worker-op-delivery", session_id)
            .unwrap();
        store
            .commit_worker_start_dispatch("worker-op-delivery", &ids[0], session_id, None)
            .unwrap();
        store
            .mark_worker_start_delivering("worker-op-delivery")
            .unwrap();
        store.recover_worker_start_operations().unwrap();
        let operation = store.worker_start("worker-op-delivery").unwrap();
        assert_eq!(operation.phase, WorkerStartPhase::DeliveryUnknown);
        assert_eq!(
            operation.side_effect_state,
            WorkerStartSideEffectState::Unknown
        );
        assert_eq!(operation.error_code.as_deref(), Some("delivery_unknown"));
        let dispatch = store
            .dispatch(operation.dispatch_id.as_deref().unwrap())
            .unwrap();
        assert_eq!(dispatch.state, DispatchState::Abandoned);
        assert_eq!(store.task(&ids[0]).unwrap().status, TaskStatus::Failed);
        store.recover_worker_start_operations().unwrap();
        assert_eq!(
            store.worker_start("worker-op-delivery").unwrap().phase,
            WorkerStartPhase::DeliveryUnknown
        );
    }
}

enum Idempotent<T> {
    Replay(T),
    Fresh,
}

/// Public ledger probe result for the worker service, which wraps the raw
/// dispatch with external side effects (worktree creation, agent session).
pub enum OperationReplay<T> {
    Replay(T),
    Fresh,
}

/// Check an idempotency key: replay the frozen first result when the request
/// matches, reject when the same id was used for a different request.
fn operation_guard<T: DeserializeOwned>(
    tx: &Transaction<'_>,
    id: &str,
    fingerprint: &str,
) -> Result<Idempotent<T>> {
    let row: Option<(String, String)> = tx
        .query_row(
            "SELECT fingerprint,result FROM orch_operations WHERE id=?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match row {
        None => Ok(Idempotent::Fresh),
        Some((existing, result)) if existing == fingerprint => {
            Ok(Idempotent::Replay(serde_json::from_str(&result)?))
        }
        Some(_) => Err(invalid("operation id was already used for another request")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SettleOutcome {
    pub task: Task,
    pub dispatch: Dispatch,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    /// Dispatches whose worker session is gone; converged abandoned/failed.
    pub settled: Vec<Dispatch>,
    pub resumed: Vec<Dispatch>,
}

#[derive(Clone)]
pub(super) struct TaskRow {
    pub(super) id: String,
    pub(super) run_id: String,
    pub(super) title: String,
    pub(super) spec: String,
    pub(super) skills: Vec<String>,
    pub(super) deps: Vec<String>,
    pub(super) parent_id: Option<String>,
    pub(super) status: TaskStatus,
    pub(super) result: Option<String>,
    pub(super) created_at: i64,
    pub(super) updated_at: i64,
}

impl TaskRow {
    pub(super) fn task(self) -> Task {
        Task {
            id: self.id,
            run_id: self.run_id,
            title: self.title,
            spec: self.spec,
            skills: self.skills,
            deps: self.deps,
            parent_id: self.parent_id,
            status: self.status,
            result: self.result,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}

fn legacy_table(table: &str) -> Option<&'static str> {
    match table {
        "runs" => Some("runs"),
        "tasks" => Some("tasks"),
        "dispatches" => Some("dispatches"),
        "gates" => Some("gates"),
        "messages" => Some("messages"),
        "worktreeAssets" => Some("worktreeAssets"),
        "task_dependencies" => Some("task_dependencies"),
        _ => None,
    }
}

fn legacy_active_query(table: &str) -> Option<&'static str> {
    match table {
        "runs" => {
            Some("SELECT data FROM runs WHERE json_extract(data,'$.status')='active' ORDER BY id")
        }
        "tasks" => Some(
            "SELECT t.data FROM tasks t JOIN runs r ON r.id=t.run_id WHERE json_extract(r.data,'$.status')='active' ORDER BY t.id",
        ),
        "dispatches" => Some(
            "SELECT d.data FROM dispatches d JOIN runs r ON r.id=d.run_id WHERE json_extract(r.data,'$.status')='active' ORDER BY d.id",
        ),
        "gates" => Some(
            "SELECT g.data FROM gates g JOIN runs r ON r.id=g.run_id WHERE json_extract(r.data,'$.status')='active' ORDER BY g.id",
        ),
        "messages" => Some(
            "SELECT m.data FROM messages m JOIN runs r ON r.id=m.run_id WHERE json_extract(r.data,'$.status')='active' ORDER BY m.id",
        ),
        "worktreeAssets" => Some(
            "SELECT w.data FROM worktreeAssets w JOIN runs r ON r.id=w.run_id WHERE json_extract(r.data,'$.status')='active' ORDER BY w.id",
        ),
        _ => None,
    }
}

fn legacy_has_table(connection: &Connection, table: &str) -> Result<bool> {
    let Some(table) = legacy_table(table) else {
        return Ok(false);
    };
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
            [table],
            |row| row.get(0),
        )
        .map_err(Error::from)
}

fn legacy_has_tables(connection: &Connection, tables: &[&str]) -> Result<bool> {
    for table in tables {
        if !legacy_has_table(connection, table)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn visit_legacy_values(
    connection: &Connection,
    table: &str,
    mut visitor: impl FnMut(Value) -> Result<()>,
) -> Result<()> {
    let Some(sql) = legacy_active_query(table) else {
        return Ok(());
    };
    if !legacy_has_table(connection, table)? {
        return Ok(());
    }
    let mut statement = connection.prepare(sql)?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        if let Ok(value) = serde_json::from_str::<Value>(&row.get::<_, String>(0)?) {
            visitor(value)?;
        }
    }
    Ok(())
}

fn truncate_text(value: &str, maximum: usize, fallback: &str) -> String {
    let value = if value.is_empty() { fallback } else { value };
    if value.len() <= maximum {
        return value.to_owned();
    }
    let mut out = String::new();
    for character in value.chars() {
        if out.len() + character.len_utf8() > maximum {
            break;
        }
        out.push(character);
    }
    if out.is_empty() {
        fallback.to_owned()
    } else {
        out
    }
}

fn legacy_text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|text| text.to_owned())
}

fn legacy_optional_text(value: &Value, key: &str, maximum: usize) -> Option<String> {
    legacy_text(value, key).map(|text| truncate_text(&text, maximum, ""))
}

fn legacy_required_text(value: &Value, key: &str, maximum: usize, fallback: &str) -> String {
    let text = legacy_text(value, key).unwrap_or_default();
    truncate_text(&text, maximum, fallback)
}

fn legacy_id(value: &Value, key: &str) -> Option<String> {
    let id = value.get(key)?.as_str()?.trim();
    validate_id(id).ok()?;
    Some(id.to_owned())
}

fn legacy_ids(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| validate_id(id).is_ok())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn legacy_nonnegative(value: &Value, key: &str, fallback: i64) -> i64 {
    value
        .get(key)
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .unwrap_or(fallback)
}

fn legacy_optional_nonnegative(value: &Value, key: &str) -> Option<i64> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
}

fn legacy_string_array(value: &Value, key: &str, maximum: usize, item_limit: usize) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|text| truncate_text(text, maximum, ""))
                .filter(|text| !text.is_empty())
                .take(item_limit)
                .collect()
        })
        .unwrap_or_default()
}

fn legacy_skills(value: &Value) -> Vec<String> {
    normalize_skills(&legacy_string_array(value, "skills", 256, MAX_SKILLS)).unwrap_or_default()
}

fn legacy_optional_json(value: &Value, key: &str, maximum: usize) -> Option<String> {
    let raw = value.get(key)?;
    if raw.is_null() {
        return None;
    }
    let text = serde_json::to_string(raw).ok()?;
    (text.len() <= maximum).then_some(text)
}

fn legacy_automation(value: &Value, timestamp: i64) -> Option<String> {
    let mut raw = value.get("automation")?.as_object()?.clone();
    if raw.get("state").and_then(Value::as_str) == Some("running") {
        raw.insert("state".into(), Value::String("paused".into()));
        raw.insert("updatedAt".into(), Value::from(timestamp));
        raw.insert(
            "lastError".into(),
            Value::String("Paused during Rust daemon migration".into()),
        );
    }
    let parsed: RunAutomation = serde_json::from_value(Value::Object(raw)).ok()?;
    let text = serde_json::to_string(&parsed).ok()?;
    (text.len() <= MAX_AUTOMATION_BYTES).then_some(text)
}

fn legacy_task_dependencies(connection: &Connection) -> Result<Vec<(String, String)>> {
    if !legacy_has_table(connection, "task_dependencies")? {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(
        "SELECT d.task_id,d.dependency_id FROM task_dependencies d \
         JOIN tasks t ON t.id=d.task_id JOIN runs r ON r.id=t.run_id \
         WHERE json_extract(r.data,'$.status')='active' ORDER BY d.task_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut deps = Vec::new();
    for row in rows {
        let (task_id, dep_id) = row?;
        if validate_id(&task_id).is_ok() && validate_id(&dep_id).is_ok() {
            deps.push((task_id, dep_id));
        }
    }
    Ok(deps)
}

/// Legacy skill name rule: `$name` references in a task spec must resolve to an
/// explicitly bound skill, so names stay conservative.
fn normalize_skills(values: &[String]) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw in values {
        let value = raw.trim();
        let valid = !value.is_empty()
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
            && value
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric());
        if !valid {
            return Err(invalid(&format!("invalid skill name: {raw}")));
        }
        let key = value.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(value.to_owned());
        }
    }
    if out.len() > MAX_SKILLS {
        return Err(invalid("a task may bind at most 5 skills"));
    }
    Ok(out)
}

// ── Row mapping ──────────────────────────────────────────────────────────

fn map_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    let status: String = row.get("status")?;
    let automation_raw: Option<String> = row.get("automation")?;
    Ok(Run {
        id: row.get("id")?,
        objective: row.get("objective")?,
        status: match status.as_str() {
            "completed" => RunStatus::Completed,
            "abandoned" => RunStatus::Abandoned,
            _ => RunStatus::Active,
        },
        coordinator_session_id: row.get("coordinator_session_id")?,
        automation: automation_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
        graph_revision: row.get("graph_revision")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_dispatch(row: &rusqlite::Row<'_>) -> rusqlite::Result<Dispatch> {
    let state: String = row.get("state")?;
    Ok(Dispatch {
        id: row.get("id")?,
        run_id: row.get("run_id")?,
        task_id: row.get("task_id")?,
        session_id: row.get("session_id")?,
        state: DispatchState::parse(&state).unwrap_or(DispatchState::Starting),
        outcome: row.get("outcome")?,
        started_at: row.get("started_at")?,
        settled_at: row.get("settled_at")?,
        worktree_path: row.get("worktree_path")?,
    })
}

fn map_asset(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorktreeAsset> {
    let kind: String = row.get("kind")?;
    let state: String = row.get("state")?;
    let inspection_raw: Option<String> = row.get("last_inspection")?;
    let cleanup_raw: Option<String> = row.get("cleanup")?;
    Ok(WorktreeAsset {
        id: row.get("id")?,
        kind: if kind == "run" {
            WorktreeAssetKind::Run
        } else {
            WorktreeAssetKind::Worker
        },
        run_id: row.get("run_id")?,
        task_id: row.get("task_id")?,
        dispatch_id: row.get("dispatch_id")?,
        repo: row.get("repo")?,
        path: row.get("path")?,
        branch: row.get("branch")?,
        state: match state.as_str() {
            "preserved" => WorktreeAssetState::Preserved,
            "missing" => WorktreeAssetState::Missing,
            "dirty" => WorktreeAssetState::Dirty,
            "unmerged" => WorktreeAssetState::Unmerged,
            "equivalent" => WorktreeAssetState::Equivalent,
            "safe_to_clean" => WorktreeAssetState::SafeToClean,
            "cleaned" => WorktreeAssetState::Cleaned,
            "unknown" => WorktreeAssetState::Unknown,
            _ => WorktreeAssetState::Active,
        },
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        run_deleted_at: row.get("run_deleted_at")?,
        last_inspection: match inspection_raw {
            Some(raw) => serde_json::from_str(&raw).unwrap_or(None),
            None => None,
        },
        cleanup: match cleanup_raw {
            Some(raw) => serde_json::from_str(&raw).unwrap_or(None),
            None => None,
        },
        last_error: row.get("last_error")?,
    })
}

fn worker_start_phase(value: &str) -> WorkerStartPhase {
    match value {
        "queued" => WorkerStartPhase::Queued,
        "preparing" => WorkerStartPhase::Preparing,
        "worktree_created" => WorkerStartPhase::WorktreeCreated,
        "session_created" => WorkerStartPhase::SessionCreated,
        "dispatch_committed" => WorkerStartPhase::DispatchCommitted,
        "delivering" => WorkerStartPhase::Delivering,
        "delivery_unknown" => WorkerStartPhase::DeliveryUnknown,
        "running" => WorkerStartPhase::Running,
        "cancelled" => WorkerStartPhase::Cancelled,
        _ => WorkerStartPhase::Failed,
    }
}

fn map_worker_start(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkerStartOperation> {
    let request: String = row.get("request")?;
    let input: StartWorker = serde_json::from_str(&request).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            request.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    let result: Option<String> = row.get("result")?;
    let outcome = result
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                result.as_ref().map_or(0, String::len),
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    let phase = worker_start_phase(&row.get::<_, String>("phase")?);
    let worktree_path: Option<String> = row.get("worktree_path")?;
    let asset_id: Option<String> = row.get("asset_id")?;
    let session_id: Option<String> = row.get("session_id")?;
    let dispatch_id: Option<String> = row.get("dispatch_id")?;
    let side_effect_state = match phase {
        WorkerStartPhase::Queued | WorkerStartPhase::Cancelled => WorkerStartSideEffectState::None,
        WorkerStartPhase::Preparing if worktree_path.is_some() || session_id.is_some() => {
            WorkerStartSideEffectState::Unknown
        }
        WorkerStartPhase::Preparing => WorkerStartSideEffectState::None,
        WorkerStartPhase::DeliveryUnknown => WorkerStartSideEffectState::Unknown,
        WorkerStartPhase::Failed
            if worktree_path.is_none()
                && asset_id.is_none()
                && session_id.is_none()
                && dispatch_id.is_none() =>
        {
            WorkerStartSideEffectState::None
        }
        WorkerStartPhase::Failed => WorkerStartSideEffectState::Unknown,
        _ => WorkerStartSideEffectState::Committed,
    };
    Ok(WorkerStartOperation {
        operation_id: row.get("operation_id")?,
        phase,
        task_id: row.get("task_id")?,
        run_id: row.get("run_id")?,
        agent: input.agent,
        account_id: input.account_id,
        worktree_path,
        asset_id,
        session_id,
        dispatch_id,
        outcome,
        error: row.get("error")?,
        error_code: row.get("error_code")?,
        side_effect_state,
        side_effect_committed: match side_effect_state {
            WorkerStartSideEffectState::None => Some(false),
            WorkerStartSideEffectState::Committed => Some(true),
            WorkerStartSideEffectState::Unknown => None,
        },
        retry_after_ms: (!phase.terminal()).then_some(100),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_gate(row: &rusqlite::Row<'_>) -> rusqlite::Result<Gate> {
    let status: String = row.get("status")?;
    Ok(Gate {
        id: row.get("id")?,
        run_id: row.get("run_id")?,
        task_id: row.get("task_id")?,
        question: row.get("question")?,
        options: serde_json::from_str(&row.get::<_, String>("options")?).unwrap_or_default(),
        status: match status.as_str() {
            "pending" => GateStatus::Pending,
            "resolved" => GateStatus::Resolved,
            _ => GateStatus::Cancelled,
        },
        decision: row.get("decision")?,
        created_at: row.get("created_at")?,
        resolved_at: row.get("resolved_at")?,
    })
}

fn grouped_count(tx: &Transaction<'_>, sql: &str) -> Result<HashMap<String, i64>> {
    let mut statement = tx.prepare(sql)?;
    Ok(statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?)
}

impl Store {
    pub fn import_legacy_orchestration(&mut self, legacy_home: &Path) -> Result<usize> {
        let existing: i64 =
            self.connection
                .query_row("SELECT count(*) FROM orch_runs", [], |row| row.get(0))?;
        if existing != 0 {
            return Ok(0);
        }
        let path = legacy_home.join("orchestration.sqlite");
        if !path.exists() {
            return Ok(0);
        }
        let legacy = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        legacy.execute_batch(
            "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; PRAGMA mmap_size=0;",
        )?;
        if !legacy_has_tables(&legacy, &["runs", "tasks", "dispatches", "gates"])? {
            return Ok(0);
        }
        let now = now();
        let legacy_deps = legacy_task_dependencies(&legacy)?;
        let tx = self.connection.transaction()?;
        tx.execute_batch("PRAGMA defer_foreign_keys=ON")?;
        let mut imported = 0;
        let mut runs = HashSet::new();
        visit_legacy_values(&legacy, "runs", |value| {
            let Some(id) = legacy_id(&value, "id") else {
                return Ok(());
            };
            let status = match legacy_text(&value, "status").as_deref() {
                Some("completed") => "completed",
                Some("abandoned") => "abandoned",
                _ => "active",
            };
            let objective =
                legacy_required_text(&value, "objective", MAX_RUN_OBJECTIVE_BYTES, "Imported run");
            let coordinator = legacy_id(&value, "coordinatorSessionId");
            let automation = legacy_automation(&value, now);
            let graph_revision = legacy_nonnegative(&value, "graphRevision", 0);
            let created_at = legacy_nonnegative(&value, "createdAt", now);
            let updated_at = legacy_nonnegative(&value, "updatedAt", created_at);
            if tx.execute(
                "INSERT OR IGNORE INTO orch_runs(id,objective,status,coordinator_session_id,automation,graph_revision,created_at,updated_at) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![id, objective, status, coordinator, automation, graph_revision, created_at, updated_at],
            )? > 0 {
                runs.insert(id);
                imported += 1;
            }
            Ok(())
        })?;
        let mut tasks: HashMap<String, String> = HashMap::new();
        let mut task_deps: HashMap<String, Vec<String>> = HashMap::new();
        let mut task_candidates: HashMap<String, String> = HashMap::new();
        visit_legacy_values(&legacy, "tasks", |value| {
            if let (Some(id), Some(run_id)) = (legacy_id(&value, "id"), legacy_id(&value, "runId"))
                && runs.contains(&run_id)
            {
                task_candidates.insert(id, run_id);
            }
            Ok(())
        })?;
        visit_legacy_values(&legacy, "tasks", |value| {
            let Some(id) = legacy_id(&value, "id") else {
                return Ok(());
            };
            let Some(run_id) = legacy_id(&value, "runId") else {
                return Ok(());
            };
            if !runs.contains(&run_id) {
                return Ok(());
            }
            let status = match legacy_text(&value, "status").as_deref() {
                Some("dispatched") => "dispatched",
                Some("blocked") => "blocked",
                Some("done") => "done",
                Some("failed") => "failed",
                Some("cancelled") => "cancelled",
                _ => "pending",
            };
            let title =
                legacy_required_text(&value, "title", MAX_TASK_TITLE_BYTES, "Imported task");
            let spec = legacy_required_text(&value, "spec", MAX_TASK_SPEC_BYTES, " ");
            let skills = serde_json::to_string(&legacy_skills(&value))?;
            let parent_id =
                legacy_id(&value, "parentId").filter(|id| task_candidates.get(id) == Some(&run_id));
            let result = legacy_optional_text(&value, "result", MAX_TASK_RESULT_BYTES);
            let created_at = legacy_nonnegative(&value, "createdAt", now);
            let updated_at = legacy_nonnegative(&value, "updatedAt", created_at);
            if tx.execute(
                "INSERT OR IGNORE INTO orch_tasks(id,run_id,title,spec,skills,parent_id,status,result,created_at,updated_at) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![id, run_id, title, spec, skills, parent_id, status, result, created_at, updated_at],
            )? > 0 {
                tasks.insert(id.clone(), run_id);
                task_deps.insert(id, legacy_ids(&value, "deps"));
                imported += 1;
            }
            Ok(())
        })?;
        for (task_id, dep_id) in legacy_deps {
            if let Some(list) = task_deps.get_mut(&task_id)
                && !list.iter().any(|existing| existing == &dep_id)
            {
                list.push(dep_id);
            }
        }
        for (task_id, deps) in task_deps {
            let Some(run_id) = tasks.get(&task_id) else {
                continue;
            };
            let mut seen = HashSet::new();
            for (position, dep_id) in deps
                .into_iter()
                .filter(|dep| tasks.get(dep) == Some(run_id))
                .enumerate()
            {
                if !seen.insert(dep_id.clone()) {
                    continue;
                }
                tx.execute(
                    "INSERT OR IGNORE INTO orch_task_deps(run_id,task_id,dep_id,position) VALUES(?1,?2,?3,?4)",
                    params![run_id, task_id, dep_id, position as i64],
                )?;
            }
        }
        visit_legacy_values(&legacy, "dispatches", |value| {
            let Some(id) = legacy_id(&value, "id") else {
                return Ok(());
            };
            let Some(run_id) = legacy_id(&value, "runId") else {
                return Ok(());
            };
            let Some(task_id) = legacy_id(&value, "taskId") else {
                return Ok(());
            };
            let Some(session_id) = legacy_id(&value, "sessionId") else {
                return Ok(());
            };
            if !runs.contains(&run_id) || tasks.get(&task_id) != Some(&run_id) {
                return Ok(());
            }
            let state = match legacy_text(&value, "state").as_deref() {
                Some("running") => "running",
                Some("succeeded") => "succeeded",
                Some("failed") => "failed",
                Some("abandoned") => "abandoned",
                _ => "starting",
            };
            let outcome = legacy_optional_text(&value, "outcome", MAX_TASK_RESULT_BYTES);
            let started_at = legacy_nonnegative(&value, "startedAt", now);
            let settled_at = legacy_optional_nonnegative(&value, "settledAt");
            let worktree_path =
                legacy_optional_text(&value, "worktreePath", MAX_WORKTREE_PATH_BYTES);
            if tx.execute(
                "INSERT OR IGNORE INTO orch_dispatches(id,run_id,task_id,session_id,state,outcome,started_at,settled_at,worktree_path) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![id, run_id, task_id, session_id, state, outcome, started_at, settled_at, worktree_path],
            )? > 0 {
                imported += 1;
            }
            Ok(())
        })?;
        visit_legacy_values(&legacy, "gates", |value| {
            let Some(id) = legacy_id(&value, "id") else {
                return Ok(());
            };
            let Some(run_id) = legacy_id(&value, "runId") else {
                return Ok(());
            };
            if !runs.contains(&run_id) {
                return Ok(());
            }
            let task_id = legacy_id(&value, "taskId").filter(|id| tasks.get(id) == Some(&run_id));
            let status = match legacy_text(&value, "status").as_deref() {
                Some("resolved") => "resolved",
                Some("cancelled") => "cancelled",
                _ => "pending",
            };
            let question =
                legacy_required_text(&value, "question", MAX_RUN_OBJECTIVE_BYTES, "Imported gate");
            let options =
                serde_json::to_string(&legacy_string_array(&value, "options", 1000, 100))?;
            let decision = legacy_optional_text(&value, "decision", MAX_RUN_OBJECTIVE_BYTES);
            let created_at = legacy_nonnegative(&value, "createdAt", now);
            let resolved_at = legacy_optional_nonnegative(&value, "resolvedAt");
            if tx.execute(
                "INSERT OR IGNORE INTO orch_gates(id,run_id,task_id,question,options,status,decision,created_at,resolved_at) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![id, run_id, task_id, question, options, status, decision, created_at, resolved_at],
            )? > 0 {
                imported += 1;
            }
            Ok(())
        })?;
        visit_legacy_values(&legacy, "messages", |value| {
            let Some(id) = legacy_id(&value, "id") else {
                return Ok(());
            };
            let Some(run_id) = legacy_id(&value, "runId") else {
                return Ok(());
            };
            if !runs.contains(&run_id) {
                return Ok(());
            }
            let sender = legacy_required_text(&value, "from", 128, "legacy");
            let recipient = legacy_required_text(&value, "to", 128, "human");
            let kind = match legacy_text(&value, "type").as_deref() {
                Some("ask") => "ask",
                Some("reply") => "reply",
                Some("report") => "report",
                _ => "note",
            };
            let subject = legacy_required_text(&value, "subject", 1024, "Imported message");
            let body = legacy_required_text(&value, "body", MAX_MESSAGE_PART_BYTES, " ");
            let thread_id = legacy_id(&value, "threadId");
            let task_id = legacy_id(&value, "taskId").filter(|id| tasks.get(id) == Some(&run_id));
            let created_at = legacy_nonnegative(&value, "createdAt", now);
            let read_at = legacy_optional_nonnegative(&value, "readAt");
            let answered_at = legacy_optional_nonnegative(&value, "answeredAt");
            if tx.execute(
                "INSERT OR IGNORE INTO orch_messages(id,run_id,sender,recipient,kind,subject,body,thread_id,task_id,created_at,read_at,answered_at) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![id, run_id, sender, recipient, kind, subject, body, thread_id, task_id, created_at, read_at, answered_at],
            )? > 0 {
                imported += 1;
            }
            Ok(())
        })?;
        visit_legacy_values(&legacy, "worktreeAssets", |value| {
            let Some(id) = legacy_id(&value, "id") else {
                return Ok(());
            };
            let Some(run_id) = legacy_id(&value, "runId") else {
                return Ok(());
            };
            let Some(path) = legacy_text(&value, "path") else {
                return Ok(());
            };
            let kind = match legacy_text(&value, "kind").as_deref() {
                Some("run") => "run",
                _ => "worker",
            };
            let state = match legacy_text(&value, "state").as_deref() {
                Some("active") => "active",
                Some("missing") => "missing",
                Some("dirty") => "dirty",
                Some("unmerged") => "unmerged",
                Some("equivalent") => "equivalent",
                Some("safe_to_clean") => "safe_to_clean",
                Some("cleaned") => "cleaned",
                Some("unknown") => "unknown",
                _ => "preserved",
            };
            let repo = legacy_optional_text(&value, "repo", MAX_WORKTREE_PATH_BYTES)
                .unwrap_or_else(|| truncate_text(&path, MAX_WORKTREE_PATH_BYTES, " "));
            let task_id = legacy_id(&value, "taskId");
            let dispatch_id = legacy_id(&value, "dispatchId");
            let branch = legacy_optional_text(&value, "branch", MAX_BRANCH_BYTES);
            let created_at = legacy_nonnegative(&value, "createdAt", now);
            let updated_at = legacy_nonnegative(&value, "updatedAt", created_at);
            let run_deleted_at = legacy_optional_nonnegative(&value, "runDeletedAt");
            let inspection = legacy_optional_json(&value, "lastInspection", 32768);
            let cleanup = legacy_optional_json(&value, "cleanup", 32768);
            let last_error = legacy_optional_text(&value, "lastError", MAX_TASK_RESULT_BYTES);
            if tx.execute(
                "INSERT OR IGNORE INTO orch_worktree_assets \
                 (id,kind,run_id,task_id,dispatch_id,repo,path,branch,state,created_at,updated_at,run_deleted_at,last_inspection,cleanup,last_error) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                params![id, kind, run_id, task_id, dispatch_id, repo, truncate_text(&path, MAX_WORKTREE_PATH_BYTES, " "), branch, state, created_at, updated_at, run_deleted_at, inspection, cleanup, last_error],
            )? > 0 {
                imported += 1;
            }
            Ok(())
        })?;
        tx.commit()?;
        Ok(imported)
    }

    // ── Runs ─────────────────────────────────────────────────────────────

    pub fn list_runs(&self) -> Result<Vec<Run>> {
        let mut statement = self
            .connection
            .prepare("SELECT * FROM orch_runs ORDER BY created_at DESC,id DESC")?;
        let rows = statement.query_map([], map_run)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn orch_run(&self, run_id: &str) -> Result<Run> {
        validate_id(run_id)?;
        self.connection
            .query_row("SELECT * FROM orch_runs WHERE id=?", [run_id], map_run)
            .optional()?
            .ok_or(Error::NotFound)
    }

    fn require_active_run(tx: &Transaction<'_>, run_id: &str) -> Result<Run> {
        let run: Run = tx
            .query_row("SELECT * FROM orch_runs WHERE id=?", [run_id], map_run)
            .optional()?
            .ok_or(Error::NotFound)?;
        if run.status != RunStatus::Active {
            return Err(invalid("the run is settled; history is read-only"));
        }
        Ok(run)
    }

    /// All tasks of a run with their dependency edges, in creation order.
    pub(super) fn run_task_rows(tx: &Transaction<'_>, run_id: &str) -> Result<Vec<TaskRow>> {
        let mut tasks = Vec::new();
        {
            let mut statement = tx.prepare(
                "SELECT id,run_id,title,spec,skills,parent_id,status,result,created_at,updated_at \
                 FROM orch_tasks WHERE run_id=?1 ORDER BY created_at,id",
            )?;
            let rows = statement.query_map([run_id], |row| {
                Ok(TaskRow {
                    id: row.get(0)?,
                    run_id: row.get(1)?,
                    title: row.get(2)?,
                    spec: row.get(3)?,
                    skills: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default(),
                    deps: Vec::new(),
                    parent_id: row.get(5)?,
                    status: TaskStatus::parse(&row.get::<_, String>(6)?)
                        .unwrap_or(TaskStatus::Pending),
                    result: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })?;
            for row in rows {
                tasks.push(row?);
            }
        }
        let mut by_id: HashMap<String, usize> = HashMap::new();
        for (index, task) in tasks.iter().enumerate() {
            by_id.insert(task.id.clone(), index);
        }
        let mut statement = tx.prepare(
            "SELECT task_id,dep_id FROM orch_task_deps WHERE run_id=?1 ORDER BY task_id,position",
        )?;
        let rows = statement.query_map([run_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (task_id, dep_id) = row?;
            if let Some(index) = by_id.get(&task_id) {
                tasks[*index].deps.push(dep_id);
            }
        }
        Ok(tasks)
    }

    pub fn run_snapshot(&mut self, run_id: &str) -> Result<RunSnapshot> {
        validate_id(run_id)?;
        let run = self.orch_run(run_id)?;
        let tx = self.connection.transaction()?;
        let rows = Self::run_task_rows(&tx, run_id)?;
        let mut ready_statement = tx.prepare(
            "SELECT t.id FROM orch_tasks t WHERE t.run_id=?1 AND t.status='pending' \
             AND NOT EXISTS ( \
               SELECT 1 FROM orch_task_deps d JOIN orch_tasks x ON x.id=d.dep_id \
               WHERE d.run_id=?1 AND d.task_id=t.id AND x.status<>'done' \
             ) ORDER BY t.created_at,t.id",
        )?;
        let ready = ready_statement
            .query_map([run_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut dispatch_statement =
            tx.prepare("SELECT * FROM orch_dispatches WHERE run_id=?1 ORDER BY started_at,id")?;
        let dispatches = dispatch_statement
            .query_map([run_id], map_dispatch)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut gate_statement =
            tx.prepare("SELECT * FROM orch_gates WHERE run_id=?1 ORDER BY created_at,id")?;
        let gates = gate_statement
            .query_map([run_id], map_gate)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let tasks = rows.into_iter().map(TaskRow::task).collect();
        Ok(RunSnapshot {
            run,
            tasks,
            ready,
            dispatches,
            gates,
        })
    }

    pub fn list_ready_tasks(&mut self, run_id: &str) -> Result<Vec<Task>> {
        validate_id(run_id)?;
        self.orch_run(run_id)?;
        let tx = self.connection.transaction()?;
        let mut statement = tx.prepare(
            "SELECT id FROM orch_tasks WHERE run_id=?1 AND status='pending' \
             AND NOT EXISTS ( \
               SELECT 1 FROM orch_task_deps d JOIN orch_tasks x ON x.id=d.dep_id \
               WHERE d.run_id=?1 AND d.task_id=orch_tasks.id AND x.status<>'done' \
             ) ORDER BY created_at,id",
        )?;
        let ids = statement
            .query_map([run_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        let rows = Self::run_task_rows(&tx, run_id)?;
        Ok(rows
            .into_iter()
            .filter(|row| ids.contains(&row.id))
            .map(TaskRow::task)
            .collect())
    }

    // ── Graph mutation ───────────────────────────────────────────────────

    fn validate_nodes(nodes: &[GraphNodeInput], allow_empty: bool) -> Result<()> {
        if nodes.is_empty() && !allow_empty {
            return Err(invalid("the task graph must contain at least one node"));
        }
        if nodes.len() > MAX_GRAPH_NODES {
            return Err(invalid("a graph edit may contain at most 200 nodes"));
        }
        let mut ids = HashSet::new();
        for node in nodes {
            let client = node.client_id.trim();
            if client.is_empty() || !ids.insert(client) {
                return Err(invalid("node clientId must be unique and non-empty"));
            }
            validate_text(&node.title, 1024, false)?;
            validate_text(&node.spec, 8192, false)?;
            if node.deps.len() != node.deps.iter().collect::<HashSet<_>>().len() {
                return Err(invalid(&format!(
                    "node {client} lists a duplicate dependency"
                )));
            }
            normalize_skills(&node.skills)?;
        }
        Ok(())
    }

    /// Validate references and run the cycle check over a candidate task set.
    fn validate_candidate(candidates: &HashMap<String, TaskRow>) -> Result<()> {
        for task in candidates.values() {
            for dep in &task.deps {
                let target = candidates
                    .get(dep)
                    .ok_or_else(|| invalid(&format!("dependency does not exist: {dep}")))?;
                if target.run_id != task.run_id {
                    return Err(invalid("dependency belongs to another run"));
                }
            }
            if let Some(parent) = &task.parent_id {
                let target = candidates
                    .get(parent)
                    .ok_or_else(|| invalid(&format!("parent task does not exist: {parent}")))?;
                if target.run_id != task.run_id || target.id == task.id {
                    return Err(invalid("invalid parent task"));
                }
            }
        }
        let edges: HashMap<String, Vec<String>> = candidates
            .iter()
            .map(|(id, task)| (id.clone(), task.deps.clone()))
            .collect();
        if let Some(cycle) = find_cycle(&edges) {
            return Err(invalid(&format!(
                "task dependency cycle: {}",
                cycle.join(" -> ")
            )));
        }
        Ok(())
    }

    fn emit(tx: &Transaction<'_>, kind: &str, id: &str, value: Value) -> Result<()> {
        Store::append_event(tx, "orchestration", kind, id, value).map(|_| ())
    }

    pub fn create_run_graph(&mut self, input: CreateRunGraph) -> Result<GraphMutationResult> {
        validate_id(&input.operation_id)?;
        validate_text(&input.objective, 4096, false)?;
        Self::validate_nodes(&input.nodes, false)?;
        if let Some(coordinator) = &input.coordinator_session_id {
            validate_id(coordinator)?;
        }
        let now = now();
        let run_id = new_id("run");
        let id_map: HashMap<String, String> = input
            .nodes
            .iter()
            .map(|node| (node.client_id.trim().to_owned(), new_id("task")))
            .collect();
        let mut candidates: HashMap<String, TaskRow> = HashMap::new();
        for node in &input.nodes {
            let id = id_map[node.client_id.trim()].clone();
            let deps =
                node.deps
                    .iter()
                    .map(|dep| {
                        id_map.get(dep).cloned().ok_or_else(|| {
                            invalid(&format!("dependency node does not exist: {dep}"))
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
            let parent_id =
                match node.parent_id.as_deref() {
                    None => None,
                    Some(parent) => Some(id_map.get(parent).cloned().ok_or_else(|| {
                        invalid(&format!("parent node does not exist: {parent}"))
                    })?),
                };
            candidates.insert(
                id.clone(),
                TaskRow {
                    id,
                    run_id: run_id.clone(),
                    title: node.title.trim().to_owned(),
                    spec: node.spec.trim().to_owned(),
                    skills: normalize_skills(&node.skills)?,
                    deps,
                    parent_id,
                    status: TaskStatus::Pending,
                    result: None,
                    created_at: now,
                    updated_at: now,
                },
            );
        }
        Self::validate_candidate(&candidates)?;

        let tx = self.connection.transaction()?;
        // New rows may reference siblings inserted later; enforce foreign keys
        // at commit instead of statement-by-statement.
        tx.execute_batch("PRAGMA defer_foreign_keys=ON")?;
        match operation_guard::<GraphMutationResult>(
            &tx,
            &input.operation_id,
            &fingerprint("graph.create", &input),
        )? {
            Idempotent::Replay(result) => return Ok(result),
            Idempotent::Fresh => {}
        }
        let run = Run {
            id: run_id.clone(),
            objective: input.objective.trim().to_owned(),
            status: RunStatus::Active,
            coordinator_session_id: input.coordinator_session_id.clone(),
            automation: None,
            graph_revision: 1,
            created_at: now,
            updated_at: now,
        };
        tx.execute(
            "INSERT INTO orch_runs(id,objective,status,coordinator_session_id,automation,graph_revision,created_at,updated_at) \
             VALUES(?1,?2,'active',?3,NULL,1,?4,?4)",
            params![run.id, run.objective, run.coordinator_session_id, now],
        )?;
        Self::emit(&tx, "run.created", &run.id, serde_json::to_value(&run)?)?;
        let mut ordered: Vec<&TaskRow> = input
            .nodes
            .iter()
            .map(|node| &candidates[&id_map[node.client_id.trim()]])
            .collect();
        ordered.sort_by(|a, b| a.id.cmp(&b.id));
        for task in &ordered {
            Self::insert_task(&tx, task)?;
        }
        let result = GraphMutationResult {
            run: run.clone(),
            tasks: ordered.iter().map(|task| (*task).clone().task()).collect(),
            id_map: id_map.clone(),
            deleted_task_ids: Vec::new(),
        };
        Self::remember(
            &tx,
            &input.operation_id,
            &fingerprint("graph.create", &input),
            &result,
        )?;
        tx.commit()?;
        Ok(result)
    }

    fn insert_task(tx: &Transaction<'_>, task: &TaskRow) -> Result<()> {
        tx.execute(
            "INSERT INTO orch_tasks(id,run_id,title,spec,skills,parent_id,status,result,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,NULL,?8,?8)",
            params![
                task.id,
                task.run_id,
                task.title,
                task.spec,
                serde_json::to_string(&task.skills)?,
                task.parent_id,
                task.status.label(),
                task.created_at,
            ],
        )?;
        for (position, dep) in task.deps.iter().enumerate() {
            tx.execute(
                "INSERT INTO orch_task_deps(run_id,task_id,dep_id,position) VALUES(?1,?2,?3,?4)",
                params![task.run_id, task.id, dep, position as i64],
            )?;
        }
        Self::emit(
            tx,
            "task.created",
            &task.id,
            serde_json::to_value(task.clone().task())?,
        )?;
        Ok(())
    }

    pub fn apply_task_graph(&mut self, input: ApplyTaskGraph) -> Result<GraphMutationResult> {
        validate_id(&input.run_id)?;
        if input.nodes.is_empty() && input.delete_task_ids.is_empty() {
            return Err(invalid("a graph edit must add, change or delete a node"));
        }
        if input.delete_task_ids.len() > MAX_GRAPH_NODES
            || input
                .delete_task_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 128)
            || input.delete_task_ids.len()
                != input.delete_task_ids.iter().collect::<HashSet<_>>().len()
        {
            return Err(invalid("deleteTaskIds must contain at most 200 unique ids"));
        }
        Self::validate_nodes(&input.nodes, true)?;

        let tx = self.connection.transaction()?;
        tx.execute_batch("PRAGMA defer_foreign_keys=ON")?;
        if let Some(operation_id) = &input.operation_id
            && let Idempotent::Replay(result) = operation_guard::<GraphMutationResult>(
                &tx,
                operation_id,
                &fingerprint("graph.apply", &input),
            )?
        {
            return Ok(result);
        }
        let run = Self::require_active_run(&tx, &input.run_id)?;
        if matches!(
            run.automation.as_ref().map(|automation| automation.state),
            Some(AutomationState::Running)
        ) {
            return Err(invalid("任务图正在自动执行；请先暂停，再编辑或手工派发"));
        }
        if run.graph_revision != input.base_revision {
            return Err(Error::Conflict);
        }
        let delete: HashSet<&str> = input.delete_task_ids.iter().map(String::as_str).collect();

        // clientId maps to an existing task (editable pending tasks only) or a
        // fresh id.
        let mut id_map: HashMap<String, String> = HashMap::new();
        for node in &input.nodes {
            let client = node.client_id.trim();
            if delete.contains(client) {
                return Err(invalid(&format!(
                    "node {client} is both edited and deleted"
                )));
            }
            let existing = Self::task_status(&tx, client)?;
            match existing {
                None => {
                    id_map.insert(client.to_owned(), new_id("task"));
                }
                Some((existing_run, status)) => {
                    if existing_run != run.id {
                        return Err(invalid("task belongs to another run"));
                    }
                    if status != TaskStatus::Pending {
                        return Err(invalid("only pending tasks can be edited"));
                    }
                    id_map.insert(client.to_owned(), client.to_owned());
                }
            }
        }

        // Full candidate copy; validation failure never touches real rows.
        let mut candidates: HashMap<String, TaskRow> = Self::run_task_rows(&tx, &run.id)?
            .into_iter()
            .map(|row| (row.id.clone(), row))
            .collect();
        for deleted in &delete {
            let task = candidates
                .get(*deleted)
                .ok_or_else(|| invalid("task to delete does not exist"))?;
            if task.run_id != run.id {
                return Err(invalid("task to delete belongs to another run"));
            }
            if task.status != TaskStatus::Pending {
                return Err(invalid("only pending tasks can be deleted"));
            }
            candidates.remove(*deleted);
        }
        let resolve = |reference: &str, candidates: &HashMap<String, TaskRow>| -> Result<String> {
            if let Some(id) = id_map.get(reference) {
                return Ok(id.clone());
            }
            let task = candidates
                .get(reference)
                .ok_or_else(|| invalid(&format!("referenced node does not exist: {reference}")))?;
            if task.run_id != run.id {
                return Err(invalid("reference belongs to another run"));
            }
            Ok(task.id.clone())
        };
        let now = now();
        for node in &input.nodes {
            let id = id_map[node.client_id.trim()].clone();
            let existing = candidates.get(&id).cloned();
            let deps = node
                .deps
                .iter()
                .map(|dep| resolve(dep, &candidates))
                .collect::<Result<Vec<_>>>()?;
            let parent_id = match node.parent_id.as_deref() {
                None => None,
                Some(parent) => Some(resolve(parent, &candidates)?),
            };
            candidates.insert(
                id.clone(),
                TaskRow {
                    id,
                    run_id: run.id.clone(),
                    title: node.title.trim().to_owned(),
                    spec: node.spec.trim().to_owned(),
                    skills: normalize_skills(&node.skills)?,
                    deps,
                    parent_id,
                    status: existing
                        .as_ref()
                        .map_or(TaskStatus::Pending, |row| row.status),
                    result: existing.as_ref().and_then(|row| row.result.clone()),
                    created_at: existing.as_ref().map_or(now, |row| row.created_at),
                    updated_at: now,
                },
            );
        }
        Self::validate_candidate(&candidates)?;

        // Apply deletions first; cascades remove dispatch/gate rows.
        for deleted in &delete {
            tx.execute("DELETE FROM orch_messages WHERE task_id=?1", [deleted])?;
            tx.execute(
                "DELETE FROM orch_task_deps WHERE task_id=?1 OR dep_id=?1",
                [deleted],
            )?;
            tx.execute("DELETE FROM orch_tasks WHERE id=?1", [deleted])?;
            Self::emit(
                &tx,
                "task.deleted",
                deleted,
                serde_json::json!({"id": deleted}),
            )?;
        }
        // Upsert edits and new nodes.
        let mut changed: Vec<TaskRow> = Vec::new();
        for node in &input.nodes {
            let task = candidates[&id_map[node.client_id.trim()]].clone();
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM orch_tasks WHERE id=?)",
                    [&task.id],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(false);
            if exists {
                tx.execute(
                    "UPDATE orch_tasks SET title=?1,spec=?2,skills=?3,parent_id=?4,updated_at=?5 WHERE id=?6",
                    params![
                        task.title,
                        task.spec,
                        serde_json::to_string(&task.skills)?,
                        task.parent_id,
                        now,
                        task.id
                    ],
                )?;
                tx.execute("DELETE FROM orch_task_deps WHERE task_id=?", [&task.id])?;
                for (position, dep) in task.deps.iter().enumerate() {
                    tx.execute(
                        "INSERT INTO orch_task_deps(run_id,task_id,dep_id,position) VALUES(?1,?2,?3,?4)",
                        params![task.run_id, task.id, dep, position as i64],
                    )?;
                }
                Self::emit(
                    &tx,
                    "task.updated",
                    &task.id,
                    serde_json::to_value(task.clone().task())?,
                )?;
            } else {
                Self::insert_task(&tx, &task)?;
            }
            changed.push(task);
        }
        let revision = run.graph_revision + 1;
        tx.execute(
            "UPDATE orch_runs SET graph_revision=?1,updated_at=?2 WHERE id=?3",
            params![revision, now, run.id],
        )?;
        let run = Store::orch_run_from_tx(&tx, &run.id)?;
        Self::emit(&tx, "run.updated", &run.id, serde_json::to_value(&run)?)?;
        let result = GraphMutationResult {
            run,
            tasks: changed.into_iter().map(TaskRow::task).collect(),
            id_map,
            deleted_task_ids: input.delete_task_ids.clone(),
        };
        if let Some(operation_id) = &input.operation_id {
            Self::remember(
                &tx,
                operation_id,
                &fingerprint("graph.apply", &input),
                &result,
            )?;
        }
        tx.commit()?;
        Ok(result)
    }

    fn task_status(tx: &Transaction<'_>, id: &str) -> Result<Option<(String, TaskStatus)>> {
        tx.query_row(
            "SELECT run_id,status FROM orch_tasks WHERE id=?",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    TaskStatus::parse(&row.get::<_, String>(1)?).unwrap_or(TaskStatus::Pending),
                ))
            },
        )
        .optional()
        .map_err(Error::from)
    }

    fn orch_run_from_tx(tx: &Transaction<'_>, id: &str) -> Result<Run> {
        tx.query_row("SELECT * FROM orch_runs WHERE id=?", [id], map_run)
            .optional()?
            .ok_or(Error::NotFound)
    }

    /// Create a bare active run with no tasks (legacy `run.create`); the
    /// coordinator adds nodes with `task.create` or `graph.apply`.
    pub fn create_run(&mut self, input: CreateRun) -> Result<Run> {
        validate_text(&input.objective, 4096, false)?;
        if let Some(coordinator) = &input.coordinator_session_id {
            validate_id(coordinator)?;
        }
        let now = now();
        let run = Run {
            id: new_id("run"),
            objective: input.objective.trim().to_owned(),
            status: RunStatus::Active,
            coordinator_session_id: input.coordinator_session_id,
            automation: None,
            graph_revision: 0,
            created_at: now,
            updated_at: now,
        };
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO orch_runs(id,objective,status,coordinator_session_id,automation,graph_revision,created_at,updated_at) \
             VALUES(?1,?2,'active',?3,NULL,0,?4,?4)",
            params![run.id, run.objective, run.coordinator_session_id, now],
        )?;
        Self::emit(&tx, "run.created", &run.id, serde_json::to_value(&run)?)?;
        tx.commit()?;
        Ok(run)
    }

    /// Append a single task to an active run (legacy `task.create`). Edges and
    /// the cycle are checked over the whole resulting graph.
    pub fn create_task(&mut self, input: CreateTask) -> Result<Task> {
        validate_id(&input.run_id)?;
        validate_text(&input.title, 1024, false)?;
        validate_text(&input.spec, 8192, false)?;
        let skills = normalize_skills(&input.skills)?;
        if input.deps.len() != input.deps.iter().collect::<HashSet<_>>().len() {
            return Err(invalid("the task lists a duplicate dependency"));
        }
        for dep in &input.deps {
            validate_id(dep)?;
        }
        if let Some(parent) = &input.parent_id {
            validate_id(parent)?;
        }

        let tx = self.connection.transaction()?;
        tx.execute_batch("PRAGMA defer_foreign_keys=ON")?;
        let run = Self::require_active_run(&tx, &input.run_id)?;
        if matches!(
            run.automation.as_ref().map(|automation| automation.state),
            Some(AutomationState::Running)
        ) {
            return Err(invalid("任务图正在自动执行；请先暂停，再编辑或手工派发"));
        }
        let now = now();
        let id = new_id("task");
        let candidate = TaskRow {
            id: id.clone(),
            run_id: input.run_id.clone(),
            title: input.title.trim().to_owned(),
            spec: input.spec.trim().to_owned(),
            skills,
            deps: input.deps.clone(),
            parent_id: input.parent_id.clone(),
            status: TaskStatus::Pending,
            result: None,
            created_at: now,
            updated_at: now,
        };
        let mut graph: HashMap<String, TaskRow> = Self::run_task_rows(&tx, &input.run_id)?
            .into_iter()
            .map(|row| (row.id.clone(), row))
            .collect();
        graph.insert(id.clone(), candidate.clone());
        Self::validate_candidate(&graph)?;
        Self::insert_task(&tx, &candidate)?;
        tx.execute(
            "UPDATE orch_runs SET graph_revision=graph_revision+1,updated_at=?1 WHERE id=?2",
            params![now, input.run_id],
        )?;
        let run = Self::orch_run_from_tx(&tx, &input.run_id)?;
        Self::emit(&tx, "run.updated", &run.id, serde_json::to_value(&run)?)?;
        tx.commit()?;
        Ok(candidate.task())
    }

    /// Delete a run's history. The directory resource outlives the rows: the
    /// run's worktree assets are detached (state `preserved`, run_deleted_at
    /// stamped) rather than deleted; the caller removes disk content only
    /// through the explicit, freshly re-inspected cleanup path.
    pub fn delete_run(&mut self, run_id: &str, force: bool) -> Result<RunDeletionResult> {
        validate_id(run_id)?;
        let tx = self.connection.transaction()?;
        let run = Self::orch_run_from_tx(&tx, run_id)?;
        let now = now();
        Self::pause_running_automation_tx(&tx, &run, now, None)?;
        let active: i64 = tx.query_row(
            "SELECT count(*) FROM orch_dispatches WHERE run_id=?1 AND state IN ('starting','running')",
            [run_id],
            |row| row.get(0),
        )?;
        if active > 0 && !force {
            return Err(invalid(
                "the run still has a live worker; stop it or delete with force",
            ));
        }
        if active > 0 {
            // Forced historical cleanup: converge the dispatch rows but leave
            // the disk trees indexed for manual recovery.
            let reason =
                "explicit historical run cleanup; worktree assets preserved for manual recovery";
            tx.execute(
                "UPDATE orch_dispatches SET state='abandoned',outcome=?1,settled_at=?2 \
                 WHERE run_id=?3 AND state IN ('starting','running')",
                params![reason, now, run_id],
            )?;
            tx.execute(
                "UPDATE orch_tasks SET status='failed',result=?1,updated_at=?2 \
                 WHERE run_id=?3 AND status='dispatched'",
                params![reason, now, run_id],
            )?;
        }
        let deleted_task_count: i64 = tx.query_row(
            "SELECT count(*) FROM orch_tasks WHERE run_id=?",
            [run_id],
            |row| row.get(0),
        )?;
        // Detach assets first so the ids survive the cascade in the result.
        let mut preserved_ids = Vec::new();
        {
            let mut statement = tx.prepare(
                "SELECT id FROM orch_worktree_assets WHERE run_id=?1 ORDER BY created_at,id",
            )?;
            let ids = statement
                .query_map([run_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            for id in ids {
                tx.execute(
                    "UPDATE orch_worktree_assets SET state='preserved',run_deleted_at=COALESCE(run_deleted_at,?1),updated_at=?1,last_error=?2 \
                     WHERE id=?3 AND cleanup IS NULL AND state<>'missing'",
                    params![now, "所属 Run 已删除；资产与恢复分支仍保留，需显式检查或清理", id],
                )?;
                tx.execute(
                    "UPDATE orch_worktree_assets SET run_deleted_at=COALESCE(run_deleted_at,?1),updated_at=?1 WHERE id=?2",
                    params![now, id],
                )?;
                let asset = Self::asset_row(&tx, &id)?;
                Self::emit(
                    &tx,
                    "worktree_asset.updated",
                    &id,
                    serde_json::to_value(&asset)?,
                )?;
                preserved_ids.push(id);
            }
        }
        tx.execute("DELETE FROM orch_runs WHERE id=?", [run_id])?;
        Self::emit(
            &tx,
            "run.deleted",
            run_id,
            serde_json::json!({ "id": run_id }),
        )?;
        tx.commit()?;
        Ok(RunDeletionResult {
            run_id: run_id.to_owned(),
            deleted_task_count,
            preserved_worktree_asset_ids: preserved_ids,
        })
    }

    // ── Tasks ────────────────────────────────────────────────────────────

    pub fn task(&mut self, task_id: &str) -> Result<Task> {
        validate_id(task_id)?;
        let tx = self.connection.transaction()?;
        Self::task_row(&tx, task_id).map(TaskRow::task)
    }

    fn task_row(tx: &Transaction<'_>, task_id: &str) -> Result<TaskRow> {
        let row = tx
            .query_row(
                "SELECT id,run_id,title,spec,skills,parent_id,status,result,created_at,updated_at \
                 FROM orch_tasks WHERE id=?",
                [task_id],
                |row| {
                    Ok(TaskRow {
                        id: row.get(0)?,
                        run_id: row.get(1)?,
                        title: row.get(2)?,
                        spec: row.get(3)?,
                        skills: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default(),
                        deps: Vec::new(),
                        parent_id: row.get(5)?,
                        status: TaskStatus::parse(&row.get::<_, String>(6)?)
                            .unwrap_or(TaskStatus::Pending),
                        result: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    })
                },
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        let mut row = row;
        let mut statement =
            tx.prepare("SELECT dep_id FROM orch_task_deps WHERE task_id=?1 ORDER BY position")?;
        row.deps = statement
            .query_map([task_id], |dep| dep.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(row)
    }

    pub fn list_tasks(&mut self, run_id: Option<&str>) -> Result<Vec<Task>> {
        let tx = self.connection.transaction()?;
        let rows = match run_id {
            Some(run_id) => {
                validate_id(run_id)?;
                Self::run_task_rows(&tx, run_id)?
            }
            None => {
                let ids = tx
                    .prepare("SELECT id FROM orch_runs ORDER BY created_at,id")?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let mut rows = Vec::new();
                for id in ids {
                    rows.extend(Self::run_task_rows(&tx, &id)?);
                }
                rows
            }
        };
        Ok(rows.into_iter().map(TaskRow::task).collect())
    }

    /// Move a task through the explicit transition table; the run must be
    /// active. Same-state writes are allowed so retried commands are idempotent.
    fn set_task_status(
        tx: &Transaction<'_>,
        task_id: &str,
        status: TaskStatus,
        result: Option<Option<String>>,
    ) -> Result<Task> {
        Self::write_task_status(tx, task_id, status, result, false)
    }

    /// Gate resolution may restore a blocked task straight to `dispatched` when
    /// its worker survived — a transition the normal table forbids.
    fn force_task_status(
        tx: &Transaction<'_>,
        task_id: &str,
        status: TaskStatus,
        result: Option<Option<String>>,
    ) -> Result<Task> {
        Self::write_task_status(tx, task_id, status, result, true)
    }

    fn write_task_status(
        tx: &Transaction<'_>,
        task_id: &str,
        status: TaskStatus,
        result: Option<Option<String>>,
        force: bool,
    ) -> Result<Task> {
        let task = Self::task_row(tx, task_id)?;
        Self::require_active_run(tx, &task.run_id)?;
        if !force && !can_transition(task.status, status) {
            return Err(invalid(&format!(
                "task cannot transition {} -> {}",
                task.status.label(),
                status.label()
            )));
        }
        let now = now();
        match result {
            Some(value) => {
                tx.execute(
                    "UPDATE orch_tasks SET status=?1,result=?2,updated_at=?3 WHERE id=?4",
                    params![status.label(), value, now, task_id],
                )?;
            }
            None => {
                tx.execute(
                    "UPDATE orch_tasks SET status=?1,updated_at=?2 WHERE id=?3",
                    params![status.label(), now, task_id],
                )?;
            }
        }
        let updated = Self::task_row(tx, task_id)?;
        Self::emit(
            tx,
            "task.updated",
            task_id,
            serde_json::to_value(updated.clone().task())?,
        )?;
        Ok(updated.task())
    }

    pub fn cancel_task(&mut self, task_id: &str, reason: &str) -> Result<Task> {
        validate_id(task_id)?;
        validate_text(reason, 8192, false)?;
        let tx = self.connection.transaction()?;
        let task = Self::task_row(&tx, task_id)?;
        let run = Self::require_active_run(&tx, &task.run_id)?;
        let now = now();
        Self::pause_running_automation_tx(&tx, &run, now, None)?;
        if task.status == TaskStatus::Cancelled {
            return Ok(task.task());
        }
        if Self::active_dispatch(&tx, task_id)?.is_some() {
            return Err(invalid("stop the worker before cancelling the task"));
        }
        if !matches!(task.status, TaskStatus::Pending | TaskStatus::Blocked) {
            return Err(invalid("only pending or blocked tasks can be cancelled"));
        }
        tx.execute(
            "UPDATE orch_tasks SET status='cancelled',result=?1,updated_at=?2 WHERE id=?3",
            params![reason, now, task_id],
        )?;
        tx.execute(
            "UPDATE orch_gates SET status='cancelled',resolved_at=?1 \
             WHERE task_id=?2 AND status='pending'",
            params![now, task_id],
        )?;
        let updated = Self::task_row(&tx, task_id)?.task();
        Self::emit(
            &tx,
            "task.updated",
            task_id,
            serde_json::to_value(&updated)?,
        )?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn retry_task(&mut self, task_id: &str) -> Result<Task> {
        validate_id(task_id)?;
        let tx = self.connection.transaction()?;
        let task = Self::task_row(&tx, task_id)?;
        let run = Self::require_active_run(&tx, &task.run_id)?;
        Self::pause_running_automation_tx(&tx, &run, now(), None)?;
        if task.status != TaskStatus::Failed {
            return Err(invalid("only failed tasks can be retried"));
        }
        let updated = Self::set_task_status(&tx, task_id, TaskStatus::Pending, Some(None))?;
        tx.commit()?;
        Ok(updated)
    }

    // ── Dispatches ───────────────────────────────────────────────────────

    fn active_dispatch(tx: &Transaction<'_>, task_id: &str) -> Result<Option<Dispatch>> {
        tx.query_row(
            "SELECT * FROM orch_dispatches WHERE task_id=?1 AND state IN ('starting','running') \
             ORDER BY started_at DESC,id DESC LIMIT 1",
            [task_id],
            map_dispatch,
        )
        .optional()
        .map_err(Error::from)
    }

    /// The live dispatch (starting/running) for a task, if any.
    pub fn live_dispatch_for_task(&mut self, task_id: &str) -> Result<Option<Dispatch>> {
        validate_id(task_id)?;
        let tx = self.connection.transaction()?;
        Self::active_dispatch(&tx, task_id)
    }

    /// Probe the idempotency ledger with a caller-owned fingerprint (the worker
    /// service fingerprints the *request*, since the session id is an output).
    pub fn probe_operation<T: DeserializeOwned>(
        &mut self,
        id: &str,
        fingerprint: &str,
    ) -> Result<OperationReplay<T>> {
        validate_id(id)?;
        let tx = self.connection.transaction()?;
        match operation_guard::<T>(&tx, id, fingerprint)? {
            Idempotent::Replay(value) => Ok(OperationReplay::Replay(value)),
            Idempotent::Fresh => Ok(OperationReplay::Fresh),
        }
    }

    pub fn remember_operation<T: Serialize>(
        &mut self,
        id: &str,
        fingerprint: &str,
        result: &T,
    ) -> Result<()> {
        validate_id(id)?;
        let tx = self.connection.transaction()?;
        Self::remember(&tx, id, fingerprint, result)?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn worker_start(&mut self, operation_id: &str) -> Result<WorkerStartOperation> {
        validate_id(operation_id)?;
        let tx = self.connection.transaction()?;
        let mut operation = tx
            .query_row(
                "SELECT * FROM orch_worker_starts WHERE operation_id=?1",
                [operation_id],
                map_worker_start,
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        if let Some(outcome) = operation.outcome.as_mut() {
            if let Ok(task) = Self::task_row(&tx, &operation.task_id) {
                outcome.task = task.task();
            }
            if let Some(dispatch_id) = operation.dispatch_id.as_deref()
                && let Ok(dispatch) = Self::dispatch_row(&tx, dispatch_id)
            {
                outcome.dispatch = dispatch;
            }
            if let Some(asset_id) = operation.asset_id.as_deref()
                && let Ok(asset) = Self::asset_row(&tx, asset_id)
            {
                outcome.worktree = Some(asset);
            }
        }
        tx.commit()?;
        Ok(operation)
    }

    pub(super) fn enqueue_worker_start(
        &mut self,
        operation_id: &str,
        request_fingerprint: &str,
        run_id: &str,
        input: &StartWorker,
    ) -> Result<super::start::WorkerStartEnqueue> {
        validate_id(operation_id)?;
        validate_id(&input.task_id)?;
        validate_id(run_id)?;
        validate_text(request_fingerprint, 4096, false)?;
        let request = serde_json::to_string(input)?;
        let agent = label(input.agent)?;
        let account_scope = input
            .account_id
            .clone()
            .unwrap_or_else(|| format!("native-{agent}"));
        let plugin_scope = input.plugin_id.clone().unwrap_or_else(|| {
            format!(
                "unscoped-{}",
                fingerprint("worker.start.plugin", &operation_id)
            )
        });
        let profile_scope = input.profile_id.clone().unwrap_or_else(|| {
            format!(
                "unscoped-{}",
                fingerprint("worker.start.profile", &operation_id)
            )
        });
        validate_text(&account_scope, 128, false)?;
        validate_text(&plugin_scope, 128, false)?;
        validate_text(&profile_scope, 128, false)?;
        let tx = self.connection.transaction()?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT fingerprint FROM orch_worker_starts WHERE operation_id=?1",
                [operation_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            if existing != request_fingerprint {
                return Err(invalid("operation id was already used for another request"));
            }
            let operation = tx.query_row(
                "SELECT * FROM orch_worker_starts WHERE operation_id=?1",
                [operation_id],
                map_worker_start,
            )?;
            return Ok(super::start::WorkerStartEnqueue::Existing(operation));
        }
        let legacy: Option<(String, String, i64)> = tx
            .query_row(
                "SELECT fingerprint,result,created_at FROM orch_operations WHERE id=?1",
                [operation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((legacy_fingerprint, legacy_result, created_at)) = legacy {
            let expected = fingerprint(
                "worker.start",
                &serde_json::json!({
                    "taskId": input.task_id,
                    "cwd": input.cwd,
                    "worktree": input.worktree,
                }),
            );
            if legacy_fingerprint != expected {
                return Err(invalid("operation id was already used for another request"));
            }
            let outcome: WorkerStartOutcome = serde_json::from_str(&legacy_result)
                .map_err(|_| invalid("operation id was already used for another request"))?;
            if outcome.task.id != input.task_id || outcome.task.run_id != run_id {
                return Err(invalid("operation id was already used for another request"));
            }
            let ticket: i64 = tx.query_row(
                "SELECT COALESCE(max(ticket),-1)+1 FROM orch_worker_starts",
                [],
                |row| row.get(0),
            )?;
            let asset_id = outcome.worktree.as_ref().map(|asset| asset.id.as_str());
            let worktree_path = outcome.worktree.as_ref().map(|asset| asset.path.as_str());
            tx.execute(
                "INSERT INTO orch_worker_starts(operation_id,fingerprint,request,phase,task_id,run_id,agent,account_scope,plugin_scope,profile_scope,ticket,worktree_repo,worktree_path,worktree_branch,asset_id,session_id,dispatch_id,result,error,error_code,created_at,updated_at) \
                 VALUES(?1,?2,?3,'running',?4,?5,?6,?7,?8,?9,?10,NULL,?11,NULL,?12,?13,?14,?15,NULL,NULL,?16,?16)",
                params![
                    operation_id,
                    request_fingerprint,
                    request,
                    input.task_id,
                    run_id,
                    agent,
                    account_scope,
                    plugin_scope,
                    profile_scope,
                    ticket,
                    worktree_path,
                    asset_id,
                    outcome.session_id,
                    outcome.dispatch.id,
                    legacy_result,
                    created_at
                ],
            )?;
            let operation = tx.query_row(
                "SELECT * FROM orch_worker_starts WHERE operation_id=?1",
                [operation_id],
                map_worker_start,
            )?;
            tx.commit()?;
            return Ok(super::start::WorkerStartEnqueue::Existing(operation));
        }
        let reserved: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM orch_worker_starts WHERE task_id=?1 AND phase IN ('queued','preparing','worktree_created','session_created','dispatch_committed','delivering'))",
            [&input.task_id],
            |row| row.get(0),
        )?;
        if reserved {
            return Err(Error::Feature(
                "task_not_editable".into(),
                "the task already has a pending worker start".into(),
            ));
        }
        let task = Self::task_row(&tx, &input.task_id)?;
        if task.run_id != run_id {
            return Err(invalid("worker start run does not own the task"));
        }
        Self::require_active_run(&tx, run_id)?;
        if Self::active_dispatch(&tx, &input.task_id)?.is_some()
            || !can_transition(task.status, TaskStatus::Dispatched)
        {
            return Err(Error::Feature(
                "task_not_editable".into(),
                "the task cannot accept another worker".into(),
            ));
        }
        let unmet: i64 = tx.query_row(
            "SELECT count(*) FROM orch_task_deps d JOIN orch_tasks x ON x.id=d.dep_id WHERE d.task_id=?1 AND x.status<>'done'",
            [&input.task_id],
            |row| row.get(0),
        )?;
        if unmet > 0 {
            return Err(Error::Feature(
                "task_not_ready".into(),
                "the task dependencies are not all done".into(),
            ));
        }
        let queue_depth: i64 = tx.query_row(
            "SELECT count(*) FROM orch_worker_starts WHERE phase='queued'",
            [],
            |row| row.get(0),
        )?;
        let limits = super::start::worker_start_limits();
        if queue_depth >= limits.queue {
            return Err(Error::Backpressure(crate::error::ResourceBackpressure {
                retry_after_ms: 250,
                operation: "worker.start".into(),
                resource: "worker_start_admission".into(),
                queue_depth: queue_depth as usize,
                queue_capacity: limits.queue as usize,
                side_effect_committed: Some(false),
            }));
        }
        let ticket: i64 = tx.query_row(
            "SELECT COALESCE(max(ticket),-1)+1 FROM orch_worker_starts",
            [],
            |row| row.get(0),
        )?;
        let timestamp = now();
        tx.execute(
            "INSERT INTO orch_worker_starts(operation_id,fingerprint,request,phase,task_id,run_id,agent,account_scope,plugin_scope,profile_scope,ticket,worktree_repo,worktree_path,worktree_branch,asset_id,session_id,dispatch_id,result,error,error_code,created_at,updated_at) \
             VALUES(?1,?2,?3,'queued',?4,?5,?6,?7,?8,?9,?10,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?11,?11)",
            params![
                operation_id,
                request_fingerprint,
                request,
                input.task_id,
                run_id,
                agent,
                account_scope,
                plugin_scope,
                profile_scope,
                ticket,
                timestamp
            ],
        )?;
        let operation = tx.query_row(
            "SELECT * FROM orch_worker_starts WHERE operation_id=?1",
            [operation_id],
            map_worker_start,
        )?;
        tx.commit()?;
        Ok(super::start::WorkerStartEnqueue::Fresh(operation))
    }

    pub(super) fn claim_next_worker_start(
        &mut self,
    ) -> Result<Option<super::start::WorkerStartClaim>> {
        let mut statement_count = 0;
        self.claim_next_worker_start_inner(&mut statement_count)
    }

    fn claim_next_worker_start_inner(
        &mut self,
        statement_count: &mut usize,
    ) -> Result<Option<super::start::WorkerStartClaim>> {
        let tx = self.connection.transaction()?;
        let limits = super::start::worker_start_limits();
        let pending_filter = "('preparing','worktree_created')";
        let scope_filter =
            "('preparing','worktree_created','session_created','dispatch_committed','delivering')";
        *statement_count += 1;
        tx.execute(
            "UPDATE orch_worker_starts AS s SET phase='failed',error='task changed while waiting for admission',error_code='task_not_editable',updated_at=?1 \
             WHERE s.phase='queued' AND ( \
               NOT EXISTS (SELECT 1 FROM orch_tasks t JOIN orch_runs r ON r.id=t.run_id WHERE t.id=s.task_id AND t.run_id=s.run_id AND t.status='pending' AND r.status='active') \
               OR EXISTS (SELECT 1 FROM orch_dispatches d WHERE d.task_id=s.task_id AND d.state IN ('starting','running')) \
             )",
            [now()],
        )?;
        *statement_count += 1;
        tx.execute(
            "UPDATE orch_worker_starts AS s SET phase='failed',error='task dependencies changed while waiting for admission',error_code='task_not_ready',updated_at=?1 \
             WHERE s.phase='queued' AND EXISTS ( \
               SELECT 1 FROM orch_task_deps d JOIN orch_tasks x ON x.id=d.dep_id \
               WHERE d.task_id=s.task_id AND x.status<>'done' \
             )",
            [now()],
        )?;
        *statement_count += 1;
        let active: i64 = tx.query_row(
            &format!("SELECT (SELECT count(*) FROM agent_runs WHERE active=1) + (SELECT count(*) FROM orch_worker_starts WHERE phase IN {pending_filter})"),
            [],
            |row| row.get(0),
        )?;
        if active >= limits.global {
            tx.commit()?;
            return Ok(None);
        }
        *statement_count += 1;
        let agent_usage = grouped_count(
            &tx,
            &format!(
                "SELECT key,sum(amount) FROM ( \
                   SELECT agent AS key,count(*) AS amount FROM agent_runs WHERE active=1 GROUP BY agent \
                   UNION ALL \
                   SELECT agent AS key,count(*) AS amount FROM orch_worker_starts WHERE phase IN {pending_filter} GROUP BY agent \
                 ) GROUP BY key"
            ),
        )?;
        *statement_count += 1;
        let account_usage = grouped_count(
            &tx,
            &format!(
                "SELECT key,sum(amount) FROM ( \
                   SELECT coalesce(account_id,'native-' || agent) AS key,count(*) AS amount FROM agent_runs WHERE active=1 GROUP BY key \
                   UNION ALL \
                   SELECT account_scope AS key,count(*) AS amount FROM orch_worker_starts WHERE phase IN {pending_filter} GROUP BY account_scope \
                 ) GROUP BY key"
            ),
        )?;
        *statement_count += 1;
        let run_usage = grouped_count(
            &tx,
            "SELECT key,sum(amount) FROM ( \
               SELECT run_id AS key,count(*) AS amount FROM orch_dispatches WHERE state IN ('starting','running') GROUP BY run_id \
               UNION ALL \
               SELECT run_id AS key,count(*) AS amount FROM orch_worker_starts WHERE phase IN ('preparing','worktree_created','session_created') GROUP BY run_id \
             ) GROUP BY key",
        )?;
        *statement_count += 1;
        let plugin_usage = grouped_count(
            &tx,
            &format!(
                "SELECT s.plugin_scope,count(*) FROM orch_worker_starts s \
                 LEFT JOIN orch_dispatches d ON d.id=s.dispatch_id \
                 WHERE s.phase IN {scope_filter} OR (s.phase='running' AND d.state IN ('starting','running')) \
                 GROUP BY s.plugin_scope"
            ),
        )?;
        *statement_count += 1;
        let profile_usage = grouped_count(
            &tx,
            &format!(
                "SELECT s.profile_scope,count(*) FROM orch_worker_starts s \
                 LEFT JOIN orch_dispatches d ON d.id=s.dispatch_id \
                 WHERE s.phase IN {scope_filter} OR (s.phase='running' AND d.state IN ('starting','running')) \
                 GROUP BY s.profile_scope"
            ),
        )?;
        *statement_count += 1;
        let mut statement = tx.prepare(
            "SELECT operation_id,agent,account_scope,plugin_scope,profile_scope,run_id,request \
             FROM orch_worker_starts WHERE phase='queued' ORDER BY ticket,operation_id",
        )?;
        let queued = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for (operation_id, agent, account, plugin, profile, run_id, request) in queued {
            if agent_usage.get(&agent).copied().unwrap_or(0) >= limits.agent
                || account_usage.get(&account).copied().unwrap_or(0) >= limits.account
                || run_usage.get(&run_id).copied().unwrap_or(0) >= limits.run
                || plugin_usage.get(&plugin).copied().unwrap_or(0) >= limits.plugin
                || profile_usage.get(&profile).copied().unwrap_or(0) >= limits.profile
            {
                continue;
            }
            *statement_count += 1;
            tx.execute(
                "UPDATE orch_worker_starts SET phase='preparing',updated_at=?1 WHERE operation_id=?2 AND phase='queued'",
                params![now(), operation_id],
            )?;
            let input = serde_json::from_str(&request)?;
            tx.commit()?;
            return Ok(Some(super::start::WorkerStartClaim {
                operation_id,
                input,
            }));
        }
        tx.commit()?;
        Ok(None)
    }

    #[cfg(test)]
    fn claim_next_worker_start_statement_count(
        &mut self,
    ) -> Result<(Option<super::start::WorkerStartClaim>, usize)> {
        let mut statement_count = 0;
        let claim = self.claim_next_worker_start_inner(&mut statement_count)?;
        Ok((claim, statement_count))
    }

    pub fn plan_worker_start_worktree(
        &mut self,
        operation_id: &str,
        repo: &str,
        path: &str,
        branch: &str,
    ) -> Result<()> {
        validate_id(operation_id)?;
        validate_text(repo, 4096, false)?;
        validate_text(path, 4096, false)?;
        validate_text(branch, 256, false)?;
        let changed = self.connection.execute(
            "UPDATE orch_worker_starts SET worktree_repo=?1,worktree_path=?2,worktree_branch=?3,updated_at=?4 WHERE operation_id=?5 AND phase='preparing'",
            params![repo, path, branch, now(), operation_id],
        )?;
        if changed == 1 {
            Ok(())
        } else {
            Err(Error::Conflict)
        }
    }

    pub fn record_worker_start_worktree(
        &mut self,
        operation_id: &str,
        input: RegisterWorktree,
    ) -> Result<WorktreeAsset> {
        validate_id(operation_id)?;
        validate_id(&input.run_id)?;
        validate_text(&input.repo, 4096, false)?;
        validate_text(&input.path, 4096, false)?;
        let tx = self.connection.transaction()?;
        let phase: String = tx.query_row(
            "SELECT phase FROM orch_worker_starts WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )?;
        if phase != "preparing" {
            return Err(Error::Conflict);
        }
        let timestamp = now();
        let asset_id = new_id("wt");
        tx.execute(
            "INSERT INTO orch_worktree_assets(id,kind,run_id,task_id,dispatch_id,repo,path,branch,state,created_at,updated_at,run_deleted_at,last_inspection,cleanup,last_error) \
             VALUES(?1,?2,?3,?4,NULL,?5,?6,?7,'active',?8,?8,NULL,NULL,NULL,NULL)",
            params![asset_id, asset_kind_label(input.kind), input.run_id, input.task_id, input.repo, input.path, input.branch, timestamp],
        )?;
        tx.execute(
            "UPDATE orch_worker_starts SET phase='worktree_created',asset_id=?1,updated_at=?2 WHERE operation_id=?3",
            params![asset_id, timestamp, operation_id],
        )?;
        let asset = Self::asset_row(&tx, &asset_id)?;
        Self::emit(
            &tx,
            "worktree_asset.updated",
            &asset_id,
            serde_json::to_value(&asset)?,
        )?;
        tx.commit()?;
        Ok(asset)
    }

    pub fn plan_worker_start_session(
        &mut self,
        operation_id: &str,
        session_id: &str,
    ) -> Result<()> {
        validate_id(operation_id)?;
        validate_id(session_id)?;
        let changed = self.connection.execute(
            "UPDATE orch_worker_starts SET session_id=?1,updated_at=?2 WHERE operation_id=?3 AND phase IN ('preparing','worktree_created')",
            params![session_id, now(), operation_id],
        )?;
        if changed == 1 {
            Ok(())
        } else {
            Err(Error::Conflict)
        }
    }

    pub fn record_worker_start_session(
        &mut self,
        operation_id: &str,
        session_id: &str,
    ) -> Result<()> {
        validate_id(operation_id)?;
        validate_id(session_id)?;
        let changed = self.connection.execute(
            "UPDATE orch_worker_starts SET phase='session_created',updated_at=?1 WHERE operation_id=?2 AND session_id=?3 AND phase IN ('preparing','worktree_created')",
            params![now(), operation_id, session_id],
        )?;
        if changed == 1 {
            Ok(())
        } else {
            Err(Error::Conflict)
        }
    }

    pub fn commit_worker_start_dispatch(
        &mut self,
        operation_id: &str,
        task_id: &str,
        session_id: &str,
        worktree_path: Option<&str>,
    ) -> Result<SettleOutcome> {
        validate_id(operation_id)?;
        validate_id(task_id)?;
        validate_id(session_id)?;
        let tx = self.connection.transaction()?;
        let (phase, asset_id): (String, Option<String>) = tx.query_row(
            "SELECT phase,asset_id FROM orch_worker_starts WHERE operation_id=?1 AND task_id=?2 AND session_id=?3",
            params![operation_id, task_id, session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if phase != "session_created" {
            return Err(Error::Conflict);
        }
        let task = Self::task_row(&tx, task_id)?;
        Self::require_active_run(&tx, &task.run_id)?;
        if Self::active_dispatch(&tx, task_id)?.is_some() {
            return Err(Error::Feature(
                "task_not_editable".into(),
                "the task already has a live worker; settle it first".into(),
            ));
        }
        let unmet: i64 = tx.query_row(
            "SELECT count(*) FROM orch_task_deps d JOIN orch_tasks x ON x.id=d.dep_id WHERE d.task_id=?1 AND x.status<>'done'",
            [task_id],
            |row| row.get(0),
        )?;
        if unmet > 0 {
            return Err(Error::Feature(
                "task_not_ready".into(),
                "task is not ready for dispatch".into(),
            ));
        }
        if !can_transition(task.status, TaskStatus::Dispatched) {
            return Err(Error::Feature(
                "task_not_editable".into(),
                "task is not editable for dispatch".into(),
            ));
        }
        let timestamp = now();
        let dispatch_id = new_id("disp");
        tx.execute(
            "INSERT INTO orch_dispatches(id,run_id,task_id,session_id,state,outcome,started_at,settled_at,worktree_path) VALUES(?1,?2,?3,?4,'starting',NULL,?5,NULL,?6)",
            params![dispatch_id, task.run_id, task_id, session_id, timestamp, worktree_path],
        )?;
        let task = Self::set_task_status(&tx, task_id, TaskStatus::Dispatched, None)?;
        if let Some(asset_id) = asset_id {
            tx.execute(
                "UPDATE orch_worktree_assets SET dispatch_id=?1,updated_at=?2 WHERE id=?3 AND run_id=?4 AND task_id=?5",
                params![dispatch_id, timestamp, asset_id, task.run_id, task_id],
            )?;
            let asset = Self::asset_row(&tx, &asset_id)?;
            Self::emit(
                &tx,
                "worktree_asset.updated",
                &asset_id,
                serde_json::to_value(asset)?,
            )?;
        }
        tx.execute(
            "UPDATE orch_worker_starts SET phase='dispatch_committed',dispatch_id=?1,updated_at=?2 WHERE operation_id=?3",
            params![dispatch_id, timestamp, operation_id],
        )?;
        let dispatch = Self::dispatch_row(&tx, &dispatch_id)?;
        Self::emit(
            &tx,
            "dispatch.updated",
            &dispatch_id,
            serde_json::to_value(&dispatch)?,
        )?;
        tx.commit()?;
        Ok(SettleOutcome { task, dispatch })
    }

    pub fn mark_worker_start_delivering(&mut self, operation_id: &str) -> Result<()> {
        validate_id(operation_id)?;
        let changed = self.connection.execute(
            "UPDATE orch_worker_starts SET phase='delivering',updated_at=?1 WHERE operation_id=?2 AND phase='dispatch_committed'",
            params![now(), operation_id],
        )?;
        if changed == 1 {
            Ok(())
        } else {
            Err(Error::Conflict)
        }
    }

    pub fn fail_worker_start_delivery(&mut self, operation_id: &str, message: &str) -> Result<()> {
        validate_id(operation_id)?;
        validate_text(message, 8192, false)?;
        let tx = self.connection.transaction()?;
        let dispatch_id: Option<String> = tx.query_row(
            "SELECT dispatch_id FROM orch_worker_starts WHERE operation_id=?1 AND phase='delivering'",
            [operation_id],
            |row| row.get(0),
        )?;
        let dispatch_id = dispatch_id.ok_or(Error::Closed)?;
        let timestamp = now();
        tx.execute(
            "UPDATE orch_dispatches SET state='abandoned',outcome=?1,settled_at=?2 WHERE id=?3 AND state='starting'",
            params![message, timestamp, dispatch_id],
        )?;
        tx.execute(
            "UPDATE orch_tasks SET status='failed',result=?1,updated_at=?2 WHERE id=(SELECT task_id FROM orch_dispatches WHERE id=?3) AND status='dispatched'",
            params![message, timestamp, dispatch_id],
        )?;
        Self::preserve_dispatch_assets_tx(&tx, &dispatch_id, Some(message))?;
        tx.execute(
            "UPDATE orch_worker_starts SET phase='failed',error=?1,error_code='prompt_delivery_failed',updated_at=?2 WHERE operation_id=?3",
            params![message, timestamp, operation_id],
        )?;
        let dispatch = Self::dispatch_row(&tx, &dispatch_id)?;
        Self::emit(
            &tx,
            "dispatch.updated",
            &dispatch_id,
            serde_json::to_value(dispatch)?,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn complete_worker_start(&mut self, operation_id: &str) -> Result<WorkerStartOutcome> {
        validate_id(operation_id)?;
        let tx = self.connection.transaction()?;
        let (phase, task_id, session_id, dispatch_id, asset_id): (
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = tx.query_row(
            "SELECT phase,task_id,session_id,dispatch_id,asset_id FROM orch_worker_starts WHERE operation_id=?1",
            [operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )?;
        if phase != "delivering" {
            return Err(Error::Conflict);
        }
        let session_id = session_id.ok_or(Error::Closed)?;
        let dispatch_id = dispatch_id.ok_or(Error::Closed)?;
        tx.execute(
            "UPDATE orch_dispatches SET state='running' WHERE id=?1 AND state='starting'",
            [&dispatch_id],
        )?;
        let task = Self::task_row(&tx, &task_id)?.task();
        let dispatch = Self::dispatch_row(&tx, &dispatch_id)?;
        let worktree = asset_id
            .as_deref()
            .map(|id| Self::asset_row(&tx, id))
            .transpose()?;
        let outcome = WorkerStartOutcome {
            task,
            dispatch,
            session_id,
            worktree,
        };
        tx.execute(
            "UPDATE orch_worker_starts SET phase='running',result=?1,error=NULL,error_code=NULL,updated_at=?2 WHERE operation_id=?3",
            params![serde_json::to_string(&outcome)?, now(), operation_id],
        )?;
        Self::emit(
            &tx,
            "dispatch.updated",
            &dispatch_id,
            serde_json::to_value(&outcome.dispatch)?,
        )?;
        tx.commit()?;
        Ok(outcome)
    }

    pub fn fail_worker_start(
        &mut self,
        operation_id: &str,
        error_code: &str,
        message: &str,
    ) -> Result<WorkerStartOperation> {
        validate_id(operation_id)?;
        validate_id(error_code)?;
        validate_text(message, 8192, false)?;
        let tx = self.connection.transaction()?;
        let (phase, dispatch_id, asset_id): (String, Option<String>, Option<String>) = tx
            .query_row(
                "SELECT phase,dispatch_id,asset_id FROM orch_worker_starts WHERE operation_id=?1",
                [operation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        if matches!(phase.as_str(), "running" | "cancelled" | "delivery_unknown") {
            return tx
                .query_row(
                    "SELECT * FROM orch_worker_starts WHERE operation_id=?1",
                    [operation_id],
                    map_worker_start,
                )
                .map_err(Error::from);
        }
        let timestamp = now();
        if let Some(dispatch_id) = dispatch_id {
            tx.execute(
                "UPDATE orch_dispatches SET state='abandoned',outcome=?1,settled_at=?2 WHERE id=?3 AND state IN ('starting','running')",
                params![message, timestamp, dispatch_id],
            )?;
            tx.execute(
                "UPDATE orch_tasks SET status='failed',result=?1,updated_at=?2 WHERE id=(SELECT task_id FROM orch_dispatches WHERE id=?3) AND status='dispatched'",
                params![message, timestamp, dispatch_id],
            )?;
            Self::preserve_dispatch_assets_tx(&tx, &dispatch_id, Some(message))?;
        } else if let Some(asset_id) = asset_id {
            tx.execute(
                "UPDATE orch_worktree_assets SET state='preserved',last_error=?1,updated_at=?2 WHERE id=?3",
                params![message, timestamp, asset_id],
            )?;
        }
        let (next_phase, next_code) = if phase == "delivering" {
            ("delivery_unknown", "delivery_unknown")
        } else {
            ("failed", error_code)
        };
        tx.execute(
            "UPDATE orch_worker_starts SET phase=?1,error=?2,error_code=?3,updated_at=?4 WHERE operation_id=?5",
            params![next_phase, message, next_code, timestamp, operation_id],
        )?;
        let operation = tx.query_row(
            "SELECT * FROM orch_worker_starts WHERE operation_id=?1",
            [operation_id],
            map_worker_start,
        )?;
        tx.commit()?;
        Ok(operation)
    }

    pub fn cancel_queued_worker_start(
        &mut self,
        operation_id: &str,
    ) -> Result<WorkerStartOperation> {
        validate_id(operation_id)?;
        let changed = self.connection.execute(
            "UPDATE orch_worker_starts SET phase='cancelled',error='cancelled before admission',error_code='cancelled',updated_at=?1 WHERE operation_id=?2 AND phase='queued'",
            params![now(), operation_id],
        )?;
        if changed == 0 {
            let current = self.worker_start(operation_id)?;
            if !current.phase.terminal() {
                return Err(Error::Conflict);
            }
            return Ok(current);
        }
        self.worker_start(operation_id)
    }

    pub fn recover_worker_start_operations(&mut self) -> Result<()> {
        let planned_worktrees = {
            let mut statement = self.connection.prepare(
                "SELECT operation_id,run_id,task_id,worktree_repo,worktree_path,worktree_branch FROM orch_worker_starts WHERE phase='preparing' AND asset_id IS NULL AND worktree_path IS NOT NULL",
            )?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (operation_id, run_id, task_id, repo, path, branch) in planned_worktrees {
            if Path::new(&path).exists()
                && let (Some(repo), Some(branch)) = (repo, branch)
            {
                self.record_worker_start_worktree(
                    &operation_id,
                    RegisterWorktree {
                        kind: WorktreeAssetKind::Worker,
                        run_id,
                        task_id: Some(task_id),
                        repo,
                        path,
                        branch: Some(branch),
                    },
                )?;
            }
        }
        let session_ids = {
            let mut statement = self.connection.prepare(
                "SELECT DISTINCT session_id FROM orch_worker_starts WHERE session_id IS NOT NULL AND phase IN ('preparing','worktree_created','session_created','dispatch_committed','delivering','delivery_unknown')",
            )?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for session_id in session_ids {
            if self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM session_heads WHERE id=?1)",
                [&session_id],
                |row| row.get::<_, bool>(0),
            )? {
                self.archive_agent_session(&session_id, true)?;
            }
        }
        let tx = self.connection.transaction()?;
        let timestamp = now();
        tx.execute(
            "UPDATE orch_worker_starts SET phase='queued',updated_at=?1 WHERE phase='preparing' AND worktree_path IS NULL AND session_id IS NULL",
            [timestamp],
        )?;
        let reason =
            "worker start interrupted with an external side effect; delivery was not replayed";
        let mut interrupted = Vec::new();
        {
            let mut statement = tx.prepare(
                "SELECT operation_id,phase,dispatch_id,session_id,asset_id FROM orch_worker_starts WHERE phase IN ('preparing','worktree_created','session_created','dispatch_committed','delivering','delivery_unknown')",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?;
            for row in rows {
                interrupted.push(row?);
            }
        }
        for (operation_id, phase, dispatch_id, session_id, asset_id) in interrupted {
            if let Some(dispatch_id) = dispatch_id {
                tx.execute(
                    "UPDATE orch_dispatches SET state='abandoned',outcome=?1,settled_at=?2 WHERE id=?3 AND state IN ('starting','running')",
                    params![reason, timestamp, dispatch_id],
                )?;
                tx.execute(
                    "UPDATE orch_tasks SET status='failed',result=?1,updated_at=?2 WHERE id=(SELECT task_id FROM orch_dispatches WHERE id=?3) AND status='dispatched'",
                    params![reason, timestamp, dispatch_id],
                )?;
                Self::preserve_dispatch_assets_tx(&tx, &dispatch_id, Some(reason))?;
            } else if let Some(asset_id) = asset_id {
                tx.execute(
                    "UPDATE orch_worktree_assets SET state='preserved',last_error=?1,updated_at=?2 WHERE id=?3",
                    params![reason, timestamp, asset_id],
                )?;
            }
            let _ = session_id;
            let terminal = if matches!(
                phase.as_str(),
                "dispatch_committed" | "delivering" | "delivery_unknown"
            ) {
                "delivery_unknown"
            } else {
                "failed"
            };
            tx.execute(
                "UPDATE orch_worker_starts SET phase=?1,error=?2,error_code=?3,updated_at=?4 WHERE operation_id=?5",
                params![terminal, reason, if terminal == "delivery_unknown" { "delivery_unknown" } else { "recovery_interrupted" }, timestamp, operation_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Active session ids whose workspace is the path or inside it. The cleanup
    /// path refuses while a live worker may still be writing into the tree.
    pub fn active_sessions_under(&self, path: &str) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare(
            "SELECT id FROM session_heads WHERE lifecycle='active' \
             AND (workspace=?1 OR workspace LIKE ?2)",
        )?;
        let prefix = format!("{}/%", path.trim_end_matches('/'));
        let rows = statement.query_map(params![path, prefix], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The single dispatch entry point. The database enforces at most one live
    /// dispatch per task; readiness and the transition table are re-checked at
    /// this write boundary (ready is only derived, never trusted from the
    /// caller). `operation_id` makes a retried start return the same dispatch.
    pub fn dispatch_task(
        &mut self,
        task_id: &str,
        session_id: &str,
        operation_id: Option<&str>,
        worktree_path: Option<&str>,
    ) -> Result<SettleOutcome> {
        validate_id(task_id)?;
        validate_id(session_id)?;
        let operation_id = operation_id.map(str::to_owned);
        if let Some(operation_id) = &operation_id {
            validate_id(operation_id)?;
        }
        if let Some(path) = worktree_path {
            validate_text(path, 4096, false)?;
        }
        let guard_fingerprint = fingerprint(
            "worker.start",
            &serde_json::json!({"taskId": task_id, "sessionId": session_id, "worktreePath": worktree_path}),
        );
        let tx = self.connection.transaction()?;
        if let Some(operation_id) = &operation_id
            && let Idempotent::Replay(result) =
                operation_guard::<SettleOutcome>(&tx, operation_id, &guard_fingerprint)?
        {
            return Ok(result);
        }
        let task = Self::task_row(&tx, task_id)?;
        Self::require_active_run(&tx, &task.run_id)?;
        if Self::active_dispatch(&tx, task_id)?.is_some() {
            return Err(invalid(
                "the task already has a live worker; settle it first",
            ));
        }
        let unmet: i64 = tx.query_row(
            "SELECT count(*) FROM orch_task_deps d JOIN orch_tasks x ON x.id=d.dep_id \
             WHERE d.task_id=?1 AND x.status<>'done'",
            [task_id],
            |row| row.get(0),
        )?;
        if unmet > 0 {
            return Err(invalid("the task dependencies are not all done"));
        }
        if !can_transition(task.status, TaskStatus::Dispatched) {
            return Err(invalid(&format!(
                "task in state {} cannot be dispatched",
                task.status.label()
            )));
        }
        let now = now();
        let dispatch_id = new_id("disp");
        tx.execute(
            "INSERT INTO orch_dispatches(id,run_id,task_id,session_id,state,outcome,started_at,settled_at,worktree_path) \
             VALUES(?1,?2,?3,?4,'starting',NULL,?5,NULL,?6)",
            params![dispatch_id, task.run_id, task_id, session_id, now, worktree_path],
        )?;
        let task = Self::set_task_status(&tx, task_id, TaskStatus::Dispatched, None)?;
        let dispatch = Self::dispatch_row(&tx, &dispatch_id)?;
        Self::emit(
            &tx,
            "dispatch.updated",
            &dispatch.id,
            serde_json::to_value(&dispatch)?,
        )?;
        let outcome = SettleOutcome { task, dispatch };
        if let Some(operation_id) = &operation_id {
            Self::remember(&tx, operation_id, &guard_fingerprint, &outcome)?;
        }
        tx.commit()?;
        Ok(outcome)
    }

    fn dispatch_row(tx: &Transaction<'_>, dispatch_id: &str) -> Result<Dispatch> {
        tx.query_row(
            "SELECT * FROM orch_dispatches WHERE id=?",
            [dispatch_id],
            map_dispatch,
        )
        .optional()?
        .ok_or(Error::NotFound)
    }

    pub fn dispatch(&self, dispatch_id: &str) -> Result<Dispatch> {
        validate_id(dispatch_id)?;
        self.connection
            .query_row(
                "SELECT * FROM orch_dispatches WHERE id=?",
                [dispatch_id],
                map_dispatch,
            )
            .optional()?
            .ok_or(Error::NotFound)
    }

    pub fn latest_dispatch_for_task(&self, task_id: &str) -> Result<Option<Dispatch>> {
        validate_id(task_id)?;
        self.connection.query_row("SELECT * FROM orch_dispatches WHERE task_id=?1 ORDER BY started_at DESC,id DESC LIMIT 1", [task_id], map_dispatch).optional().map_err(Into::into)
    }

    pub fn list_dispatches(&self, run_id: Option<&str>) -> Result<Vec<Dispatch>> {
        let mut statement = self.connection.prepare(
            "SELECT * FROM orch_dispatches WHERE ?1 IS NULL OR run_id=?1 ORDER BY started_at,id",
        )?;
        let rows = statement.query_map([run_id], map_dispatch)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn set_dispatch_running(&mut self, dispatch_id: &str) -> Result<Dispatch> {
        validate_id(dispatch_id)?;
        let tx = self.connection.transaction()?;
        let dispatch = Self::dispatch_row(&tx, dispatch_id)?;
        if dispatch.state != DispatchState::Starting {
            return Err(invalid("dispatch is not starting"));
        }
        tx.execute(
            "UPDATE orch_dispatches SET state='running' WHERE id=?1 AND state='starting'",
            [dispatch_id],
        )?;
        let dispatch = Self::dispatch_row(&tx, dispatch_id)?;
        Self::emit(
            &tx,
            "dispatch.updated",
            dispatch_id,
            serde_json::to_value(&dispatch)?,
        )?;
        tx.commit()?;
        Ok(dispatch)
    }

    /// Worker's explicit delivery commit point. Task and dispatch settle in the
    /// same transaction so observers never see an intermediate split.
    pub fn settle_dispatch(
        &mut self,
        dispatch_id: &str,
        success: bool,
        outcome: &str,
    ) -> Result<SettleOutcome> {
        validate_id(dispatch_id)?;
        validate_text(outcome, 8192, false)?;
        let tx = self.connection.transaction()?;
        let dispatch = Self::dispatch_row(&tx, dispatch_id)?;
        if !dispatch.state.active() {
            return Err(invalid("the dispatch has already settled"));
        }
        let (task_status, dispatch_state) = if success {
            (TaskStatus::Done, DispatchState::Succeeded)
        } else {
            (TaskStatus::Failed, DispatchState::Failed)
        };
        let now = now();
        let task = Self::set_task_status(
            &tx,
            &dispatch.task_id,
            task_status,
            Some(Some(outcome.to_owned())),
        )?;
        tx.execute(
            "UPDATE orch_dispatches SET state=?1,outcome=?2,settled_at=?3 WHERE id=?4",
            params![dispatch_state.label(), outcome, now, dispatch_id],
        )?;
        Self::preserve_dispatch_assets_tx(
            &tx,
            dispatch_id,
            Some("worker 已交付；工作树默认保留，需显式检查或清理"),
        )?;
        let dispatch = Self::dispatch_row(&tx, dispatch_id)?;
        Self::emit(
            &tx,
            "dispatch.updated",
            dispatch_id,
            serde_json::to_value(&dispatch)?,
        )?;
        tx.commit()?;
        Ok(SettleOutcome { task, dispatch })
    }

    /// Settle a live dispatch whose worker is gone. An explicit done/failed
    /// delivery is preserved; otherwise the dispatch is abandoned and a still
    /// dispatched task converges to `final_status` (failed or cancelled).
    pub fn abandon_dispatch(
        &mut self,
        dispatch_id: &str,
        reason: &str,
        final_status: TaskStatus,
    ) -> Result<SettleOutcome> {
        validate_id(dispatch_id)?;
        validate_text(reason, 8192, false)?;
        if !matches!(final_status, TaskStatus::Failed | TaskStatus::Cancelled) {
            return Err(invalid("finalStatus must be failed or cancelled"));
        }
        let tx = self.connection.transaction()?;
        let dispatch = Self::dispatch_row(&tx, dispatch_id)?;
        if !dispatch.state.active() {
            return Err(invalid("the dispatch has already settled"));
        }
        let task = Self::task_row(&tx, &dispatch.task_id)?;
        let now = now();
        let (state, outcome_text, task_target) = match task.status {
            TaskStatus::Done => (
                DispatchState::Succeeded,
                task.result
                    .clone()
                    .unwrap_or_else(|| "worker delivered".into()),
                None,
            ),
            TaskStatus::Failed => (
                DispatchState::Failed,
                task.result.clone().unwrap_or_else(|| reason.to_owned()),
                None,
            ),
            TaskStatus::Cancelled => (DispatchState::Abandoned, reason.to_owned(), None),
            _ => (
                DispatchState::Abandoned,
                reason.to_owned(),
                Some(final_status),
            ),
        };
        if let Some(target) = task_target {
            Self::set_task_status(
                &tx,
                &dispatch.task_id,
                target,
                Some(Some(reason.to_owned())),
            )?;
        }
        tx.execute(
            "UPDATE orch_dispatches SET state=?1,outcome=?2,settled_at=?3 WHERE id=?4",
            params![state.label(), outcome_text, now, dispatch_id],
        )?;
        Self::preserve_dispatch_assets_tx(&tx, dispatch_id, Some(reason))?;
        let dispatch = Self::dispatch_row(&tx, dispatch_id)?;
        let task = Self::task_row(&tx, &dispatch.task_id)?.task();
        Self::emit(
            &tx,
            "dispatch.updated",
            dispatch_id,
            serde_json::to_value(&dispatch)?,
        )?;
        tx.commit()?;
        Ok(SettleOutcome { task, dispatch })
    }

    pub fn recover_dispatches(&mut self) -> Result<RecoveryReport> {
        self.recover_dispatches_for_session(None)
    }

    pub fn reconcile_dispatch_session(&mut self, session_id: &str) -> Result<RecoveryReport> {
        validate_id(session_id)?;
        self.recover_dispatches_for_session(Some(session_id))
    }

    fn recover_dispatches_for_session(
        &mut self,
        session_id: Option<&str>,
    ) -> Result<RecoveryReport> {
        let tx = self.connection.transaction()?;
        let mut candidates = Vec::new();
        {
            let mut statement = tx.prepare(
                "SELECT d.id,CASE \
                   WHEN h.id IS NULL THEN 'worker session is missing' \
                   WHEN h.lifecycle='archived' THEN 'worker session is archived' \
                   ELSE 'worker session is inactive' END \
                 FROM orch_dispatches d \
                 LEFT JOIN session_heads h ON h.id=d.session_id \
                 LEFT JOIN agent_runs a ON a.session_id=d.session_id \
                 WHERE d.state IN ('starting','running') \
                   AND (?1 IS NULL OR d.session_id=?1) \
                   AND (h.id IS NULL OR h.lifecycle='archived' OR ( \
                     json_extract(h.payload,'$.kind')='structured' AND (a.session_id IS NULL OR a.active=0) \
                   )) \
                 ORDER BY d.started_at,d.id",
            )?;
            let rows = statement.query_map([session_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                candidates.push(row?);
            }
        }
        let mut settled = Vec::new();
        for (id, reason) in candidates {
            let task = Self::task_row(&tx, &Self::dispatch_row(&tx, &id)?.task_id)?;
            let (state, outcome) = match task.status {
                TaskStatus::Done => (
                    DispatchState::Succeeded,
                    task.result
                        .clone()
                        .unwrap_or_else(|| "worker delivered".into()),
                ),
                TaskStatus::Failed => (
                    DispatchState::Failed,
                    task.result.clone().unwrap_or_else(|| reason.clone()),
                ),
                TaskStatus::Cancelled => (
                    DispatchState::Abandoned,
                    task.result.clone().unwrap_or_else(|| reason.clone()),
                ),
                _ => (DispatchState::Abandoned, reason.clone()),
            };
            let timestamp = now();
            tx.execute(
                "UPDATE orch_dispatches SET state=?1,outcome=?2,settled_at=?3 WHERE id=?4",
                params![state.label(), outcome, timestamp, id],
            )?;
            if task.status == TaskStatus::Dispatched {
                tx.execute(
                    "UPDATE orch_tasks SET status='failed',result=?1,updated_at=?2 WHERE id=?3",
                    params![reason, timestamp, task.id],
                )?;
                let updated = Self::task_row(&tx, &task.id)?.task();
                Self::emit(
                    &tx,
                    "task.updated",
                    &task.id,
                    serde_json::to_value(updated)?,
                )?;
            }
            Self::preserve_dispatch_assets_tx(&tx, &id, Some(&reason))?;
            let dispatch = Self::dispatch_row(&tx, &id)?;
            Self::emit(
                &tx,
                "dispatch.updated",
                &id,
                serde_json::to_value(&dispatch)?,
            )?;
            settled.push(dispatch);
        }
        tx.commit()?;
        Ok(RecoveryReport {
            settled,
            resumed: Vec::new(),
        })
    }

    fn pause_running_automation_tx(
        tx: &Transaction<'_>,
        run: &Run,
        timestamp: i64,
        error: Option<String>,
    ) -> Result<()> {
        let Some(mut automation) = run.automation.clone() else {
            return Ok(());
        };
        if automation.state != AutomationState::Running {
            return Ok(());
        }
        automation.state = AutomationState::Paused;
        automation.updated_at = timestamp;
        automation.last_error = error;
        tx.execute(
            "UPDATE orch_runs SET automation=?1,updated_at=?2 WHERE id=?3",
            params![serde_json::to_string(&automation)?, timestamp, run.id],
        )?;
        let run = Self::orch_run_from_tx(tx, &run.id)?;
        Self::emit(tx, "run.updated", &run.id, serde_json::to_value(&run)?)?;
        Ok(())
    }

    // ── Run lifecycle ────────────────────────────────────────────────────

    pub fn complete_run(&mut self, run_id: &str, allow_failed: bool) -> Result<Run> {
        validate_id(run_id)?;
        let tx = self.connection.transaction()?;
        let run = Self::orch_run_from_tx(&tx, run_id)?;
        if run.status == RunStatus::Completed {
            return Ok(run);
        }
        if run.status != RunStatus::Active {
            return Err(invalid("only active runs can be completed"));
        }
        if matches!(
            run.automation.as_ref().map(|a| a.state),
            Some(AutomationState::Running)
        ) {
            return Err(invalid(
                "automation is still running; pause it before completing the run",
            ));
        }
        let unfinished: i64 = tx.query_row(
            "SELECT count(*) FROM orch_tasks WHERE run_id=?1 AND ( \
               status='pending' OR status='dispatched' OR status='blocked' \
               OR (?2=0 AND status='failed') \
             )",
            params![run_id, i64::from(allow_failed)],
            |row| row.get(0),
        )?;
        if unfinished > 0 {
            return Err(invalid("the run still has unfinished tasks"));
        }
        let active: i64 = tx.query_row(
            "SELECT count(*) FROM orch_dispatches WHERE run_id=?1 AND state IN ('starting','running')",
            [run_id],
            |row| row.get(0),
        )?;
        if active > 0 {
            return Err(invalid("a worker is still running"));
        }
        let pending_gates: i64 = tx.query_row(
            "SELECT count(*) FROM orch_gates WHERE run_id=?1 AND status='pending'",
            [run_id],
            |row| row.get(0),
        )?;
        if pending_gates > 0 {
            return Err(invalid("a gate is still pending"));
        }
        let now = now();
        tx.execute(
            "UPDATE orch_runs SET status='completed',updated_at=?1 WHERE id=?2",
            params![now, run_id],
        )?;
        Self::preserve_run_assets_tx(&tx, run_id, "Run 已完成；工作树默认保留，需显式清理")?;
        let run = Self::orch_run_from_tx(&tx, run_id)?;
        Self::emit(&tx, "run.updated", &run.id, serde_json::to_value(&run)?)?;
        tx.commit()?;
        Ok(run)
    }

    pub fn complete_run_from_automation(&mut self, run_id: &str) -> Result<Run> {
        validate_id(run_id)?;
        let tx = self.connection.transaction()?;
        let run = Self::orch_run_from_tx(&tx, run_id)?;
        if run.status == RunStatus::Completed {
            return Ok(run);
        }
        if run.status != RunStatus::Active {
            return Err(invalid("only active runs can be completed"));
        }
        if !matches!(
            run.automation.as_ref().map(|a| a.state),
            Some(AutomationState::Running)
        ) {
            return Err(invalid("automation is not running"));
        }
        let unfinished: i64 = tx.query_row(
            "SELECT count(*) FROM orch_tasks WHERE run_id=?1 AND status<>'done'",
            [run_id],
            |row| row.get(0),
        )?;
        if unfinished > 0 {
            return Err(invalid("the run still has unfinished tasks"));
        }
        let active: i64 = tx.query_row(
            "SELECT count(*) FROM orch_dispatches WHERE run_id=?1 AND state IN ('starting','running')",
            [run_id],
            |row| row.get(0),
        )?;
        if active > 0 {
            return Err(invalid("a worker is still running"));
        }
        let pending_gates: i64 = tx.query_row(
            "SELECT count(*) FROM orch_gates WHERE run_id=?1 AND status='pending'",
            [run_id],
            |row| row.get(0),
        )?;
        if pending_gates > 0 {
            return Err(invalid("a gate is still pending"));
        }
        let now = now();
        let mut automation = run
            .automation
            .ok_or_else(|| invalid("automation is not running"))?;
        automation.state = AutomationState::Completed;
        automation.updated_at = now;
        automation.last_error = None;
        tx.execute(
            "UPDATE orch_runs SET status='completed',automation=?1,updated_at=?2 WHERE id=?3",
            params![serde_json::to_string(&automation)?, now, run_id],
        )?;
        Self::preserve_run_assets_tx(&tx, run_id, "Run 已完成；工作树默认保留，需显式清理")?;
        let run = Self::orch_run_from_tx(&tx, run_id)?;
        Self::emit(&tx, "run.updated", &run.id, serde_json::to_value(&run)?)?;
        tx.commit()?;
        Ok(run)
    }

    pub fn set_run_automation(
        &mut self,
        run_id: &str,
        automation: Option<RunAutomation>,
    ) -> Result<Run> {
        validate_id(run_id)?;
        if let Some(automation) = &automation {
            validate_text(&automation.approval_policy, 64, false)?;
            validate_text(&automation.cwd, 4096, false)?;
            validate_text(&automation.workspace_path, 4096, false)?;
            if let Some(account_id) = &automation.account_id {
                validate_id(account_id)?;
            }
            if let Some(branch) = &automation.branch {
                validate_text(branch, 256, false)?;
            }
        }
        let tx = self.connection.transaction()?;
        let run = Self::require_active_run(&tx, run_id)?;
        let raw = automation
            .map(|value| serde_json::to_string(&value))
            .transpose()?;
        let timestamp = now();
        tx.execute(
            "UPDATE orch_runs SET automation=?1,updated_at=?2 WHERE id=?3",
            params![raw, timestamp, run.id],
        )?;
        let run = Self::orch_run_from_tx(&tx, run_id)?;
        Self::emit(&tx, "run.updated", &run.id, serde_json::to_value(&run)?)?;
        tx.commit()?;
        Ok(run)
    }

    pub fn pause_automation_with_error(
        &mut self,
        run_id: &str,
        error: Option<String>,
    ) -> Result<Run> {
        validate_id(run_id)?;
        if let Some(error) = &error {
            validate_text(error, 4096, false)?;
        }
        let tx = self.connection.transaction()?;
        let run = Self::require_active_run(&tx, run_id)?;
        let mut automation = run
            .automation
            .clone()
            .ok_or_else(|| invalid("this run has no automation"))?;
        if automation.state == AutomationState::Completed {
            return Ok(run);
        }
        let timestamp = now();
        automation.state = AutomationState::Paused;
        automation.updated_at = timestamp;
        automation.last_error = error;
        tx.execute(
            "UPDATE orch_runs SET automation=?1,updated_at=?2 WHERE id=?3",
            params![serde_json::to_string(&automation)?, timestamp, run_id],
        )?;
        let run = Self::orch_run_from_tx(&tx, run_id)?;
        Self::emit(&tx, "run.updated", &run.id, serde_json::to_value(&run)?)?;
        tx.commit()?;
        Ok(run)
    }

    pub fn abandon_run(&mut self, run_id: &str, reason: &str) -> Result<Run> {
        validate_id(run_id)?;
        validate_text(reason, 8192, false)?;
        let tx = self.connection.transaction()?;
        let run = Self::orch_run_from_tx(&tx, run_id)?;
        if run.status == RunStatus::Abandoned {
            return Ok(run);
        }
        if run.status != RunStatus::Active {
            return Err(invalid("only active runs can be abandoned"));
        }
        let active: i64 = tx.query_row(
            "SELECT count(*) FROM orch_dispatches WHERE run_id=?1 AND state IN ('starting','running')",
            [run_id],
            |row| row.get(0),
        )?;
        if active > 0 {
            return Err(invalid("stop the workers before abandoning the run"));
        }
        let now = now();
        Self::pause_running_automation_tx(&tx, &run, now, None)?;
        tx.execute(
            "UPDATE orch_tasks SET status='cancelled',result=?1,updated_at=?2 \
             WHERE run_id=?3 AND status IN ('pending','blocked','dispatched')",
            params![reason, now, run_id],
        )?;
        tx.execute(
            "UPDATE orch_gates SET status='cancelled',resolved_at=?1 WHERE run_id=?2 AND status='pending'",
            params![now, run_id],
        )?;
        tx.execute(
            "UPDATE orch_runs SET status='abandoned',updated_at=?1 WHERE id=?2",
            params![now, run_id],
        )?;
        Self::preserve_run_assets_tx(&tx, run_id, "Run 已放弃；工作树默认保留，需显式清理")?;
        let run = Self::orch_run_from_tx(&tx, run_id)?;
        Self::emit(&tx, "run.updated", &run.id, serde_json::to_value(&run)?)?;
        tx.commit()?;
        Ok(run)
    }

    // ── Worktree assets (Stage 8) ────────────────────────────────────────

    /// Persist an external worktree directory immediately after `git worktree
    /// add` succeeds and *before* the worker session is created, so a crash in
    /// the narrow launch window can never orphan a directory.
    pub fn register_worktree_asset(&mut self, input: RegisterWorktree) -> Result<WorktreeAsset> {
        validate_id(&input.run_id)?;
        validate_text(&input.repo, 4096, false)?;
        validate_text(&input.path, 4096, false)?;
        if let Some(task_id) = &input.task_id {
            validate_id(task_id)?;
        }
        if let Some(branch) = &input.branch {
            validate_text(branch, 256, false)?;
        }
        // The run must exist; the task (for worker assets) must belong to it.
        let tx = self.connection.transaction()?;
        let _run = Self::orch_run_from_tx(&tx, &input.run_id)?;
        if let Some(task_id) = &input.task_id {
            let task = Self::task_row(&tx, task_id)?;
            if task.run_id != input.run_id {
                return Err(invalid("worktree task belongs to another run"));
            }
        }
        let now = now();
        let id = new_id("wt");
        tx.execute(
            "INSERT INTO orch_worktree_assets \
             (id,kind,run_id,task_id,dispatch_id,repo,path,branch,state,created_at,updated_at,run_deleted_at,last_inspection,cleanup,last_error) \
             VALUES(?1,?2,?3,?4,NULL,?5,?6,?7,'active',?8,?8,NULL,NULL,NULL,NULL)",
            params![
                id,
                asset_kind_label(input.kind),
                input.run_id,
                input.task_id,
                input.repo.trim(),
                input.path.trim(),
                input.branch,
                now
            ],
        )?;
        let asset = Self::asset_row(&tx, &id)?;
        Self::emit(
            &tx,
            "worktree_asset.updated",
            &id,
            serde_json::to_value(&asset)?,
        )?;
        tx.commit()?;
        Ok(asset)
    }

    pub fn worktree_asset(&self, asset_id: &str) -> Result<WorktreeAsset> {
        validate_id(asset_id)?;
        self.connection
            .query_row(
                "SELECT * FROM orch_worktree_assets WHERE id=?",
                [asset_id],
                map_asset,
            )
            .optional()?
            .ok_or(Error::NotFound)
    }

    pub fn list_worktree_assets(&self, run_id: Option<&str>) -> Result<Vec<WorktreeAsset>> {
        let mut statement = self.connection.prepare(
            "SELECT * FROM orch_worktree_assets WHERE ?1 IS NULL OR run_id=?1 \
             ORDER BY created_at DESC,id DESC",
        )?;
        let rows = statement.query_map([run_id], map_asset)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn link_worktree_dispatch(
        &mut self,
        asset_id: &str,
        dispatch_id: &str,
    ) -> Result<WorktreeAsset> {
        validate_id(asset_id)?;
        validate_id(dispatch_id)?;
        let tx = self.connection.transaction()?;
        let asset = Self::asset_row(&tx, asset_id)?;
        let dispatch = Self::dispatch_row(&tx, dispatch_id)?;
        if asset.kind != WorktreeAssetKind::Worker
            || asset.run_id != dispatch.run_id
            || asset.task_id.as_deref() != Some(dispatch.task_id.as_str())
        {
            return Err(invalid("worktree asset does not belong to the dispatch"));
        }
        tx.execute(
            "UPDATE orch_worktree_assets SET dispatch_id=?1,updated_at=?2 WHERE id=?3",
            params![dispatch_id, now(), asset_id],
        )?;
        let asset = Self::asset_row(&tx, asset_id)?;
        Self::emit(
            &tx,
            "worktree_asset.updated",
            asset_id,
            serde_json::to_value(&asset)?,
        )?;
        tx.commit()?;
        Ok(asset)
    }

    pub fn record_worktree_inspection(
        &mut self,
        asset_id: &str,
        inspection: &WorktreeInspection,
    ) -> Result<WorktreeAsset> {
        validate_id(asset_id)?;
        let tx = self.connection.transaction()?;
        let asset = Self::asset_row(&tx, asset_id)?;
        // A path that is still missing after an explicit cleanup is expected;
        // keep the `cleaned` state instead of reporting a user-caused loss.
        let state = if asset.cleanup.is_some() && inspection.state == WorktreeAssetState::Missing {
            WorktreeAssetState::Cleaned
        } else {
            inspection.state
        };
        let last_error = if state == WorktreeAssetState::Unknown {
            inspection.message.clone()
        } else {
            asset.last_error
        };
        tx.execute(
            "UPDATE orch_worktree_assets SET state=?1,last_inspection=?2,updated_at=?3,last_error=?4 WHERE id=?5",
            params![
                asset_state_label(state),
                serde_json::to_string(inspection)?,
                inspection.checked_at,
                last_error,
                asset_id
            ],
        )?;
        let asset = Self::asset_row(&tx, asset_id)?;
        Self::emit(
            &tx,
            "worktree_asset.updated",
            asset_id,
            serde_json::to_value(&asset)?,
        )?;
        tx.commit()?;
        Ok(asset)
    }

    pub fn mark_worktree_cleaned(
        &mut self,
        asset_id: &str,
        cleanup: &WorktreeCleanup,
    ) -> Result<WorktreeAsset> {
        validate_id(asset_id)?;
        let tx = self.connection.transaction()?;
        tx.execute(
            "UPDATE orch_worktree_assets SET state='cleaned',cleanup=?1,updated_at=?2,last_error=?3 WHERE id=?4",
            params![
                serde_json::to_string(cleanup)?,
                cleanup.removed_at,
                cleanup.warning,
                asset_id
            ],
        )?;
        let asset = Self::asset_row(&tx, asset_id)?;
        Self::emit(
            &tx,
            "worktree_asset.updated",
            asset_id,
            serde_json::to_value(&asset)?,
        )?;
        tx.commit()?;
        Ok(asset)
    }

    /// Mark an asset `preserved` (default lifetime outcome after a dispatch or
    /// run settles). Already-cleaned or missing assets are left untouched.
    pub fn preserve_worktree_asset(
        &mut self,
        asset_id: &str,
        reason: Option<&str>,
    ) -> Result<WorktreeAsset> {
        validate_id(asset_id)?;
        if let Some(reason) = reason {
            validate_text(reason, 8192, false)?;
        }
        let tx = self.connection.transaction()?;
        let asset = Self::asset_row(&tx, asset_id)?;
        if asset.cleanup.is_some() || asset.state == WorktreeAssetState::Missing {
            return Ok(asset);
        }
        tx.execute(
            "UPDATE orch_worktree_assets SET state='preserved',updated_at=?1,last_error=?2 WHERE id=?3",
            params![now(), reason, asset_id],
        )?;
        let asset = Self::asset_row(&tx, asset_id)?;
        Self::emit(
            &tx,
            "worktree_asset.updated",
            asset_id,
            serde_json::to_value(&asset)?,
        )?;
        tx.commit()?;
        Ok(asset)
    }

    pub fn preserve_worktrees_for_dispatch(
        &mut self,
        dispatch_id: &str,
        reason: Option<&str>,
    ) -> Result<()> {
        validate_id(dispatch_id)?;
        if let Some(reason) = reason {
            validate_text(reason, 8192, false)?;
        }
        let tx = self.connection.transaction()?;
        Self::preserve_dispatch_assets_tx(&tx, dispatch_id, reason)?;
        tx.commit()?;
        Ok(())
    }

    pub fn preserve_worktrees_for_run(&mut self, run_id: &str, reason: &str) -> Result<()> {
        validate_id(run_id)?;
        validate_text(reason, 8192, false)?;
        let tx = self.connection.transaction()?;
        Self::preserve_run_assets_tx(&tx, run_id, reason)?;
        tx.commit()?;
        Ok(())
    }

    fn asset_row(tx: &Transaction<'_>, asset_id: &str) -> Result<WorktreeAsset> {
        tx.query_row(
            "SELECT * FROM orch_worktree_assets WHERE id=?",
            [asset_id],
            map_asset,
        )
        .optional()?
        .ok_or(Error::NotFound)
    }

    /// Transaction-local version of the preserve transitions above; used by the
    /// dispatch/run state changes so the asset marking commits atomically with
    /// the settling state. Cleaned and missing assets are never revived.
    fn preserve_dispatch_assets_tx(
        tx: &Transaction<'_>,
        dispatch_id: &str,
        reason: Option<&str>,
    ) -> Result<()> {
        let stamp = now();
        let mut statement = tx.prepare(
            "UPDATE orch_worktree_assets SET state='preserved',updated_at=?1,last_error=?2 \
             WHERE dispatch_id=?3 AND cleanup IS NULL AND state<>'missing' RETURNING id",
        )?;
        let ids = statement
            .query_map(params![stamp, reason, dispatch_id], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for id in ids {
            let asset = Self::asset_row(tx, &id)?;
            Self::emit(
                tx,
                "worktree_asset.updated",
                &id,
                serde_json::to_value(&asset)?,
            )?;
        }
        Ok(())
    }

    fn preserve_run_assets_tx(tx: &Transaction<'_>, run_id: &str, reason: &str) -> Result<()> {
        let stamp = now();
        let mut statement = tx.prepare(
            "UPDATE orch_worktree_assets SET state='preserved',updated_at=?1,last_error=?2 \
             WHERE run_id=?3 AND cleanup IS NULL AND state<>'missing' RETURNING id",
        )?;
        let ids = statement
            .query_map(params![stamp, reason, run_id], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for id in ids {
            let asset = Self::asset_row(tx, &id)?;
            Self::emit(
                tx,
                "worktree_asset.updated",
                &id,
                serde_json::to_value(&asset)?,
            )?;
        }
        Ok(())
    }

    // ── Gates ────────────────────────────────────────────────────────────

    pub fn create_gate(&mut self, run_id: &str, input: CreateGate) -> Result<Gate> {
        validate_id(run_id)?;
        validate_text(&input.question, 4096, false)?;
        if input.options.len() > 20 || input.options.iter().any(|option| option.len() > 4096) {
            return Err(invalid("a gate may have at most 20 options"));
        }
        let tx = self.connection.transaction()?;
        Self::require_active_run(&tx, run_id)?;
        if let Some(task_id) = &input.task_id {
            let task = Self::task_row(&tx, task_id)?;
            if task.run_id != run_id {
                return Err(invalid("gate task belongs to another run"));
            }
        }
        let now = now();
        let id = new_id("gate");
        tx.execute(
            "INSERT INTO orch_gates(id,run_id,task_id,question,options,status,decision,created_at,resolved_at) \
             VALUES(?1,?2,?3,?4,?5,'pending',NULL,?6,NULL)",
            params![
                id,
                run_id,
                input.task_id,
                input.question,
                serde_json::to_string(&input.options)?,
                now
            ],
        )?;
        // A gate parks its task out of the dispatchable queue while waiting.
        if let Some(task_id) = &input.task_id {
            let task = Self::task_row(&tx, task_id)?;
            if task.status != TaskStatus::Blocked
                && can_transition(task.status, TaskStatus::Blocked)
            {
                Self::set_task_status(&tx, task_id, TaskStatus::Blocked, None)?;
            }
        }
        let gate = Self::gate_row(&tx, &id)?;
        Self::emit(&tx, "gate.updated", &id, serde_json::to_value(&gate)?)?;
        tx.commit()?;
        Ok(gate)
    }

    fn gate_row(tx: &Transaction<'_>, gate_id: &str) -> Result<Gate> {
        tx.query_row("SELECT * FROM orch_gates WHERE id=?", [gate_id], map_gate)
            .optional()?
            .ok_or(Error::NotFound)
    }

    pub fn list_gates(
        &self,
        run_id: Option<&str>,
        status: Option<GateStatus>,
    ) -> Result<Vec<Gate>> {
        let mut statement = self.connection.prepare(
            "SELECT * FROM orch_gates WHERE (?1 IS NULL OR run_id=?1) AND (?2 IS NULL OR status=?2) \
             ORDER BY created_at,id",
        )?;
        let rows = statement.query_map(params![run_id, status.map(value_label)], map_gate)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn resolve_gate(&mut self, gate_id: &str, decision: &str) -> Result<Gate> {
        validate_id(gate_id)?;
        validate_text(decision, 4096, false)?;
        let tx = self.connection.transaction()?;
        let gate = Self::gate_row(&tx, gate_id)?;
        Self::require_active_run(&tx, &gate.run_id)?;
        if gate.status != GateStatus::Pending {
            if gate.status == GateStatus::Resolved && gate.decision.as_deref() == Some(decision) {
                return Ok(gate);
            }
            return Err(invalid("the gate has already been settled"));
        }
        let now = now();
        tx.execute(
            "UPDATE orch_gates SET status='resolved',decision=?1,resolved_at=?2 WHERE id=?3",
            params![decision, now, gate_id],
        )?;
        // Resolve: a blocked task with no other pending gate re-enters the
        // queue — dispatched if its worker is still live, otherwise pending so
        // readiness/deps are re-evaluated before a new dispatch.
        if let Some(task_id) = &gate.task_id {
            let task = Self::task_row(&tx, task_id)?;
            let another: i64 = tx.query_row(
                "SELECT count(*) FROM orch_gates WHERE task_id=?1 AND status='pending' AND id<>?2",
                params![task_id, gate_id],
                |row| row.get(0),
            )?;
            if task.status == TaskStatus::Blocked && another == 0 {
                let target = if Self::active_dispatch(&tx, task_id)?.is_some() {
                    TaskStatus::Dispatched
                } else {
                    TaskStatus::Pending
                };
                if target == TaskStatus::Dispatched {
                    Self::force_task_status(&tx, task_id, target, None)?;
                } else {
                    Self::set_task_status(&tx, task_id, target, None)?;
                }
            }
        }
        let gate = Self::gate_row(&tx, gate_id)?;
        Self::emit(&tx, "gate.updated", gate_id, serde_json::to_value(&gate)?)?;
        tx.commit()?;
        Ok(gate)
    }

    // ── Collaboration messages ───────────────────────────────────────────

    pub fn post_message(&mut self, input: PostMessage) -> Result<OrchMessage> {
        validate_id(&input.run_id)?;
        validate_text(&input.from, 128, false)?;
        validate_text(&input.to, 128, false)?;
        validate_text(&input.subject, 1024, false)?;
        validate_text(&input.body, 8192, false)?;
        if let Some(thread) = &input.thread_id {
            validate_id(thread)?;
        }
        if let Some(task) = &input.task_id {
            validate_id(task)?;
        }
        // Run must exist (may be settled; reports on history are allowed).
        let _ = self.orch_run(&input.run_id)?;
        let now = now();
        let id = new_id("msg");
        self.connection.execute(
            "INSERT INTO orch_messages(id,run_id,sender,recipient,kind,subject,body,thread_id,task_id,created_at,read_at,answered_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,NULL)",
            params![
                id,
                input.run_id,
                input.from,
                input.to,
                message_kind(input.kind),
                input.subject,
                input.body,
                input.thread_id,
                input.task_id,
                now
            ],
        )?;
        Self::message_row(&self.connection, &id)
    }

    pub fn list_messages(&self, run_id: Option<&str>) -> Result<Vec<OrchMessage>> {
        let mut statement = self.connection.prepare(
            "SELECT * FROM orch_messages WHERE ?1 IS NULL OR run_id=?1 ORDER BY created_at,id",
        )?;
        let rows = statement.query_map([run_id], map_message)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn unread_messages(
        &self,
        recipient: &str,
        run_id: Option<&str>,
    ) -> Result<Vec<OrchMessage>> {
        validate_id(recipient)?;
        let mut statement = self.connection.prepare(
            "SELECT * FROM orch_messages WHERE recipient=?1 AND read_at IS NULL \
             AND (?2 IS NULL OR run_id=?2) ORDER BY created_at,id",
        )?;
        let rows = statement.query_map(params![recipient, run_id], map_message)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn mark_messages_read(&mut self, ids: &[String]) -> Result<()> {
        if ids.len() > 200 {
            return Err(invalid("mark at most 200 messages at once"));
        }
        let now = now();
        let tx = self.connection.transaction()?;
        for id in ids {
            validate_id(id)?;
            tx.execute(
                "UPDATE orch_messages SET read_at=?1 WHERE id=?2 AND read_at IS NULL",
                params![now, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn mark_message_answered(&mut self, message_id: &str) -> Result<OrchMessage> {
        validate_id(message_id)?;
        let tx = self.connection.transaction()?;
        tx.execute(
            "UPDATE orch_messages SET answered_at=?1 WHERE id=?2 AND answered_at IS NULL",
            params![now(), message_id],
        )?;
        let message = Self::message_row(&tx, message_id)?;
        tx.commit()?;
        Ok(message)
    }

    fn message_row(connection: &rusqlite::Connection, id: &str) -> Result<OrchMessage> {
        connection
            .query_row("SELECT * FROM orch_messages WHERE id=?", [id], map_message)
            .optional()?
            .ok_or(Error::NotFound)
    }

    // ── Idempotency ledger ───────────────────────────────────────────────

    fn remember<T: Serialize>(
        tx: &Transaction<'_>,
        id: &str,
        fingerprint: &str,
        result: &T,
    ) -> Result<()> {
        let json = serde_json::to_string(result)?;
        tx.execute(
            "INSERT INTO orch_operations(id,fingerprint,result,created_at) VALUES(?1,?2,?3,?4)",
            params![id, fingerprint, json, now()],
        )?;
        // The ledger only covers the offline retry window; keep the newest 1000.
        tx.execute(
            "DELETE FROM orch_operations WHERE id NOT IN ( \
               SELECT id FROM orch_operations ORDER BY created_at DESC,id DESC LIMIT ?1 \
             )",
            [OPERATIONS_RETENTION],
        )?;
        Ok(())
    }
}

fn value_label(status: GateStatus) -> &'static str {
    match status {
        GateStatus::Pending => "pending",
        GateStatus::Resolved => "resolved",
        GateStatus::Cancelled => "cancelled",
    }
}

fn asset_kind_label(kind: WorktreeAssetKind) -> &'static str {
    match kind {
        WorktreeAssetKind::Run => "run",
        WorktreeAssetKind::Worker => "worker",
    }
}

fn asset_state_label(state: WorktreeAssetState) -> &'static str {
    match state {
        WorktreeAssetState::Active => "active",
        WorktreeAssetState::Preserved => "preserved",
        WorktreeAssetState::Missing => "missing",
        WorktreeAssetState::Dirty => "dirty",
        WorktreeAssetState::Unmerged => "unmerged",
        WorktreeAssetState::Equivalent => "equivalent",
        WorktreeAssetState::SafeToClean => "safe_to_clean",
        WorktreeAssetState::Cleaned => "cleaned",
        WorktreeAssetState::Unknown => "unknown",
    }
}

fn message_kind(kind: MessageType) -> &'static str {
    match kind {
        MessageType::Note => "note",
        MessageType::Ask => "ask",
        MessageType::Reply => "reply",
        MessageType::Report => "report",
    }
}

fn map_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<OrchMessage> {
    let kind: String = row.get("kind")?;
    Ok(OrchMessage {
        id: row.get("id")?,
        run_id: row.get("run_id")?,
        from: row.get("sender")?,
        to: row.get("recipient")?,
        kind: match kind.as_str() {
            "ask" => MessageType::Ask,
            "reply" => MessageType::Reply,
            "report" => MessageType::Report,
            _ => MessageType::Note,
        },
        subject: row.get("subject")?,
        body: row.get("body")?,
        thread_id: row.get("thread_id")?,
        task_id: row.get("task_id")?,
        created_at: row.get("created_at")?,
        read_at: row.get("read_at")?,
        answered_at: row.get("answered_at")?,
    })
}
