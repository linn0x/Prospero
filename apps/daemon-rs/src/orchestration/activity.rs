use std::collections::{HashMap, HashSet};

use rusqlite::{params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::*;
use crate::database::{Store, validate_id};
use crate::error::{Error, Result};
use crate::protocol::{SessionHead, SessionKind, SessionLifecycle, SessionStatus};

const MAX_ACTIVITY_TASKS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DurableSessionStatus {
    Active,
    Archived,
    Missing,
    NoSession,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DurableAgentState {
    pub active: bool,
    #[ts(type = "number")]
    pub turn: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivityDependency {
    pub task_id: String,
    pub status: TaskStatus,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskActivityQuery {
    pub task_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivity {
    pub task: Task,
    pub deps: Vec<TaskActivityDependency>,
    #[ts(type = "Dispatch | null")]
    pub dispatch: Option<Dispatch>,
    #[ts(type = "SessionHead | null")]
    pub session: Option<SessionHead>,
    #[ts(type = "DurableAgentState | null")]
    pub durable_state: Option<DurableAgentState>,
    pub task_status: TaskStatus,
    #[ts(type = "DispatchState | null")]
    pub dispatch_state: Option<DispatchState>,
    #[ts(type = "SessionStatus | null")]
    pub session_status: Option<SessionStatus>,
    pub durable_session_status: DurableSessionStatus,
    #[ts(type = "string | null")]
    pub turn_finish: Option<String>,
    #[ts(type = "string | null")]
    pub terminal_reason: Option<String>,
    #[ts(type = "string | null")]
    pub terminal_hint: Option<String>,
    #[ts(type = "number | null")]
    pub last_output_at: Option<i64>,
    #[ts(type = "number | null")]
    pub last_progress_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivities {
    pub activities: Vec<TaskActivity>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DispatchActivityHealth {
    #[ts(type = "number")]
    pub stale_dispatch_count: i64,
    #[ts(type = "number")]
    pub terminal_misalignment_count: i64,
}

struct ActivityDetails {
    dispatch: Option<Dispatch>,
    session: Option<SessionHead>,
    durable_state: Option<DurableAgentState>,
    turn_finish: Option<String>,
    last_output_at: Option<i64>,
    last_progress_at: Option<i64>,
}

impl Store {
    pub fn task_activities(
        &mut self,
        run_id: &str,
        query: TaskActivityQuery,
    ) -> Result<TaskActivities> {
        validate_id(run_id)?;
        if query.task_ids.is_empty() || query.task_ids.len() > MAX_ACTIVITY_TASKS {
            return Err(Error::Invalid(
                "taskIds must contain between 1 and 200 ids".into(),
            ));
        }
        let mut seen = HashSet::new();
        for id in &query.task_ids {
            validate_id(id)?;
            if !seen.insert(id.clone()) {
                return Err(Error::Invalid("taskIds must be unique".into()));
            }
        }
        self.orch_run(run_id)?;
        let tx = self.connection.transaction()?;
        let all_rows = Self::run_task_rows(&tx, run_id)?;
        let by_id = all_rows
            .iter()
            .enumerate()
            .map(|(index, row)| (row.id.clone(), index))
            .collect::<HashMap<_, _>>();
        let placeholders = (1..=query.task_ids.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(",");
        let mut owner_statement = tx.prepare(&format!(
            "SELECT id,run_id FROM orch_tasks WHERE id IN ({placeholders})"
        ))?;
        let owner_params = query
            .task_ids
            .iter()
            .cloned()
            .map(SqlValue::Text)
            .collect::<Vec<_>>();
        let owners = owner_statement
            .query_map(params_from_iter(owner_params.iter()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        drop(owner_statement);
        for id in &query.task_ids {
            match owners.get(id) {
                None => return Err(Error::NotFound),
                Some(owner) if owner != run_id => {
                    return Err(Error::Invalid("task belongs to another run".into()));
                }
                Some(_) => {}
            }
        }
        let sql = format!(
            "WITH ranked_dispatches AS ( \
               SELECT d.*,row_number() OVER (PARTITION BY d.task_id ORDER BY d.started_at DESC,d.id DESC) AS rank \
               FROM orch_dispatches d WHERE d.task_id IN ({placeholders}) \
             ) \
             SELECT d.id,d.run_id,d.task_id,d.session_id,d.state,d.outcome,d.started_at,d.settled_at,d.worktree_path, \
                    h.payload,a.active,a.turn,json_extract(e.body,'$.finish'),c.last_output_at,c.last_progress_at \
             FROM ranked_dispatches d \
             LEFT JOIN session_heads h ON h.id=d.session_id \
             LEFT JOIN agent_runs a ON a.session_id=d.session_id \
             LEFT JOIN timeline_records e ON e.session_id=d.session_id AND e.position=( \
               SELECT r.position FROM timeline_records r \
               WHERE r.session_id=d.session_id AND json_extract(r.body,'$.kind')='turn_end' \
               ORDER BY r.position DESC LIMIT 1 \
             ) \
             LEFT JOIN timeline_checkpoints c ON c.session_id=d.session_id \
             WHERE d.rank=1"
        );
        let mut details_statement = tx.prepare(&sql)?;
        let detail_params = query
            .task_ids
            .iter()
            .cloned()
            .map(SqlValue::Text)
            .collect::<Vec<_>>();
        let details = details_statement
            .query_map(params_from_iter(detail_params.iter()), |row| {
                let task_id: String = row.get(2)?;
                let state: String = row.get(4)?;
                let dispatch = Dispatch {
                    id: row.get(0)?,
                    run_id: row.get(1)?,
                    task_id: task_id.clone(),
                    session_id: row.get(3)?,
                    state: DispatchState::parse(&state).unwrap_or(DispatchState::Starting),
                    outcome: row.get(5)?,
                    started_at: row.get(6)?,
                    settled_at: row.get(7)?,
                    worktree_path: row.get(8)?,
                };
                let payload: Option<String> = row.get(9)?;
                let session = payload.and_then(|value| serde_json::from_str(&value).ok());
                let active: Option<i64> = row.get(10)?;
                let turn: Option<i64> = row.get(11)?;
                Ok((
                    task_id,
                    ActivityDetails {
                        dispatch: Some(dispatch),
                        session,
                        durable_state: active.zip(turn).map(|(active, turn)| DurableAgentState {
                            active: active != 0,
                            turn,
                        }),
                        turn_finish: row.get(12)?,
                        last_output_at: row.get(13)?,
                        last_progress_at: row.get(14)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        drop(details_statement);
        let statuses = all_rows
            .iter()
            .map(|row| (row.id.clone(), row.status))
            .collect::<HashMap<_, _>>();
        let mut activities = Vec::with_capacity(query.task_ids.len());
        for id in query.task_ids {
            let row = all_rows
                .get(*by_id.get(&id).ok_or(Error::NotFound)?)
                .ok_or(Error::NotFound)?;
            let deps = row
                .deps
                .iter()
                .filter_map(|task_id| {
                    statuses
                        .get(task_id)
                        .copied()
                        .map(|status| TaskActivityDependency {
                            task_id: task_id.clone(),
                            status,
                        })
                })
                .collect();
            let task = row.clone().task();
            let details = details.get(&id);
            let dispatch = details.and_then(|value| value.dispatch.clone());
            let session = details.and_then(|value| value.session.clone());
            let durable_state = details.and_then(|value| value.durable_state.clone());
            let durable_session_status = match (&dispatch, &session) {
                (None, _) => DurableSessionStatus::NoSession,
                (Some(_), None) => DurableSessionStatus::Missing,
                (Some(_), Some(session)) if session.lifecycle == SessionLifecycle::Archived => {
                    DurableSessionStatus::Archived
                }
                _ => DurableSessionStatus::Active,
            };
            let turn_finish = details.and_then(|value| value.turn_finish.clone());
            let terminal_reason = dispatch
                .as_ref()
                .filter(|value| !value.state.active())
                .and_then(|value| value.outcome.clone())
                .or_else(|| {
                    matches!(
                        task.status,
                        TaskStatus::Done | TaskStatus::Failed | TaskStatus::Cancelled
                    )
                    .then(|| task.result.clone())
                    .flatten()
                });
            let terminal_hint = dispatch.as_ref().and_then(|dispatch| {
                if !dispatch.state.active() {
                    return None;
                }
                match durable_session_status {
                    DurableSessionStatus::Missing => Some("worker session is missing".into()),
                    DurableSessionStatus::Archived => Some("worker session is archived".into()),
                    DurableSessionStatus::NoSession => Some("worker has no session".into()),
                    DurableSessionStatus::Active
                        if session
                            .as_ref()
                            .is_some_and(|session| session.kind == SessionKind::Structured)
                            && durable_state.as_ref().is_none_or(|state| !state.active) =>
                    {
                        Some("worker session is inactive".into())
                    }
                    DurableSessionStatus::Active
                        if session
                            .as_ref()
                            .is_some_and(|session| session.status == SessionStatus::Failed) =>
                    {
                        Some("latest worker turn failed; session remains active".into())
                    }
                    _ => None,
                }
            });
            activities.push(TaskActivity {
                task_status: task.status,
                dispatch_state: dispatch.as_ref().map(|value| value.state),
                session_status: session.as_ref().map(|value| value.status),
                durable_session_status,
                turn_finish,
                terminal_reason,
                terminal_hint,
                last_output_at: details.and_then(|value| value.last_output_at),
                last_progress_at: details.and_then(|value| value.last_progress_at),
                task,
                deps,
                dispatch,
                session,
                durable_state,
            });
        }
        tx.commit()?;
        Ok(TaskActivities { activities })
    }

    pub fn dispatch_activity_health(&self, stale_before: i64) -> Result<DispatchActivityHealth> {
        if stale_before < 0 {
            return Err(Error::Invalid("stale threshold is invalid".into()));
        }
        self.connection.query_row(
            "SELECT \
               coalesce(sum(coalesce(c.last_progress_at,d.started_at)<?1 AND NOT coalesce( \
                 h.lifecycle='active' AND json_extract(h.payload,'$.status')='idle' AND ( \
                   EXISTS (SELECT 1 FROM agent_message_queue q \
                     WHERE q.session_id=d.session_id AND q.created_at>=?1) OR \
                   EXISTS (SELECT 1 FROM cross_model_children child \
                     LEFT JOIN timeline_checkpoints child_progress ON child_progress.session_id=child.child_session_id \
                     WHERE child.parent_session_id=d.session_id AND child.summary_delivered=0 \
                       AND (child.updated_at>=?1 OR child_progress.last_progress_at>=?1)) OR \
                   EXISTS (SELECT 1 FROM cross_model_checks check_row \
                     WHERE check_row.parent_session_id=d.session_id \
                       AND check_row.state IN ('pending','claimed') \
                       AND coalesce(check_row.claimed_at,check_row.due_at)>=?1) \
                 ),0)),0), \
               coalesce(sum(h.id IS NULL OR h.lifecycle='archived' OR ( \
                 json_extract(h.payload,'$.kind')='structured' AND (a.session_id IS NULL OR a.active=0) \
               )),0) \
             FROM orch_dispatches d \
             LEFT JOIN session_heads h ON h.id=d.session_id \
             LEFT JOIN agent_runs a ON a.session_id=d.session_id \
             LEFT JOIN timeline_checkpoints c ON c.session_id=d.session_id \
             WHERE d.state IN ('starting','running')",
            [stale_before],
            |row| {
                Ok(DispatchActivityHealth {
                    stale_dispatch_count: row.get(0)?,
                    terminal_misalignment_count: row.get(1)?,
                })
            },
        ).map_err(Into::into)
    }

    pub fn stale_dispatch_count(&self, stale_before: i64) -> Result<i64> {
        Ok(self
            .dispatch_activity_health(stale_before)?
            .stale_dispatch_count)
    }

    pub fn terminal_misalignment_count(&self) -> Result<i64> {
        Ok(self
            .dispatch_activity_health(0)?
            .terminal_misalignment_count)
    }
}
