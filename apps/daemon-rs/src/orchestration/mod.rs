//! DAG orchestration core (Stage 7).
//!
//! Ported from the legacy `apps/daemon/src/orchestration` model. The guiding
//! rule is unchanged: **stored state only moves through explicit transitions;
//! readiness is derived, never stored**. A task is ready when it is `pending`
//! and every dependency is `done` — a cancelled dependency deliberately does
//! not satisfy the edge, so a chain whose premise disappeared never silently
//! starts on a half-built foundation.

mod gitops;
mod store;
mod workers;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use gitops::{
    WorktreeCreate, create_worktree, inspect_asset, remove_worktree, repo_root,
    worktree_default_path,
};
pub use store::{RecoveryReport, SettleOutcome};
pub use workers::{cleanup_worktree, inspect_worktree, start_worker, stop_worker};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Active,
    Completed,
    Abandoned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Dispatched,
    Blocked,
    Done,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub fn label(self) -> &'static str {
        match self {
            TaskStatus::Pending => "pending",
            TaskStatus::Dispatched => "dispatched",
            TaskStatus::Blocked => "blocked",
            TaskStatus::Done => "done",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => TaskStatus::Pending,
            "dispatched" => TaskStatus::Dispatched,
            "blocked" => TaskStatus::Blocked,
            "done" => TaskStatus::Done,
            "failed" => TaskStatus::Failed,
            "cancelled" => TaskStatus::Cancelled,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DispatchState {
    Starting,
    Running,
    Succeeded,
    Failed,
    Abandoned,
}

impl DispatchState {
    fn label(self) -> &'static str {
        match self {
            DispatchState::Starting => "starting",
            DispatchState::Running => "running",
            DispatchState::Succeeded => "succeeded",
            DispatchState::Failed => "failed",
            DispatchState::Abandoned => "abandoned",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "starting" => DispatchState::Starting,
            "running" => DispatchState::Running,
            "succeeded" => DispatchState::Succeeded,
            "failed" => DispatchState::Failed,
            "abandoned" => DispatchState::Abandoned,
            _ => return None,
        })
    }

    pub fn active(self) -> bool {
        matches!(self, DispatchState::Starting | DispatchState::Running)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum GateStatus {
    Pending,
    Resolved,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    Note,
    Ask,
    Reply,
    Report,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub objective: String,
    pub status: RunStatus,
    pub coordinator_session_id: Option<String>,
    #[ts(type = "number")]
    pub graph_revision: i64,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub spec: String,
    pub skills: Vec<String>,
    pub deps: Vec<String>,
    pub parent_id: Option<String>,
    pub status: TaskStatus,
    pub result: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Dispatch {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub session_id: String,
    pub state: DispatchState,
    pub outcome: Option<String>,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number | null")]
    pub settled_at: Option<i64>,
    /// Working directory of the worker; for an isolated worker this is the
    /// registered worktree path.
    #[ts(type = "string | null")]
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeAssetKind {
    Run,
    Worker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeAssetState {
    Active,
    Preserved,
    Missing,
    Dirty,
    Unmerged,
    Equivalent,
    SafeToClean,
    Cleaned,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInspection {
    pub state: WorktreeAssetState,
    pub target_ref: String,
    #[ts(type = "number")]
    pub checked_at: i64,
    pub path_exists: bool,
    #[ts(type = "boolean | null")]
    pub registered: Option<bool>,
    #[ts(type = "boolean | null")]
    pub dirty: Option<bool>,
    #[ts(type = "string | null")]
    pub branch: Option<String>,
    #[ts(type = "number | null")]
    pub ahead_commit_count: Option<i64>,
    #[ts(type = "number | null")]
    pub equivalent_commit_count: Option<i64>,
    #[ts(type = "string | null")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCleanup {
    #[ts(type = "number")]
    pub removed_at: i64,
    pub branch_deleted: bool,
    #[ts(type = "string | null")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAsset {
    pub id: String,
    pub kind: WorktreeAssetKind,
    pub run_id: String,
    #[ts(type = "string | null")]
    pub task_id: Option<String>,
    #[ts(type = "string | null")]
    pub dispatch_id: Option<String>,
    pub repo: String,
    pub path: String,
    #[ts(type = "string | null")]
    pub branch: Option<String>,
    pub state: WorktreeAssetState,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[ts(type = "number | null")]
    pub run_deleted_at: Option<i64>,
    #[ts(type = "WorktreeInspection | null")]
    pub last_inspection: Option<WorktreeInspection>,
    #[ts(type = "WorktreeCleanup | null")]
    pub cleanup: Option<WorktreeCleanup>,
    #[ts(type = "string | null")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCleanupResult {
    pub asset: WorktreeAsset,
    pub inspection: WorktreeInspection,
    pub branch_deleted: bool,
    #[ts(type = "string | null")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub id: String,
    pub run_id: String,
    pub task_id: Option<String>,
    pub question: String,
    pub options: Vec<String>,
    pub status: GateStatus,
    pub decision: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number | null")]
    pub resolved_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchMessage {
    pub id: String,
    pub run_id: String,
    pub from: String,
    pub to: String,
    #[serde(rename = "type")]
    pub kind: MessageType,
    pub subject: String,
    pub body: String,
    pub thread_id: Option<String>,
    pub task_id: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number | null")]
    pub read_at: Option<i64>,
    #[ts(type = "number | null")]
    pub answered_at: Option<i64>,
}

/// Everything the canvas needs for one run; queries are scoped to a run rather
/// than shipping the graph of every run.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub run: Run,
    pub tasks: Vec<Task>,
    pub ready: Vec<String>,
    pub dispatches: Vec<Dispatch>,
    pub gates: Vec<Gate>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphNodeInput {
    pub client_id: String,
    pub title: String,
    pub spec: String,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub deps: Vec<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRunGraph {
    pub objective: String,
    #[serde(default)]
    pub nodes: Vec<GraphNodeInput>,
    #[serde(default)]
    pub coordinator_session_id: Option<String>,
    /// Required so a retried graph creation never makes two runs.
    pub operation_id: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyTaskGraph {
    pub run_id: String,
    #[ts(type = "number")]
    pub base_revision: i64,
    #[serde(default)]
    pub nodes: Vec<GraphNodeInput>,
    #[serde(default)]
    pub delete_task_ids: Vec<String>,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GraphMutationResult {
    pub run: Run,
    pub tasks: Vec<Task>,
    /// Maps submitted `clientId` to the durable task id.
    pub id_map: HashMap<String, String>,
    #[serde(default)]
    pub deleted_task_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRun {
    pub objective: String,
    #[serde(default)]
    pub coordinator_session_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTask {
    pub run_id: String,
    pub title: String,
    pub spec: String,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub deps: Vec<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteRun {
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunDeletionResult {
    pub run_id: String,
    #[ts(type = "number")]
    pub deleted_task_count: i64,
    #[ts(type = "number")]
    pub preserved_worktree_asset_ids: Vec<String>,
}

/// Desktop worker launch. `worktree` is `new` (isolated git worktree, matching
/// the legacy launcher) or `none` (run straight in the provided cwd).
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartWorker {
    pub task_id: String,
    /// Only structured Claude workers are bridged in Rust mode.
    pub cwd: String,
    #[serde(default = "default_worktree_mode")]
    pub worktree: String,
    #[serde(default)]
    pub operation_id: Option<String>,
}

fn default_worktree_mode() -> String {
    "new".into()
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopWorker {
    pub task_id: String,
    #[serde(default)]
    pub reason: Option<String>,
    /// `failed` (default) or `cancelled`.
    #[serde(default)]
    pub final_status: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectWorktree {
    #[serde(default)]
    pub target_ref: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupWorktree {
    #[serde(default)]
    pub target_ref: Option<String>,
    /// Explicit authorization; without it the directory is never removed.
    pub confirm: bool,
    #[serde(default)]
    pub delete_branch: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterWorktree {
    pub kind: WorktreeAssetKind,
    pub run_id: String,
    pub task_id: Option<String>,
    pub repo: String,
    pub path: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStartOutcome {
    pub task: Task,
    pub dispatch: Dispatch,
    pub session_id: String,
    #[ts(type = "WorktreeAsset | null")]
    pub worktree: Option<WorktreeAsset>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchTask {
    pub session_id: String,
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub worktree_path: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettleDispatch {
    pub success: bool,
    pub outcome: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AbandonDispatch {
    #[serde(default)]
    pub reason: Option<String>,
    /// `failed` (default) or `cancelled`; only used when the task is still
    /// dispatched.
    #[serde(default)]
    pub final_status: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompleteRun {
    #[serde(default)]
    pub allow_failed_tasks: bool,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AbandonRun {
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelTask {
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateGate {
    #[serde(default)]
    pub task_id: Option<String>,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveGate {
    pub decision: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PostMessage {
    pub run_id: String,
    pub from: String,
    pub to: String,
    #[serde(rename = "type")]
    pub kind: MessageType,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkMessages {
    pub ids: Vec<String>,
}

// ── State machine ────────────────────────────────────────────────────────

/// Explicit task transition table, ported verbatim from the legacy model.
fn allowed(from: TaskStatus) -> &'static [TaskStatus] {
    match from {
        // Dispatch, get parked behind a gate, or be cancelled before starting.
        TaskStatus::Pending => &[
            TaskStatus::Dispatched,
            TaskStatus::Blocked,
            TaskStatus::Cancelled,
        ],
        // Finished/failed; the worker may also disappear (back to pending),
        // park behind a gate, or be cancelled.
        TaskStatus::Dispatched => &[
            TaskStatus::Done,
            TaskStatus::Failed,
            TaskStatus::Blocked,
            TaskStatus::Pending,
            TaskStatus::Cancelled,
        ],
        // Gate resolved: re-queue as pending rather than jumping straight back
        // to dispatched; deps and workers may have changed while waiting.
        TaskStatus::Blocked => &[TaskStatus::Pending, TaskStatus::Cancelled],
        TaskStatus::Done => &[],
        // Failed tasks can be retried, or converged to cancelled by an
        // abandoned dispatch.
        TaskStatus::Failed => &[TaskStatus::Pending, TaskStatus::Cancelled],
        TaskStatus::Cancelled => &[],
    }
}

pub fn can_transition(from: TaskStatus, to: TaskStatus) -> bool {
    from == to || allowed(from).contains(&to)
}

/// Three-colour DFS cycle check. The coordinator is an LLM: it *will* emit
/// cycles, so reject the graph edit instead of leaving tasks that can never be
/// ready with no explanation.
pub fn find_cycle(tasks: &HashMap<String, Vec<String>>) -> Option<Vec<String>> {
    const WHITE: u8 = 0;
    const GRAY: u8 = 1;
    const BLACK: u8 = 2;
    let mut color: HashMap<&str, u8> = HashMap::new();
    let mut stack: Vec<&str> = Vec::new();

    fn visit<'a>(
        id: &'a str,
        tasks: &'a HashMap<String, Vec<String>>,
        color: &mut HashMap<&'a str, u8>,
        stack: &mut Vec<&'a str>,
    ) -> Option<Vec<String>> {
        let state = *color.get(id).unwrap_or(&WHITE);
        if state == BLACK {
            return None;
        }
        if state == GRAY {
            let start = stack.iter().position(|candidate| *candidate == id)?;
            let mut cycle: Vec<String> = stack[start..]
                .iter()
                .map(|value| value.to_string())
                .collect();
            cycle.push(id.to_owned());
            return Some(cycle);
        }
        color.insert(id, GRAY);
        stack.push(id);
        if let Some(deps) = tasks.get(id) {
            for dep in deps {
                if let Some(cycle) = visit(dep, tasks, color, stack) {
                    return Some(cycle);
                }
            }
        }
        stack.pop();
        color.insert(id, BLACK);
        None
    }

    for id in tasks.keys() {
        if let Some(cycle) = visit(id, tasks, &mut color, &mut stack) {
            return Some(cycle);
        }
    }
    None
}
